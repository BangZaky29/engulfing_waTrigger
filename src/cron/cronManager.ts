// =====================================================
// src/cron/cronManager.ts
// Central orchestrator — registry & scheduler semua cron jobs.
// Import semua job definitions, filter yang enabled,
// dan register ke node-cron dengan error handling per job.
// =====================================================

import cron from 'node-cron';
import { CronJobDefinition, CronContext } from './types';

// Import semua job definitions
import dailyReportJob from './jobs/dailyReport.job';
import weeklyReportJob from './jobs/weeklyReport.job';
import monthlyReportJob from './jobs/monthlyReport.job';
import yearlyReportJob from './jobs/yearlyReport.job';
import { botTradingOpenNotifJob, botTradingCloseNotifJob } from './jobs/botScheduleNotifier.job';

/**
 * Kumpulkan semua job definitions dari folder jobs/.
 * Untuk menambah job baru, cukup:
 * 1. Buat file di jobs/
 * 2. Import di sini
 * 3. Tambahkan ke array ini
 */
function getAllJobs(): CronJobDefinition[] {
  return [
    // Report Jobs
    dailyReportJob,
    weeklyReportJob,
    monthlyReportJob,
    yearlyReportJob,

    // Bot Schedule Notifier (disabled by default)
    botTradingOpenNotifJob,
    botTradingCloseNotifJob,
  ];
}

/**
 * Start semua cron jobs yang enabled.
 * Dipanggil dari waSocket.ts setelah koneksi WA berhasil open.
 */
export function startAllCronJobs(sock: any, groupJid: string) {
  const ctx: CronContext = { sock, groupJid };
  const jobs = getAllJobs();

  const activeCount = jobs.filter(j => j.enabled).length;
  const disabledCount = jobs.filter(j => !j.enabled).length;

  console.log('[CRON] ════════════════════════════════════');
  console.log('[CRON]   📋 Cron Job Registry');
  console.log(`[CRON]   Total: ${jobs.length} jobs (${activeCount} active, ${disabledCount} disabled)`);
  console.log('[CRON] ════════════════════════════════════');

  jobs.forEach(job => {
    if (!job.enabled) {
      console.log(`[CRON] ⏸️  ${job.name} — DISABLED (${job.description})`);
      return;
    }

    // Validasi cron expression
    if (!cron.validate(job.schedule)) {
      console.error(`[CRON] ❌ ${job.name} — INVALID schedule: "${job.schedule}"`);
      return;
    }

    cron.schedule(job.schedule, async () => {
      const startTime = Date.now();
      console.log(`[CRON] ▶️  Running: ${job.name}...`);

      try {
        await job.handler(ctx);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[CRON] ✅ Done: ${job.name} (${duration}s)`);
      } catch (err) {
        console.error(`[CRON] ❌ Error di ${job.name}:`, err);
      }
    });

    console.log(`[CRON] ✅ ${job.name} — active (${job.schedule})`);
  });

  console.log('[CRON] ════════════════════════════════════');
}
