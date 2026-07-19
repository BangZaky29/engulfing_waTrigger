import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { supabase } from './supabaseClient';
import { useSupabaseAuthState } from './supabaseAuthState';
import { acquireLock, startLockHeartbeat } from './lockManager';
import { delay } from '../utils/helpers';
import { SESSION_ID, GROUP_JID } from '../config/env';
// Import removed to prevent circular dependency
import { startAllCronJobs } from '../cron/cronManager';
import { processOutbox } from './outboxService';
import { sendStartupMessage } from '../handlers/systemHandler';

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

  const { version } = await fetchLatestBaileysVersion();
  console.log(`[CONFIG] Baileys version = ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: globalAuthState.state,
    logger,
  });

  sock.ev.on('creds.update', globalAuthState.saveCreds);

  sock.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WA] QR Code received, updating Supabase...');
      await syncWaStatus('UNPAIRED', qr);
    }

    if (connection === 'close') {
      waConnectionState = 'close';
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`[WA] Reconnect dalam ${reconnectDelay / 1000} detik...`);
        setTimeout(connectToWhatsApp, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      } else {
        console.log('[WA] Logged out. Clearing state dan reconnect untuk QR baru...');
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
        await sendStartupMessage();
      }
    }
  });
}
