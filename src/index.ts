import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import pino from 'pino';
import { useSupabaseAuthState } from './supabaseAuthState';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const GROUP_JID = process.env.GROUP_JID!;
const SESSION_ID = 'main_session';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const logger = pino({ level: 'silent' });

let sock: any = null;

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
}

setupSupabaseListeners();
connectToWhatsApp();
