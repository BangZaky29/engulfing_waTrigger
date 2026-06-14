import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import pino from 'pino';
import { useSupabaseAuthState } from './supabaseAuthState';
import { startCronJobs } from './cronScheduler';
import { generateAndSendPDF } from './pdfService';

import { resolve } from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: resolve(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const GROUP_JID = process.env.GROUP_JID!;
const SESSION_ID = 'main_session';

// ✅ Catat TEPAT saat sistem pertama kali dijalankan
const SESSION_START_TIME = new Date();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const logger = pino({ level: 'silent' });

let sock: any = null;
let isFirstConnect = true;       // flag startup notif hanya sekali
let listenersRegistered = false; // flag agar listener Supabase tidak dobel saat reconnect
let clearAuthState: (() => Promise<void>) | null = null; // expose clearState ke module scope

// =====================================================
// Helper: delay
// =====================================================
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    .channel('whatsapp_session_changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'whatsapp_sessions', filter: 'id=eq.main_session' },
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
                .from('whatsapp_sessions')
                .update({ session_data: {}, status: 'UNPAIRED', qr_code: null })
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
      console.log(`[LISTENER] whatsapp_session_changes subscription status: ${status}`);
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

          const caption = `📈 *ENGULFING SIGNAL* 📉\n\n*${modeEmoji} ${trade.mode} ${trade.result}* ${resultEmoji}\n🔸 *Pair:* ${trade.symbol}\n🔸 *Timeframe:* ${trade.timeframe}\n\n💰 *Profit:* $${trade.profit ? trade.profit.toFixed(2) : '0.00'}\n🎫 *Ticket:* ${trade.ticket_id}`;

          if (trade.image_url && sock) {
            console.log(`Mengunduh dan mengirim gambar ke grup ${GROUP_JID}...`);
            await sock.sendMessage(GROUP_JID, {
              image: { url: trade.image_url },
              caption,
            });
            console.log(`✅ Sukses! Gambar beserta caption berhasil dikirim ke grup untuk ticket: ${trade.ticket_id}`);
          }
        } catch (error) {
          console.error('Error sending trade message:', error);
        }
      }
    )
    .subscribe((status: string) => {
      console.log(`[LISTENER] trade_analytics_changes subscription status: ${status}`);
      if (status === 'CHANNEL_ERROR') {
        console.error('[LISTENER] ❌ Gagal subscribe ke trade_analytics! Pastikan table ini terdaftar di PUBLICATION supabase_realtime.');
      }
    });

  // Listen to Supabase Realtime for NEW SIGNALS (Open Position)
  supabase
    .channel('engulfing_signals_changes')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'engulfing_signals' },
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
              
              // Engulfing | XAUUSD | M5 | BUY REVERSAL | Grade : A | B : 71% | CP : 128% | RR : 1.5 | SL : 75%
              const actionStr = notesObj.action_str || mode;
              const grade = notesObj.grade || '-';
              const bPct = notesObj.body_pct || 0;
              const cpPct = notesObj.cp_pct || 0;
              const rr = notesObj.rr_ratio || 1.5;
              const slPriceNotes = notesObj.sl_price || slPrice;
              const slPctEnv = process.env.EXECUTION_SL_PCT || '75';

              const summaryText = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${actionStr} | Grade : ${grade} | B : ${bPct}% | CP : ${cpPct}% | RR : ${rr} | SL : ${slPriceNotes}`;

              caption =
                `⚠️ *NEW OPEN POSITION* ⚠️\n\n` +
                `*${modeEmoji} ${mode} SIGNAL OP*\n` +
                `🔸 *Pair:* ${signal.symbol}\n` +
                `🔸 *Timeframe:* ${signal.timeframe}\n\n` +
                `🎯 *Entry:* ${opPrice}\n` +
                `🛡️ *SL Area:* ${slPriceNotes} (${slPctEnv}%)\n` +
                `🎯 *Target RR:* ${rr}\n\n` +
                `📊 *SUMMARY DATA:*\n` +
                `${summaryText}`;

            } catch (e) {
              console.log('Notes is not JSON or failed to parse, falling back to basic format.');
              caption = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${mode} | ${opPrice}`;
            }
          } else {
            caption = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${mode} | ${opPrice}`;
          }

          if (sock) {
            console.log(`Mengirim notifikasi OP ke grup ${GROUP_JID}...`);
            await sock.sendMessage(GROUP_JID, { text: caption });
            console.log(`✅ Sukses! Notifikasi OP berhasil dikirim ke grup.`);
          }
        } catch (error) {
          console.error('Error sending OP message:', error);
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

    const startupMsg =
      `🟢 *SISTEM AKTIF* 🟢\n\n` +
      `🤖 *Engulfing Analytics Bot* telah berhasil dinyalakan dan siap beroperasi.\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📅 Tanggal : ${tgl}\n` +
      `🕐 Waktu   : ${jam} WIB\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `✅ Scanner engulfing aktif\n` +
      `✅ Listener sinyal aktif\n` +
      `✅ Laporan otomatis terjadwal\n\n` +
      `_Bot akan mengirim notifikasi setiap ada sinyal baru. Stay tuned!_ 🚀`;

    console.log(`[STARTUP] Mencoba kirim pesan ke ${GROUP_JID} (attempt ${retryCount + 1}/${MAX_RETRY})...`);
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

async function connectToWhatsApp() {
  console.log('Starting WhatsApp Trigger Bot...');
  console.log(`[CONFIG] GROUP_JID = ${GROUP_JID}`);

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
      await supabase
        .from('whatsapp_sessions')
        .update({ qr_code: qr, status: 'UNPAIRED' })
        .eq('id', SESSION_ID);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WA] Connection closed. Reconnect:', shouldReconnect);

      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log('[WA] Logged out. Clearing state...');
        await clearState();
        connectToWhatsApp();
      }

    } else if (connection === 'open') {
      console.log('[WA] ✅ Connection OPEN!');
      console.log('[WA] sock.user =', JSON.stringify(sock?.user));

      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'CONNECTED', qr_code: null })
        .eq('id', SESSION_ID);

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

      // Start Cron Jobs
      startCronJobs(sock, GROUP_JID);

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
// Bootstrap — hanya connectToWhatsApp, yang lain di dalam connection open
// =====================================================
connectToWhatsApp();

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

  console.log('[SYSTEM] Keluar dari proses. Sampai jumpa!');
  process.exit(0);
});
