import { connectToWhatsApp, heartbeatInterval, INSTANCE_ID, sock, waConnectionState, setOnSocketReady } from './services/waSocket';
import { processOutbox } from './services/outboxService';
import { sendShutdownMessage } from './handlers/systemHandler';
import { generateAndSendPDF } from './services/pdfReportService';
import { supabase } from './services/supabaseClient';
import { releaseLock } from './services/lockManager';
import { SESSION_ID, PRIVATE_JID } from './config/env';
import { setupSupabaseListeners } from './handlers/realtimeListeners';
import { delay } from './utils/helpers';

// ✅ Catat TEPAT saat sistem pertama kali dijalankan
export const SESSION_START_TIME = new Date();

// =====================================================
// Bootstrap — connectToWhatsApp & Outbox Polling Worker
// =====================================================
setOnSocketReady(() => {
  setupSupabaseListeners();
});
connectToWhatsApp();
setInterval(() => {
    processOutbox(sock, () => Boolean(sock && sock.user && waConnectionState === 'open'), INSTANCE_ID);
}, 10000);

// Handler untuk SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  const shutdownTime = new Date();

  console.log('\n[SYSTEM] Menerima sinyal Shutdown (Ctrl+C)...');
  console.log(`[SYSTEM] Sesi berjalan dari ${SESSION_START_TIME.toLocaleTimeString('id-ID')} → ${shutdownTime.toLocaleTimeString('id-ID')}`);
  console.log('[SYSTEM] Menutup koneksi dengan bersih...');

  // if (sock) {
  //   await sendShutdownMessage('🛑 *SISTEM telah di matikan* 🛑\n\nBot sekarang offline. Mohon tunggu sampai sistem dinyalakan kembali.');
  // }

  // Release lock cleanly
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  await releaseLock(supabase, SESSION_ID, INSTANCE_ID);

  console.log('[SYSTEM] Menunggu TCP flush (3 detik)... JANGAN TEKAN Y DULU!');
  await delay(3000);
  console.log('[SYSTEM] Keluar dari proses. Sampai jumpa!');
  process.exit(0);
});

// Handler untuk error tak tertangkap — jangan biarkan bot crash diam-diam
process.on('uncaughtException', (err) => {
  console.error('[SYSTEM] ❌ Uncaught Exception:', err?.message || err);
  console.error(err?.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SYSTEM] ❌ Unhandled Promise Rejection:', reason);
});
