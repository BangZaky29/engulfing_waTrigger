// =====================================================
// src/cron/jobs/ffDailyBriefing.job.ts
// Cron Job: Daily Morning Briefing Forex Factory & Gold/USD
// Jadwal: Senin - Jumat pukul 06:30 WIB
// Target: GROUP_FOREX_FACTORY_JID (120363429816923352@g.us)
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { GROUP_FOREX_FACTORY_JID } from '../../config/env';
import { getDayEvents, syncForexFactoryCalendar } from '../../services/forexFactoryService';
import { fetchGoldNews, generateGoldMarketAnalysis } from '../../services/goldNewsService';
import { formatDailyBriefingMessage } from '../../templates/forexFactoryTemplates';

const ffDailyBriefingJob: CronJobDefinition = {
  name: 'ffDailyBriefing',
  description: 'Briefing kalender Forex Factory & analisa Gold/USD setiap hari pukul 06:30 WIB',
  schedule: CRON_CONFIG.FF_DAILY_BRIEFING.schedule,
  enabled: CRON_CONFIG.FF_DAILY_BRIEFING.enabled,

  handler: async (ctx: CronContext) => {
    console.log('[CRON] 🌅 Memulai penyusunan Forex Factory Daily Briefing...');

    try {
      // 1. Pastikan data terbaru sudah tersinkronisasi
      await syncForexFactoryCalendar();

      // 2. Ambil event hari ini (High & Medium impact untuk Gold & USD)
      const events = await getDayEvents(new Date(), ['High', 'Medium'], true);

      // 3. Ambil headline berita pasar emas terkini
      const news = await fetchGoldNews(3);

      // 4. Buat analisa sentimen emas via Gemini AI
      const analysis = await generateGoldMarketAnalysis(events, news);

      // 5. Susun pesan template
      const message = formatDailyBriefingMessage(events, analysis, news);

      // 6. Kirim ke grup WhatsApp FOREX FACTORY INFO
      const targetJid = GROUP_FOREX_FACTORY_JID || ctx.groupJid;
      console.log(`[CRON] 📤 Mengirimkan Daily Briefing ke ${targetJid}...`);

      await ctx.sock.sendMessage(targetJid, { text: message });
      console.log('[CRON] ✅ Forex Factory Daily Briefing terkirim!');
    } catch (err: any) {
      console.error('[CRON] ❌ Gagal mengirim Forex Factory Daily Briefing:', err?.message || err);
    }
  },
};

export default ffDailyBriefingJob;
