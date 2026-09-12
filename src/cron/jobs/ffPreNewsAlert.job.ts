// =====================================================
// src/cron/jobs/ffPreNewsAlert.job.ts
// Cron Job: Peringatan Flash 15-20 menit sebelum High Impact News (Red Folder)
// Jadwal: Polling setiap 5 menit (Senin - Jumat)
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { GROUP_FOREX_FACTORY_JID } from '../../config/env';
import {
  getUpcomingHighImpactEvents,
  markEventAlertSent,
} from '../../services/forexFactoryService';
import { formatPreNewsAlertMessage } from '../../templates/forexFactoryTemplates';

const ffPreNewsAlertJob: CronJobDefinition = {
  name: 'ffPreNewsAlert',
  description: 'Deteksi dan broadcast alert 15-20 menit sebelum berita High Impact USD/Emas rilis',
  schedule: CRON_CONFIG.FF_PRE_NEWS_ALERT.schedule,
  enabled: CRON_CONFIG.FF_PRE_NEWS_ALERT.enabled,

  handler: async (ctx: CronContext) => {
    try {
      // Cari event High Impact USD yang akan rilis dalam 25 menit ke depan & belum dikirimi notifikasi
      const upcomingEvents = await getUpcomingHighImpactEvents(25);

      if (upcomingEvents.length === 0) {
        return;
      }

      const targetJid = GROUP_FOREX_FACTORY_JID || ctx.groupJid;

      for (const event of upcomingEvents) {
        console.log(`[CRON] 🚨 Mendeteksi event High Impact mendekati rilis: ${event.title} (${event.event_date})`);

        const alertText = formatPreNewsAlertMessage(event);
        await ctx.sock.sendMessage(targetJid, { text: alertText });

        // Tandai sudah dikirim agar tidak terjadi double-alert di putaran 5 menit berikutnya
        await markEventAlertSent(event.id);
        console.log(`[CRON] ✅ Pre-news alert berhasil dikirim untuk: ${event.title}`);
      }
    } catch (err: any) {
      console.error('[CRON] ❌ Error pada ffPreNewsAlert:', err?.message || err);
    }
  },
};

export default ffPreNewsAlertJob;
