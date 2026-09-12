// =====================================================
// src/scripts/testSendForexFactory.ts
// Script testing: Mengirimkan satu pesan sampel Daily Briefing
// langsung ke WhatsApp Group: 120363429816923352@g.us (FOREX FACTORY INFO)
// =====================================================

import { connectToWhatsApp, sock, waConnectionState, setOnSocketReady } from '../services/waSocket';
import { GROUP_FOREX_FACTORY_JID } from '../config/env';
import { syncForexFactoryCalendar, getDayEvents } from '../services/forexFactoryService';
import { fetchGoldNews, generateGoldMarketAnalysis } from '../services/goldNewsService';
import { formatDailyBriefingMessage } from '../templates/forexFactoryTemplates';
import { delay } from '../utils/helpers';

async function runTest() {
  console.log('[TEST] 🚀 Menyiapkan pengiriman uji coba ke grup Forex Factory...');
  console.log(`[TEST] Target JID: ${GROUP_FOREX_FACTORY_JID}`);

  setOnSocketReady(async () => {
    console.log('[TEST] ✅ WA Socket Ready. Memulai proses generate pesan...');

    try {
      // 1. Sync data kalender
      await syncForexFactoryCalendar(true);

      // 2. Ambil event (atau sample data jika Sabtu/Minggu libur)
      let events = await getDayEvents(new Date(), ['High', 'Medium'], true);

      // Jika hari ini libur akhir pekan (0 events), buat simulasi 2 event agar user bisa melihat wujud formatnya
      if (events.length === 0) {
        console.log('[TEST] ℹ️ Hari ini libur market (0 events), menambahkan event simulasi untuk preview...');
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
      const news = await fetchGoldNews(3);

      // 4. Analisa AI
      const analysis = await generateGoldMarketAnalysis(events, news);

      // 5. Susun pesan template
      const message = formatDailyBriefingMessage(events, analysis, news);

      // 6. Kirim ke WhatsApp
      console.log(`[TEST] 📤 Mengirim pesan ke grup ${GROUP_FOREX_FACTORY_JID}...`);
      await sock.sendMessage(GROUP_FOREX_FACTORY_JID, { text: message });

      console.log('[TEST] 🎉 SUKSES! Pesan uji coba berhasil mendarat di grup WhatsApp Anda!');
      console.log('[TEST] Menutup koneksi dalam 3 detik...');
      await delay(3000);
      process.exit(0);
    } catch (err: any) {
      console.error('[TEST] ❌ Gagal:', err?.message || err);
      process.exit(1);
    }
  });

  connectToWhatsApp();
}

runTest();
