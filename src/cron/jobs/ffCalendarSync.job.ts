// =====================================================
// src/cron/jobs/ffCalendarSync.job.ts
// Cron Job: Sinkronisasi Kalender Forex Factory berkala (tiap 2 jam)
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { syncForexFactoryCalendar } from '../../services/forexFactoryService';

const ffCalendarSyncJob: CronJobDefinition = {
  name: 'ffCalendarSync',
  description: 'Sync data kalender Forex Factory dari FairEconomy setiap 2 jam',
  schedule: CRON_CONFIG.FF_CALENDAR_SYNC.schedule,
  enabled: CRON_CONFIG.FF_CALENDAR_SYNC.enabled,

  handler: async (_ctx: CronContext) => {
    console.log('[CRON] 🔄 Menjalankan sinkronisasi berkala Forex Factory Calendar...');
    const result = await syncForexFactoryCalendar();
    console.log(`[CRON] Sinkronisasi selesai. Status: ${result.success ? 'Berhasil' : 'Gagal'} (${result.count} events)`);
  },
};

export default ffCalendarSyncJob;
