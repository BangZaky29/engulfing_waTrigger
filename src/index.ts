import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import pino from 'pino';
import path from 'path';
import { useSupabaseAuthState } from './supabaseAuthState';
import { startCronJobs } from './cronScheduler';
import { generateAndSendPDF } from './pdfService';

import { resolve } from 'path';
import { fileURLToPath } from 'url';

import fs from 'fs';

dotenv.config({ path: resolve(__dirname, '../.env') }); // load local .env

// Load Python bot .env secara dinamis
const pythonEnvPath = process.env.ENGULFING_ENV_PATH || resolve(__dirname, '../../../engulfing/.env');
if (fs.existsSync(pythonEnvPath)) {
  dotenv.config({ path: pythonEnvPath });
} else {
  console.warn(`\n[WARNING] Python .env tidak ditemukan di jalur: ${pythonEnvPath}`);
  console.warn(`[WARNING] Jika berjalan di Live Server, pastikan variabel konfigurasi (seperti MT5_SYMBOL, dll) sudah di-set langsung di Environment Variables OS/Server Anda.\n`);
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!;
const GROUP_JID = process.env.GROUP_JID!;
const SESSION_ID = 'main_session';

// ✅ Catat TEPAT saat sistem pertama kali dijalankan
const SESSION_START_TIME = new Date();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  }
});
const logger = pino({ level: 'silent' });

let sock: any = null;
let isFirstConnect = true;       // flag startup notif hanya sekali
let listenersRegistered = false; // flag agar listener Supabase tidak dobel saat reconnect
let clearAuthState: (() => Promise<void>) | null = null; // expose clearState ke module scope

let lockAcquired = false;
let heartbeatInterval: any = null;
const INSTANCE_ID = `bot-${process.pid}-${Math.random().toString(36).substring(2, 10)}`;

// =====================================================
// Helper: delay
// =====================================================
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// =====================================================
// Outbox & Connection State Variables
// =====================================================
let outboxRunning = false;
let waConnectionState = 'close';
let cronStarted = false;

// =====================================================
// Helper: Outbox Queue
// =====================================================
async function enqueueWaMessage(input: {
  sourceTable: string;
  sourceId?: number;
  ticketId?: number;
  eventType: string;
  groupJid: string;
  messageType: 'TEXT' | 'IMAGE' | 'DOCUMENT';
  message: string;
  imageUrl?: string | null;
  payload?: any;
}) {
  const dedupeKey = [
    input.sourceTable,
    input.ticketId ?? input.sourceId ?? 'noid',
    input.eventType,
    input.messageType,
  ].join(':');

  console.log(`[OUTBOX] Enqueuing message for dedupe key: ${dedupeKey}`);

  const { error } = await supabase
    .from('wa_outbox')
    .upsert(
      {
        source_table: input.sourceTable,
        source_id: input.sourceId ?? null,
        ticket_id: input.ticketId ?? null,
        event_type: input.eventType,
        group_jid: input.groupJid,
        message_type: input.messageType,
        message: input.message,
        image_url: input.imageUrl ?? null,
        payload: input.payload ?? {},
        status: 'PENDING',
        next_retry_at: new Date().toISOString(),
        dedupe_key: dedupeKey,
      },
      {
        onConflict: 'dedupe_key',
        ignoreDuplicates: true,
      }
    );

  if (error) {
    console.error('[OUTBOX] Gagal enqueue WA message:', error.message);
  } else {
    console.log('[OUTBOX] ✅ Message enqueued.');
  }
}

function isWaReady() {
  return Boolean(sock && sock.user && waConnectionState === 'open');
}

async function processOutbox() {
  if (outboxRunning) return;
  if (!isWaReady()) return;

  outboxRunning = true;

  try {
    const { data: jobs, error } = await supabase
      .from('wa_outbox')
      .select('*')
      .eq('status', 'PENDING')
      .lte('next_retry_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(5);

    if (error) {
      console.error('[OUTBOX] Gagal ambil jobs:', error.message);
      return;
    }

    if (jobs && jobs.length > 0) {
      console.log(`[OUTBOX] Processing ${jobs.length} pending jobs...`);
      for (const job of jobs) {
        await sendOutboxJob(job);
      }
    }
  } catch (err: any) {
    console.error('[OUTBOX] Exception in processOutbox:', err?.message || err);
  } finally {
    outboxRunning = false;
  }
}

async function sendOutboxJob(job: any) {
  const instanceId = INSTANCE_ID;

  // Lock job first
  const { error: lockError } = await supabase
    .from('wa_outbox')
    .update({
      status: 'SENDING',
      locked_by: instanceId,
      locked_at: new Date().toISOString(),
      attempts: job.attempts + 1,
    })
    .eq('id', job.id)
    .eq('status', 'PENDING');

  if (lockError) {
    console.error(`[OUTBOX] Gagal lock job ${job.id}:`, lockError.message);
    return;
  }

  try {
    if (!isWaReady()) {
      throw new Error('WA socket not ready during execution');
    }

    let result;

    if (job.message_type === 'IMAGE' && job.image_url) {
      console.log(`[OUTBOX] Sending image message to ${job.group_jid} for key: ${job.dedupe_key}`);
      result = await sock.sendMessage(job.group_jid, {
        image: { url: job.image_url },
        caption: job.message,
      });
    } else {
      console.log(`[OUTBOX] Sending text message to ${job.group_jid} for key: ${job.dedupe_key}`);
      result = await sock.sendMessage(job.group_jid, {
        text: job.message,
      });
    }

    await supabase
      .from('wa_outbox')
      .update({
        status: 'SENT',
        sent_at: new Date().toISOString(),
        wa_message_id: result?.key?.id ?? null,
        last_error: null,
        locked_by: null,
        locked_at: null,
      })
      .eq('id', job.id);

    console.log(`[OUTBOX] ✅ Sent: ${job.dedupe_key}`);
  } catch (err: any) {
    const message = String(err?.message ?? err);
    console.error(`[OUTBOX] ❌ Failed to send ${job.dedupe_key}:`, message);

    const nextAttempts = job.attempts + 1;
    const isFinal = nextAttempts >= job.max_attempts;
    const retryDelayMs = Math.min(5 * 60_000, 15_000 * nextAttempts);

    await supabase
      .from('wa_outbox')
      .update({
        status: isFinal ? 'FAILED' : 'PENDING',
        last_error: message,
        next_retry_at: new Date(Date.now() + retryDelayMs).toISOString(),
        locked_by: null,
        locked_at: null,
      })
      .eq('id', job.id);
  }
  // =====================================================
  // Helper: Sync WA Status to public & internal tables
  // =====================================================
  async function syncWaStatus(status: string, qrCode: string | null) {
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

      if (err1) {
        console.error('[STATUS] Gagal update whatsapp_sessions:', err1.message);
      }

      const { error: err2 } = await supabase
        .from('whatsapp_public_status')
        .upsert({
          id: SESSION_ID,
          ...payload
        }, { onConflict: 'id' });

      if (err2) {
        console.error('[STATUS] Gagal update whatsapp_public_status:', err2.message);
      } else {
        console.log(`[STATUS] ✅ Sync WA Status: ${status}`);
      }
    } catch (e: any) {
      console.error('[STATUS] Exception saat sync status:', e?.message || e);
    }
  }

  // =====================================================
  // Supabase Realtime Listeners
  // HARUS dipanggil setelah sock siap (di dalam connection === 'open')
  // =====================================================
  function setupSupabaseListeners() {
    if (listenersRegistered) {
      console.log('[LISTENER] Supabase listeners sudah terdaftar, skip.');
      return;
    }
    listenersRegistered = true;
    console.log('[LISTENER] Mendaftarkan Supabase Realtime listeners...');

    // Listen for LOGOUT_REQUESTED from frontend
    supabase
      .channel('whatsapp_public_status_changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'whatsapp_public_status', filter: 'id=eq.main_session' },
        async (payload) => {
          if (payload.new.status === 'LOGOUT_REQUESTED') {
            console.log('[LOGOUT] Logout requested by Frontend! Membersihkan session...');

            // 1. Hapus session_data dari Supabase DULU (ini yang penting)
            try {
              if (clearAuthState) {
                await clearAuthState();
                console.log('[LOGOUT] ✅ session_data berhasil dihapus dari Supabase.');
              } else {
                // Fallback: langsung hapus via supabase client
                await supabase
                  .from('whatsapp_auth_keys')
                  .delete()
                  .eq('session_id', 'main_session');
                await supabase
                  .from('whatsapp_sessions')
                  .update({ status: 'UNPAIRED', qr_code: null })
                  .eq('id', 'main_session');
                await supabase
                  .from('whatsapp_public_status')
                  .update({ status: 'UNPAIRED', qr_code: null })
                  .eq('id', 'main_session');
                console.log('[LOGOUT] ✅ session_data dihapus via fallback.');
              }
            } catch (e) {
              console.error('[LOGOUT] Gagal hapus session_data:', e);
            }

            // 2. Disconnect socket dari WhatsApp
            if (sock) {
              try {
                await sock.logout();
                console.log('[LOGOUT] ✅ Socket berhasil logout dari WhatsApp.');
              } catch (e) {
                console.warn('[LOGOUT] sock.logout() error (mungkin sudah disconnect):', e);
              }
            }

            // 3. Reset flag agar startup notif muncul lagi saat reconnect
            isFirstConnect = true;
            listenersRegistered = false;
            console.log('[LOGOUT] Session bersih. Bot akan request QR code baru...');
          }
        }
      )
      .subscribe((status: string) => {
        console.log(`[LISTENER] whatsapp_public_status_changes subscription status: ${status}`);
      });

    // Listen to Supabase Realtime for new trades (hasil close)
    supabase
      .channel('trade_analytics_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trade_analytics' },
        async (payload) => {
          const trade = payload.new;
          console.log(`New trade detected! Ticket: ${trade.ticket_id}`);

          try {
            const modeEmoji = trade.mode?.toUpperCase() === 'BUY' ? '🟢' : '🔴';
            const resultEmoji = trade.result?.toUpperCase() === 'PROFIT' ? '🎉' : '💀';
            const sessionStr = trade.trading_session ? `\n🔸 *Sesi:* ${trade.trading_session}` : '';

            const caption = `📈 *ENGULFING SIGNAL* 📉\n\n*${modeEmoji} ${trade.mode} ${trade.result}* ${resultEmoji}\n🔸 *Pair:* ${trade.symbol}\n🔸 *Timeframe:* ${trade.timeframe}${sessionStr}\n\n💰 *Profit:* $${trade.profit ? trade.profit.toFixed(2) : '0.00'}\n🎫 *Ticket:* ${trade.ticket_id}`;

            await enqueueWaMessage({
              sourceTable: 'trade_analytics',
              sourceId: trade.id,
              ticketId: trade.ticket_id,
              eventType: 'TRADE_CLOSED',
              groupJid: GROUP_JID,
              messageType: trade.image_url ? 'IMAGE' : 'TEXT',
              message: caption,
              imageUrl: trade.image_url,
              payload: trade,
            });
          } catch (error) {
            console.error('Error handling trade message:', error);
          }
        }
      )
      .subscribe((status: string) => {
        console.log(`[LISTENER] trade_analytics_changes subscription status: ${status}`);
        if (status === 'CHANNEL_ERROR') {
          console.error('[LISTENER] ❌ Gagal subscribe ke trade_analytics! Pastikan table ini terdaftar di PUBLICATION supabase_realtime.');
        }
      });

    // Listen to Supabase Realtime for LIMIT ORDER TERSENTUH (Active logs)
    supabase
      .channel('trade_active_logs_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trade_active_logs' },
        async (payload) => {
          const log = payload.new;
          console.log(`New active log detected! Ticket: ${log.ticket_id}`);

          try {
            const modeEmoji = log.mode?.toUpperCase() === 'BUY' ? '🟢' : '🔴';
            const sessionStr = log.trading_session ? `\n🔸 *Sesi:* ${log.trading_session}` : '';

            let title = '🎯 *PENDING ORDER TERSENTUH* 🎯';
            let defaultMsg = `🔥 LIMIT ORDER TERSENTUH! Posisi ${log.mode} aktif sekarang.`;

            if (log.message.includes('EXPIRED')) {
              title = '⏳ *PENDING ORDER KADALUWARSA (EXPIRED)* ⏳';
              defaultMsg = `⏱️ LIMIT ORDER EXPIRED! Batas waktu terlewati tanpa tersentuh.`;
            } else if (log.message.includes('OVERRIDDEN') || log.message.includes('DIBATALKAN')) {
              title = '🧹 *PENDING ORDER DIBATALKAN (OVERRIDE)* 🧹';
              defaultMsg = `🗑️ LIMIT ORDER OVERRIDDEN! Dibatalkan karena ada trigger baru yang aktif.`;
            }

            const caption = `${title}\n\n` +
              `${log.message || defaultMsg}\n\n` +
              `🔸 *Pair:* ${log.symbol}\n` +
              `🔸 *Entry:* ${log.op_price ? log.op_price.toFixed(5) : '-'}\n` +
              `🔸 *SL:* ${log.sl_price ? log.sl_price.toFixed(5) : '-'}\n` +
              `🔸 *TP:* ${log.tp_price ? log.tp_price.toFixed(5) : '-'}` +
              `${sessionStr}\n\n` +
              `🎫 *Ticket:* ${log.ticket_id}`;

            await enqueueWaMessage({
              sourceTable: 'trade_active_logs',
              sourceId: log.id,
              ticketId: log.ticket_id,
              eventType: 'TRADE_ACTIVE',
              groupJid: GROUP_JID,
              messageType: log.image_url ? 'IMAGE' : 'TEXT',
              message: caption,
              imageUrl: log.image_url,
              payload: log,
            });
          } catch (error) {
            console.error('Error handling active log message:', error);
          }
        }
      )
      .subscribe((status: string) => {
        console.log(`[LISTENER] trade_active_logs_changes subscription status: ${status}`);
        if (status === 'CHANNEL_ERROR') {
          console.error('[LISTENER] ❌ Gagal subscribe ke trade_active_logs! Pastikan table ini terdaftar di PUBLICATION supabase_realtime.');
        }
      });

    // Listen to Supabase Realtime for NEW SIGNALS (Open Position)
    supabase
      .channel('engulfing_signals_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'engulfing_signals', filter: 'is_confirmed=eq.true' },
        async (payload) => {
          const signal = payload.new;
          console.log(`New OP signal detected! Symbol: ${signal.symbol}`);

          try {
            const isBuy = signal.pattern_type === 'bullish_engulfing';
            const mode = isBuy ? 'BUY' : 'SELL';
            const modeEmoji = isBuy ? '🟢' : '🔴';

            const opPrice = signal.curr_close.toFixed(2);
            const slPrice = isBuy ? signal.curr_low.toFixed(2) : signal.curr_high.toFixed(2);

            let caption = '';

            if (signal.notes) {
              try {
                const notesObj = JSON.parse(signal.notes);

                const actionStr = notesObj.action_str || mode;
                const grade = notesObj.grade || '-';
                const bPct = notesObj.body_pct || 0;
                const cpPct = notesObj.cp_pct || 0;
                const rr = notesObj.rr_ratio || 1.5;
                const slPriceNotes = notesObj.sl_price || slPrice;
                const slPctUsed = notesObj.sl_pct_used !== undefined ? notesObj.sl_pct_used : (process.env.EXECUTION_SL_PCT || '75');
                const ticketId = notesObj.ticket_id || '-';

                const summaryText = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${actionStr} | Grade : ${grade} | B : ${bPct}% | CP : ${cpPct}% | RR : ${rr} | SL : ${slPctUsed}%`;
                const breakdownText = notesObj.score_breakdown ? `\n\n📈 *Score Breakdown:*\n${notesObj.score_breakdown}` : '';

                caption =
                  `⚠️ *NEW OPEN POSITION* ⚠️\n\n` +
                  `*${modeEmoji} ${mode} SIGNAL OP*\n` +
                  `🔸 *Pair:* ${signal.symbol}\n` +
                  `🔸 *Timeframe:* ${signal.timeframe}\n` +
                  `🔸 *Sesi:* ${signal.trading_session || '-'}\n\n` +
                  `🎯 *Entry:* ${opPrice}\n` +
                  `🛡️ *SL Area:* ${slPriceNotes} (${slPctUsed}%)\n` +
                  `🎯 *Target RR:* ${rr}\n` +
                  `🎫 *Ticket:* ${ticketId}\n\n` +
                  `📊 *SUMMARY DATA:*\n` +
                  `${summaryText}` +
                  `${breakdownText}`;

              } catch (e) {
                console.log('Notes is not JSON or failed to parse, falling back to basic format.');
                caption = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${mode} | ${opPrice} | Sesi: ${signal.trading_session || '-'}`;
              }
            } else {
              caption = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${mode} | ${opPrice} | Sesi: ${signal.trading_session || '-'}`;
            }

            await enqueueWaMessage({
              sourceTable: 'engulfing_signals',
              sourceId: signal.id,
              ticketId: signal.ticket_id || null,
              eventType: 'TRADE_SIGNAL',
              groupJid: GROUP_JID,
              messageType: 'TEXT',
              message: caption,
              payload: signal,
            });
          } catch (error) {
            console.error('Error handling OP message:', error);
          }
        }
      )
      .subscribe((status: string) => {
        console.log(`[LISTENER] engulfing_signals_changes subscription status: ${status}`);
        if (status === 'CHANNEL_ERROR') {
          console.error('[LISTENER] ❌ Gagal subscribe ke engulfing_signals! Pastikan table ini terdaftar di PUBLICATION supabase_realtime.');
        }
      });

    console.log('[LISTENER] ✅ Semua Supabase Realtime listeners diinisialisasi.');

  }

  // =====================================================
  // WhatsApp Connection
  // =====================================================

  // Fungsi terpisah untuk kirim startup message dengan retry
  async function sendStartupMessage(retryCount = 0): Promise<void> {
    const MAX_RETRY = 5;
    const RETRY_DELAY = 3000; // 3 detik per retry

    if (!sock || !GROUP_JID) {
      console.log(`[STARTUP] sock atau GROUP_JID belum siap, skip.`);
      return;
    }

    try {
      const now = new Date();
      const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const tgl = now.toLocaleDateString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

      const pairInfo = (process.env.MT5_SYMBOL || 'Unknown').split('#')[0].trim();
      const tfInfo = (process.env.STRATEGY_TIMEFRAME || 'Unknown').split('#')[0].trim();
      const minGradeInfo = (process.env.MIN_GRADE_ALLOWED || 'C+').split('#')[0].trim();
      const rrInfo = (process.env.EXECUTION_TP_RR_RATIO || '1.5').split('#')[0].trim();
      const slPctInfo = (process.env.EXECUTION_SL_PCT || '80').split('#')[0].trim();

      const startupMsg =
        `🟢 *SISTEM AKTIF* 🟢\n\n` +
        `🤖 *Engulfing Analytics Bot* telah berhasil dinyalakan dan siap beroperasi.\n\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `📅 Tanggal : ${tgl}\n` +
        `🕐 Waktu   : ${jam} WIB\n` +
        `━━━━━━━━━━━━━━━━━\n\n` +
        `⚙️ *KONFIGURASI AKTIF:*\n` +
        `🔸 *Pair:* ${pairInfo}\n` +
        `🔸 *Timeframe:* ${tfInfo}\n` +
        `🔸 *Min Grade OP:* ${minGradeInfo}\n` +
        `🔸 *Target RR:* 1:${rrInfo}\n` +
        `🔸 *SL Mode:* Ring ${slPctInfo}%\n\n` +
        `✅ Scanner engulfing aktif\n` +
        `✅ Listener sinyal aktif\n` +
        `✅ Laporan otomatis terjadwal\n\n` +
        `_Bot akan mengirim notifikasi OP jika market memenuhi kriteria di atas._ 🚀`;

      console.log(`[STARTUP] Mencoba kirim pesan ke ${GROUP_JID} (attempt ${retryCount + 1}/${MAX_RETRY})...`);

      // WARMUP: Pancing Baileys untuk mengambil metadata grup agar session crypto ter-sinkron
      try {
        await sock.groupMetadata(GROUP_JID);
        await delay(2000); // Beri waktu ekstra untuk generate keys
      } catch (e) {
        console.log(`[STARTUP] Warmup group gagal (bukan error fatal): ${e}`);
      }

      await sock.sendMessage(GROUP_JID, { text: startupMsg });
      console.log('[STARTUP] ✅ Notifikasi startup BERHASIL dikirim ke grup WA!');

    } catch (e: any) {
      console.error(`[STARTUP] ❌ Gagal kirim startup (attempt ${retryCount + 1}): ${e?.message || e}`);

      if (retryCount < MAX_RETRY - 1) {
        console.log(`[STARTUP] Retry dalam ${RETRY_DELAY / 1000} detik...`);
        await delay(RETRY_DELAY);
        await sendStartupMessage(retryCount + 1);
      } else {
        console.error('[STARTUP] ❌ Semua retry habis. Startup message tidak terkirim.');
      }
    }
  }

  // =====================================================
  // Database Lock Helpers
  // =====================================================
  async function acquireLock(supabase: any, sessionId: string, instanceId: string): Promise<boolean> {
    try {
      const { data: session, error } = await supabase
        .from('whatsapp_sessions')
        .select('owner_id, locked_at')
        .eq('id', sessionId)
        .maybeSingle();

      if (error) {
        console.error('[LOCK] Error reading lock status:', error.message);
        return false;
      }

      if (!session) {
        console.error('[LOCK] Session not found in database.');
        return false;
      }

      const now = Date.now();
      const lockedAtTime = session.locked_at ? new Date(session.locked_at).getTime() : 0;
      const isStale = !session.locked_at || (now - lockedAtTime > 60000); // 1 minute stale threshold

      // Case 1: Unlocked
      if (!session.owner_id) {
        const { error: updateError } = await supabase
          .from('whatsapp_sessions')
          .update({
            owner_id: instanceId,
            locked_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', sessionId)
          .is('owner_id', null);

        if (!updateError) {
          console.log('[LOCK] Lock acquired successfully (was unlocked).');
          return true;
        }
        console.warn('[LOCK] Failed to acquire lock (was unlocked but claimed by someone else).');
        return false;
      }

      // Case 2: Already locked by us
      if (session.owner_id === instanceId) {
        const { error: updateError } = await supabase
          .from('whatsapp_sessions')
          .update({
            locked_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', sessionId)
          .eq('owner_id', instanceId);

        if (!updateError) {
          return true;
        }
        return false;
      }

      // Case 3: Locked by another instance but stale
      if (isStale) {
        console.log(`[LOCK] Lock is stale (held by ${session.owner_id} since ${session.locked_at}). Attempting to override...`);
        const { error: updateError } = await supabase
          .from('whatsapp_sessions')
          .update({
            owner_id: instanceId,
            locked_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', sessionId)
          .eq('owner_id', session.owner_id);

        if (!updateError) {
          console.log(`[LOCK] Lock overridden successfully. New owner: ${instanceId}`);
          return true;
        }
        console.warn('[LOCK] Failed to override stale lock.');
        return false;
      }

      // Case 4: Locked by another active instance
      console.warn(`[LOCK] ⚠️ Gagal start! Sesi sedang dikunci oleh instance lain (${session.owner_id}) yang aktif.`);
      return false;
    } catch (e: any) {
      console.error('[LOCK] Exception during lock acquisition:', e?.message || e);
      return false;
    }
  }

  async function releaseLock(supabase: any, sessionId: string, instanceId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('whatsapp_sessions')
        .update({
          owner_id: null,
          locked_at: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', sessionId)
        .eq('owner_id', instanceId);

      if (error) {
        console.error('[LOCK] Gagal melepaskan lock:', error.message);
      } else {
        console.log('[LOCK] Lock dilepaskan secara bersih.');
      }
    } catch (e: any) {
      console.error('[LOCK] Exception saat melepaskan lock:', e?.message || e);
    }
  }

  function startLockHeartbeat(supabase: any, sessionId: string, instanceId: string) {
    return setInterval(async () => {
      try {
        const { error } = await supabase
          .from('whatsapp_sessions')
          .update({
            locked_at: new Date().toISOString()
          })
          .eq('id', sessionId)
          .eq('owner_id', instanceId);

        if (error) {
          console.error('[LOCK] Heartbeat gagal, lock mungkin direbut atau terputus:', error.message);
        }
      } catch (e: any) {
        console.error('[LOCK] Exception saat heartbeat:', e?.message || e);
      }
    }, 20000); // 20 detik
  }

  async function connectToWhatsApp() {
    console.log('Starting WhatsApp Trigger Bot...');
    console.log(`[CONFIG] GROUP_JID = ${GROUP_JID}`);

    // Acquire lock on initial start
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
        console.error('[LOCK] ❌ Gagal mendapatkan lock setelah beberapa percobaan. Harap pastikan tidak ada instance lain yang berjalan.');
        process.exit(1);
      }

      // Start lock heartbeat
      heartbeatInterval = startLockHeartbeat(supabase, SESSION_ID, INSTANCE_ID);
    }

    const { state, saveCreds, clearState } = await useSupabaseAuthState(supabase);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[CONFIG] Baileys version = ${version.join('.')}`);

    // Expose clearState ke module scope agar bisa dipanggil oleh logout handler
    clearAuthState = clearState;

    sock = makeWASocket({
      version,
      auth: state,
      logger,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      console.log(`[WA] connection.update → connection=${connection}`);

      if (qr) {
        console.log('[WA] QR Code received, updating Supabase...');
        await syncWaStatus('UNPAIRED', qr);
      }

      if (connection === 'close') {
        waConnectionState = 'close';
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WA] Connection closed. Reconnect:', shouldReconnect);

        if (shouldReconnect) {
          setTimeout(() => {
            connectToWhatsApp();
          }, 5000);
        } else {
          console.log('[WA] Logged out. Clearing state...');
          clearState().then(() => {
            setTimeout(() => {
              connectToWhatsApp();
            }, 5000);
          });
        }

      } else if (connection === 'open') {
        console.log('[WA] ✅ Connection OPEN!');
        console.log('[WA] sock.user =', JSON.stringify(sock?.user));
        waConnectionState = 'open';

        await syncWaStatus('CONNECTED', null);

        // Delay 3 detik: pastikan socket fully stable & authenticated
        console.log('[WA] Waiting 3s for socket to fully stabilize...');
        await delay(3000);

        // Cek tambahan: tunggu sampai sock.user tersedia (tanda fully authenticated)
        let waitCount = 0;
        while (!sock?.user && waitCount < 10) {
          console.log(`[WA] Waiting for sock.user... (${waitCount + 1}/10)`);
          await delay(1000);
          waitCount++;
        }
        console.log('[WA] Socket ready. sock.user =', JSON.stringify(sock?.user));

        // Register Supabase listeners SETELAH sock siap
        setupSupabaseListeners();

        // Start Cron Jobs (Only Once)
        if (!cronStarted) {
          cronStarted = true;
          startCronJobs(sock, GROUP_JID);
        } else {
          console.log('[CRON] Schedulers sudah berjalan, skip pendaftaran ulang.');
        }

        // Process pending outbox jobs immediately
        processOutbox();

        // Kirim startup notification hanya pertama kali
        if (isFirstConnect && GROUP_JID) {
          isFirstConnect = false;
          console.log('[STARTUP] Mengirim startup notification...');
          await sendStartupMessage();
        } else {
          console.log('[WA] Bukan koneksi pertama, skip startup message.');
        }
      }
    });
  }


  // =====================================================
  // Bootstrap — connectToWhatsApp & Outbox Polling Worker
  // =====================================================
  connectToWhatsApp();
  setInterval(processOutbox, 10000);

  // Handler untuk SIGINT (Ctrl+C)
  process.on('SIGINT', async () => {
    const shutdownTime = new Date();

    console.log('\n[SYSTEM] Menerima sinyal Shutdown (Ctrl+C)...');
    console.log(`[SYSTEM] Sesi berjalan dari ${SESSION_START_TIME.toLocaleTimeString('id-ID')} → ${shutdownTime.toLocaleTimeString('id-ID')}`);
    console.log('[SYSTEM] Membuat Laporan PDF Terakhir sebelum mati...');

    if (sock && GROUP_JID) {
      try {
        await generateAndSendPDF(sock, 'SHUTDOWN', GROUP_JID, SESSION_START_TIME, shutdownTime);
      } catch (e) {
        console.error('[SYSTEM] Gagal mengirim Shutdown Report:', e);
      }
    }

    // Release lock cleanly
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    await releaseLock(supabase, SESSION_ID, INSTANCE_ID);

    console.log('[SYSTEM] Keluar dari proses. Sampai jumpa!');
    process.exit(0);
  })
}
