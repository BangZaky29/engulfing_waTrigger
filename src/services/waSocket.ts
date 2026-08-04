import { makeWASocket, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { supabase } from './supabaseClient';
import { useSupabaseAuthState } from './supabaseAuthState';
import { acquireLock, startLockHeartbeat } from './lockManager';
import { resolveWaVersion, invalidateVersionCache } from './versionResolver';
import { delay } from '../utils/helpers';
import { SESSION_ID, GROUP_JID, GROUP_SAR, EXECUTOR } from '../config/env';
// Import removed to prevent circular dependency
import { startAllCronJobs } from '../cron/cronManager';
import { processOutbox } from './outboxService';
import { sendStartupMessage } from '../handlers/systemHandler';
import { generateAndSendPDF } from './pdfReportService';
import { SESSION_START_TIME } from '../index';

export let sock: any = null;
export let waConnectionState = 'close';
export let clearAuthState: (() => Promise<void>) | null = null;
export let isFirstConnect = true;

const logger = pino({ level: 'silent' });
let listenersRegistered = false;
let lockAcquired = false;
let onSocketReadyCallback: (() => void) | null = null;

export function setOnSocketReady(cb: () => void) {
  onSocketReadyCallback = cb;
}

export let heartbeatInterval: any = null;
export const INSTANCE_ID = `bot-${process.pid}-${Math.random().toString(36).substring(2, 10)}`;

let globalAuthState: any = null;
let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 60000;
let cronStarted = false;

// Track consecutive 405 errors to prevent infinite loop
let consecutive405Count = 0;
const MAX_405_RETRIES = 5;

export function isWaReady() {
  return Boolean(sock && sock.user && waConnectionState === 'open');
}

export function resetListenersRegistered() {
  listenersRegistered = false;
}

export function resetIsFirstConnect() {
  isFirstConnect = true;
}

export function resetGlobalAuthState() {
  globalAuthState = null;
}

export async function syncWaStatus(status: string, qrCode: string | null) {
  try {
    const payload = {
      status,
      qr_code: qrCode,
      updated_at: new Date().toISOString()
    };

    const { error: err1 } = await supabase
      .from('whatsapp_sessions')
      .update(payload)
      .eq('id', SESSION_ID);

    if (err1) console.error('[STATUS] Gagal update whatsapp_sessions:', err1.message);

    const { error: err2 } = await supabase
      .from('whatsapp_public_status')
      .upsert({ id: SESSION_ID, ...payload }, { onConflict: 'id' });

    if (err2) {
      console.error('[STATUS] Gagal update whatsapp_public_status:', err2.message);
    } else {
      console.log(`[STATUS] ✅ Sync WA Status: ${status}`);
    }
  } catch (e: any) {
    console.error('[STATUS] Exception saat sync status:', e?.message || e);
  }
}

export async function connectToWhatsApp() {
  console.log('Starting WhatsApp Trigger Bot...');

  if (!lockAcquired) {
    console.log(`[LOCK] Mencoba mendapatkan lock untuk instance: ${INSTANCE_ID}`);
    for (let i = 0; i < 6; i++) {
      const acquired = await acquireLock(supabase, SESSION_ID, INSTANCE_ID);
      if (acquired) {
        lockAcquired = true;
        break;
      }
      console.log(`[LOCK] Lock sedang aktif. Mencoba lagi dalam 10 detik... (${i + 1}/6)`);
      await delay(10000);
    }

    if (!lockAcquired) {
      console.error('[LOCK] ❌ Gagal mendapatkan lock setelah beberapa percobaan.');
      process.exit(1);
    }

    heartbeatInterval = startLockHeartbeat(supabase, SESSION_ID, INSTANCE_ID);
  }

  if (!globalAuthState) {
    console.log('[AUTH] Inisialisasi auth state dari Supabase...');
    globalAuthState = await useSupabaseAuthState(supabase);
    console.log('[AUTH] ✅ Auth state berhasil diinisialisasi.');
  } else {
    console.log('[AUTH] Menggunakan auth state yang sudah ada (reconnect).');
  }

  clearAuthState = globalAuthState.clearState;

  // Resolve version dynamically from multiple sources
  const version = await resolveWaVersion();
  console.log(`[CONFIG] Using WhatsApp Web version: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: globalAuthState.state,
    logger,
    browser: Browsers.ubuntu('Chrome')
  });

  sock.ev.on('creds.update', globalAuthState.saveCreds);

  sock.ev.on('messages.upsert', async (m: any) => {
    if (m.type !== 'notify') return;
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const pushName = msg.pushName || '';
    
    const isExecutor = (EXECUTOR && sender.includes(EXECUTOR.replace('@s.whatsapp.net', ''))) 
      || pushName.toLowerCase() === 'bangzaky29' 
      || pushName.toLowerCase().includes('zaky')
      || sender.includes('9264932344023'); // Fallback LID BangZaky

    if (isExecutor && text.trim().toLowerCase().includes('report')) {
      if (!msg.key.remoteJid.includes('@g.us')) {
        console.log(`[WA_COMMAND] Menerima request REPORT via Private Message dari ${sender}`);
        await sock.sendMessage(msg.key.remoteJid, { text: '⏳ Sedang menyiapkan report PDF AI, mohon tunggu sebentar...' });
        try {
          generateAndSendPDF(sock, 'ON_DEMAND', msg.key.remoteJid, SESSION_START_TIME, new Date()).catch(e => {
            console.error('[SYSTEM] Error di PDF On-Demand Promise:', e);
          });
        } catch (e: any) {
          console.error('[SYSTEM] Gagal generate PDF on demand:', e);
        }
        return; // Stop processing so it doesn't fall into group logic
      }
    }

    // Hanya merespon di dalam GROUP_SAR
    if (GROUP_SAR && msg.key.remoteJid === GROUP_SAR) {
      console.log(`[WA_COMMAND] Group: ${msg.key.remoteJid} | Sender: ${sender} | PushName: ${pushName} | Text: ${text}`);

      if (isExecutor) {
        const command = text.trim().toLowerCase();
        
        if (command === 'aktifkan' || command === 'aktifkan sistem kembali') {
          await supabase.from('itr_command_state').upsert({ id: 'main_itr', status: 'ACTIVE' }, { onConflict: 'id' });
          await sock.sendMessage(GROUP_SAR, { text: '✅ Siap laksanakan Bos! Mesin ITR telah diaktifkan dan mulai mengeksekusi market.' });
        } else if (command === 'matikan bot') {
          await supabase.from('itr_command_state').upsert({ id: 'main_itr', status: 'PAUSED' }, { onConflict: 'id' });
          await sock.sendMessage(GROUP_SAR, { text: '🛑 Mesin ITR telah dimatikan. Bot standby menunggu perintah.' });
        } else if (command === 'info ai') {
          const helpText = `🤖 *DAFTAR PERINTAH ITR BOT* 🤖\n\n` +
            `▶️ *Aktifkan* - Memulai eksekusi market\n` +
            `⏸️ *Matikan Bot* - Menghentikan eksekusi market (standby)\n` +
            `💰 *Info Profit* - Mengecek laporan profit & loss sesi berjalan\n` +
            `ℹ️ *Info AI* - Menampilkan pesan panduan ini`;
          await sock.sendMessage(GROUP_SAR, { text: helpText });
        } else if (command === 'info profit') {
          // Memberi tahu Python engine untuk menghitung dan mengirim profit info
          await supabase.from('itr_command_state').update({ updated_by: 'REQUEST_PROFIT_INFO' }).eq('id', 'main_itr');
          await sock.sendMessage(GROUP_SAR, { text: '⏳ Sedang mengkalkulasi PnL sesi dari MT5, mohon tunggu sebentar...' });
        }
      }
    }
  });

  sock.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WA] QR Code received, syncing to Supabase for FE display...');
      await syncWaStatus('UNPAIRED', qr);
    }

    if (connection === 'close') {
      waConnectionState = 'close';
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        const errorData = (lastDisconnect?.error as any)?.data;
        const is405or428 = statusCode === 405 || statusCode === 428 || errorData?.reason === '405' || errorData?.reason === '428';

        if (is405or428) {
          consecutive405Count++;
          console.error(`[WA] ❌ Error ${statusCode || errorData?.reason} — version ditolak oleh WhatsApp. (${consecutive405Count}/${MAX_405_RETRIES})`);

          if (consecutive405Count >= MAX_405_RETRIES) {
            console.error('[WA] 🛑 Sudah gagal 405 sebanyak ' + MAX_405_RETRIES + 'x berturut-turut.');
            console.error('[WA] 🛑 Kemungkinan besar library Baileys perlu diupgrade ke v7.');
            console.error('[WA] 🛑 Bot berhenti untuk mencegah loop tanpa henti.');
            await syncWaStatus('ERROR_405', null);
            return; // Stop reconnecting
          }

          // Invalidate version cache & fetch fresh version on next connect
          invalidateVersionCache();
          const retryDelay = 10000; // Fixed 10s delay for 405 retries
          console.log(`[WA] Fetching fresh WA version dan reconnect dalam ${retryDelay / 1000} detik...`);
          setTimeout(connectToWhatsApp, retryDelay);
        } else {
          // Non-405 errors: normal exponential backoff
          consecutive405Count = 0; // Reset counter on non-405 error
          console.error('[WA] Connection closed. Status:', statusCode, 'Reason:', lastDisconnect?.error?.message || lastDisconnect?.error);
          console.log(`[WA] Reconnect dalam ${reconnectDelay / 1000} detik...`);
          setTimeout(connectToWhatsApp, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        }
      } else {
        console.log('[WA] Logged out. Clearing state dan reconnect untuk QR baru...');
        consecutive405Count = 0;
        if (clearAuthState) await clearAuthState();
        clearAuthState = null;
        globalAuthState = null;
        reconnectDelay = 5000;
        setTimeout(connectToWhatsApp, 5000);
      }

    } else if (connection === 'open') {
      console.log('[WA] ✅ Connection OPEN!');
      waConnectionState = 'open';
      reconnectDelay = 5000;
      consecutive405Count = 0; // Reset on successful connection
      await syncWaStatus('CONNECTED', null);
      await delay(3000);

      let waitCount = 0;
      while (!sock?.user && waitCount < 10) {
        await delay(1000);
        waitCount++;
      }

      if (!listenersRegistered) {
        listenersRegistered = true;
        if (onSocketReadyCallback) onSocketReadyCallback();
      }

      if (!cronStarted) {
        cronStarted = true;
        startAllCronJobs(sock, GROUP_JID);
      }

      processOutbox(sock, isWaReady, INSTANCE_ID);

      if (isFirstConnect && GROUP_JID) {
        isFirstConnect = false;
        // await sendStartupMessage(); // Disabled: System status is now sent by main.py & rcs_main.py
      }
    }
  });
}
