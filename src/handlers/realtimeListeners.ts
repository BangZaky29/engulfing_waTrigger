import { supabase } from '../services/supabaseClient';
import { isWaReady, sock, clearAuthState, resetIsFirstConnect, resetListenersRegistered, resetGlobalAuthState } from '../services/waSocket';
import { handleEngulfingSignal } from './signalHandler';
import { handleActiveLog } from './activeLogHandler';
import { handleTradeResult } from './tradeResultHandler';

let isRetrying = false;

export async function setupSupabaseListeners() {
  console.log('[LISTENER] Membersihkan channel lama (jika ada)...');
  await supabase.removeAllChannels();
  
  console.log('[LISTENER] Mendaftarkan Supabase Realtime listeners...');

  function scheduleListenerRetry(channelName: string, delayMs = 30000) {
    console.warn(`[LISTENER] ⚠️ ${channelName} CHANNEL_ERROR.`);
    if (isRetrying) return;
    
    isRetrying = true;
    console.warn(`[LISTENER] ⏳ Menjadwalkan re-subscribe dalam ${delayMs / 1000}s...`);
    resetListenersRegistered(); 
    setTimeout(async () => {
      isRetrying = false;
      if (isWaReady()) {
        console.log(`[LISTENER] 🔄 Re-subscribing semua listeners setelah CHANNEL_ERROR...`);
        await setupSupabaseListeners();
      } else {
        console.log(`[LISTENER] WA belum ready saat retry, skip re-subscribe.`);
      }
    }, delayMs);
  }

  // Listen for LOGOUT_REQUESTED
  supabase
    .channel('whatsapp_public_status_changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'whatsapp_public_status', filter: 'id=eq.main_session' },
      async (payload) => {
        if (payload.new.status === 'LOGOUT_REQUESTED') {
          console.log('[LOGOUT] Logout requested by Frontend! Membersihkan session...');

          try {
            if (clearAuthState) {
              await clearAuthState();
              console.log('[LOGOUT] ✅ session_data berhasil dihapus dari Supabase.');
            } else {
              await supabase.from('whatsapp_auth_keys').delete().eq('session_id', 'main_session');
              await supabase.from('whatsapp_sessions').update({ status: 'UNPAIRED', qr_code: null }).eq('id', 'main_session');
              await supabase.from('whatsapp_public_status').update({ status: 'UNPAIRED', qr_code: null }).eq('id', 'main_session');
              console.log('[LOGOUT] ✅ session_data dihapus via fallback.');
            }
          } catch (e) {
            console.error('[LOGOUT] Gagal hapus session_data:', e);
          }

          if (sock) {
            try {
              await sock.logout();
              console.log('[LOGOUT] ✅ Socket berhasil logout dari WhatsApp.');
            } catch (e) {
              console.warn('[LOGOUT] sock.logout() error (mungkin sudah disconnect):', e);
            }
          }

          resetIsFirstConnect();
          resetListenersRegistered();
          resetGlobalAuthState();
          console.log('[LOGOUT] Session bersih. Bot akan request QR code baru...');
        }
      }
    )
    .subscribe((status: string) => {
      console.log(`[LISTENER] whatsapp_public_status_changes subscription status: ${status}`);
      if (status === 'CHANNEL_ERROR') {
        scheduleListenerRetry('whatsapp_public_status_changes');
      }
    });

  // Listen to trade_analytics
  supabase
    .channel('trade_analytics_changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trade_analytics' }, handleTradeResult)
    .subscribe((status: string) => {
      console.log(`[LISTENER] trade_analytics_changes subscription status: ${status}`);
      if (status === 'CHANNEL_ERROR') {
        console.error('[LISTENER] ❌ Gagal subscribe ke trade_analytics!');
        scheduleListenerRetry('trade_analytics_changes');
      }
    });

  // Listen to trade_active_logs
  supabase
    .channel('trade_active_logs_changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trade_active_logs' }, handleActiveLog)
    .subscribe((status: string) => {
      console.log(`[LISTENER] trade_active_logs_changes subscription status: ${status}`);
      if (status === 'CHANNEL_ERROR') {
        console.error('[LISTENER] ❌ Gagal subscribe ke trade_active_logs!');
        scheduleListenerRetry('trade_active_logs_changes');
      }
    });

  // Listen to engulfing_signals
  supabase
    .channel('engulfing_signals_changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'engulfing_signals', filter: 'is_confirmed=eq.true' }, handleEngulfingSignal)
    .subscribe((status: string) => {
      console.log(`[LISTENER] engulfing_signals_changes subscription status: ${status}`);
      if (status === 'CHANNEL_ERROR') {
        console.error('[LISTENER] ❌ Gagal subscribe ke engulfing_signals!');
        scheduleListenerRetry('engulfing_signals_changes');
      }
    });

  console.log('[LISTENER] ✅ Semua Supabase Realtime listeners diinisialisasi.');
}
