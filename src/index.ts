import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import pino from 'pino';
import { useSupabaseAuthState } from './supabaseAuthState';
import { startCronJobs } from './cronScheduler';
import { generateAndSendPDF } from './pdfService';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const GROUP_JID = process.env.GROUP_JID!;
const SESSION_ID = 'main_session';

// ✅ Catat TEPAT saat sistem pertama kali dijalankan
const SESSION_START_TIME = new Date();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const logger = pino({ level: 'silent' });

let sock: any = null;
let isFirstConnect = true; // flag agar startup notif hanya kirim sekali

async function connectToWhatsApp() {
  console.log('Starting WhatsApp Trigger Bot...');
  
  const { state, saveCreds, clearState } = await useSupabaseAuthState(supabase);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('New QR Code received, updating Supabase...');
      await supabase
        .from('whatsapp_sessions')
        .update({ qr_code: qr, status: 'UNPAIRED' })
        .eq('id', SESSION_ID);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
      
      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log('Logged out. Clearing state and waiting for new login.');
        await clearState();
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection opened!');
      await supabase
        .from('whatsapp_sessions')
        .update({ status: 'CONNECTED', qr_code: null })
        .eq('id', SESSION_ID);

      // Kirim notifikasi startup hanya pada koneksi pertama
      if (isFirstConnect && GROUP_JID) {
        isFirstConnect = false;
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

        try {
          await sock.sendMessage(GROUP_JID, { text: startupMsg });
          console.log('[STARTUP] Notifikasi startup berhasil dikirim ke grup WA.');
        } catch (e) {
          console.error('[STARTUP] Gagal kirim notifikasi startup:', e);
        }
      }
    }
  });
}

function setupSupabaseListeners() {
  // Listen for LOGOUT_REQUESTED from frontend
  supabase
    .channel('whatsapp_session_changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'whatsapp_sessions', filter: 'id=eq.main_session' },
      (payload) => {
        if (payload.new.status === 'LOGOUT_REQUESTED') {
          console.log('Logout requested by Frontend!');
          if (sock) sock.logout();
        }
      }
    )
    .subscribe();

  // Listen to Supabase Realtime for new trades
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
              caption 
            });
            console.log(`✅ Sukses! Gambar (bukan link) beserta caption berhasil dikirim ke grup untuk ticket: ${trade.ticket_id}`);
          }
        } catch (error) {
          console.error('Error sending message:', error);
        }
      }
    )
    .subscribe();

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
          
          // Memperkirakan OP, SL, TP (Berdasarkan harga close candle terakhir)
          const opPrice = signal.curr_close.toFixed(2);
          const slPrice = isBuy ? signal.curr_low.toFixed(2) : signal.curr_high.toFixed(2);
          
          const caption = `⚠️ *NEW OPEN POSITION* ⚠️\n\n*${modeEmoji} ${mode} SIGNAL*\n🔸 *Pair:* ${signal.symbol}\n🔸 *Timeframe:* ${signal.timeframe}\n\n🎯 *Entry:* ${opPrice}\n🛡️ *SL Area:* ${slPrice}\n🧠 *Confidence:* ${signal.confidence_score}%`;
          
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
    .subscribe();
}

setupSupabaseListeners();
connectToWhatsApp().then(() => {
  // Start Cron Jobs once connected
  startCronJobs(sock, GROUP_JID);
});

// Handler untuk SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  const shutdownTime = new Date();
  
  console.log('\n[SYSTEM] Menerima sinyal Shutdown (Ctrl+C)...');
  console.log(`[SYSTEM] Sesi berjalan dari ${SESSION_START_TIME.toLocaleTimeString('id-ID')} → ${shutdownTime.toLocaleTimeString('id-ID')}`);
  console.log('[SYSTEM] Membuat Laporan PDF Terakhir sebelum mati...');
  
  if (sock && GROUP_JID) {
    try {
      // ✅ Range data = dari jam sistem pertama jalan sampai sekarang
      // Bukan dari jam 00:00, tapi dari SESSION_START_TIME
      await generateAndSendPDF(sock, 'SHUTDOWN', GROUP_JID, SESSION_START_TIME, shutdownTime);
    } catch (e) {
      console.error('[SYSTEM] Gagal mengirim Shutdown Report:', e);
    }
  }
  
  console.log('[SYSTEM] Keluar dari proses. Sampai jumpa!');
  process.exit(0);
});
