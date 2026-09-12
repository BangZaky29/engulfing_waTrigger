// =====================================================
// src/scripts/testSendForexFactory.ts
// Script testing: Mengirimkan satu pesan sampel Daily Briefing
// langsung ke WhatsApp Group: 120363429816923352@g.us (FOREX FACTORY INFO)
// Mendukung dual-mode: Outbox queue (jika bot sedang jalan) atau Direct send
// =====================================================

import { connectToWhatsApp, sock, waConnectionState, setOnSocketReady } from '../services/waSocket';
import { GROUP_FOREX_FACTORY_JID, SESSION_ID } from '../config/env';
import { syncForexFactoryCalendar, getDayEvents } from '../services/forexFactoryService';
import { fetchGoldNews, generateGoldMarketAnalysis } from '../services/goldNewsService';
import { formatDailyBriefingMessage } from '../templates/forexFactoryTemplates';
import { enqueueWaMessage } from '../services/outboxService';
import { supabase } from '../services/supabaseClient';
import { delay } from '../utils/helpers';

async function runTest() {
  console.log('[TEST] 🚀 Menyiapkan pengujian pesan ke grup FOREX FACTORY INFO...');
  console.log(`[TEST] Target JID: ${GROUP_FOREX_FACTORY_JID}`);

  // 1. Sync data kalender
  console.log('[TEST] 1/4 Mengunduh data kalender Forex Factory...');
  await syncForexFactoryCalendar(true);

  // 2. Ambil event hari ini (atau buat simulasi jika hari ini Sabtu/Minggu pasar libur)
  let events = await getDayEvents(new Date(), ['High', 'Medium'], true);

  if (events.length === 0) {
    console.log('[TEST] ℹ️ Pasar Forex libur akhir pekan (0 events). Menyiapkan 2 agenda simulasi untuk preview...');
    events = [
      {
        id: 'sim_1',
        title: 'Core CPI m/m',
        country: 'USD',
        impact: 'High',
        event_date: new Date().toISOString(),
        forecast: '0.2%',
        previous: '0.2%',
        currency_pair: 'USD',
        is_gold_relevant: true,
      },
      {
        id: 'sim_2',
        title: 'Prelim UoM Consumer Sentiment',
        country: 'USD',
        impact: 'Medium',
        event_date: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        forecast: '68.5',
        previous: '67.9',
        currency_pair: 'USD',
        is_gold_relevant: true,
      },
    ];
  }

  // 3. Ambil berita pasar emas terkini
  console.log('[TEST] 2/4 Mengambil berita terkini seputar pasar Emas (XAU/USD)...');
  const news = await fetchGoldNews(3);

  // 4. Analisa AI
  console.log('[TEST] 3/4 Menjalankan analisa sentimen pasar emas AI...');
  const analysis = await generateGoldMarketAnalysis(events, news);

  // 5. Susun pesan template
  const message = formatDailyBriefingMessage(events, analysis, news);
  console.log('\n[TEST] 4/4 Preview format pesan yang akan dikirim:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(message);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Cek apakah ada instance bot yang sedang berjalan aktif di Supabase
  const { data: session } = await supabase
    .from('whatsapp_sessions')
    .select('owner_id, locked_at')
    .eq('id', SESSION_ID)
    .maybeSingle();

  const now = Date.now();
  const lockedAt = session?.locked_at ? new Date(session.locked_at).getTime() : 0;
  const isBotRunning = session?.owner_id && now - lockedAt < 60000;

  if (isBotRunning) {
    console.log(`[TEST] 🟢 Bot utama terdeteksi sedang AKTIF berjalan (Owner: ${session?.owner_id}).`);
    console.log('[TEST] 📥 Memasukkan pesan ke antrian outbox Supabase...');

    await enqueueWaMessage({
      sourceTable: 'test_ff_preview',
      sourceId: Math.floor(Math.random() * 1000000),
      eventType: 'DAILY_BRIEFING',
      groupJid: GROUP_FOREX_FACTORY_JID,
      messageType: 'TEXT',
      message,
    });

    console.log('[TEST] ✅ Pesan berhasil di-enqueue! Bot aktif Anda akan mengirimkannya ke grup dalam beberapa detik.');
    process.exit(0);
  } else {
    console.log('[TEST] 🟡 Bot utama tidak terdeteksi aktif. Menginisialisasi koneksi langsung WhatsApp...');

    setOnSocketReady(async () => {
      console.log('[TEST] ✅ WA Socket Ready. Mengirimkan pesan...');
      try {
        await sock.sendMessage(GROUP_FOREX_FACTORY_JID, { text: message });
        console.log('[TEST] 🎉 SUKSES! Pesan uji coba berhasil mendarat di grup WhatsApp Anda!');
        console.log('[TEST] Menutup koneksi dalam 3 detik...');
        await delay(3000);
        process.exit(0);
      } catch (err: any) {
        console.error('[TEST] ❌ Gagal kirim WA langsung:', err?.message || err);
        process.exit(1);
      }
    });

    connectToWhatsApp();
  }
}

runTest().catch(err => {
  console.error('[TEST] ❌ Error:', err?.message || err);
  process.exit(1);
});
