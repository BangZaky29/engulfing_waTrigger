// =====================================================
// src/cron/jobs/monthlyReport.job.ts
// Cron Job: Monthly Report — hari terakhir bulan jam 23:57
// Karena node-cron tidak support "L" (last day),
// job ini jalan setiap hari dan cek apakah besok tanggal 1.
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { generateAndSendPDF } from '../../services/pdfReportService';

const monthlyReportJob: CronJobDefinition = {
  name: 'monthlyReport',
  description: 'Laporan bulanan — hari terakhir bulan jam 23:57',
  schedule: CRON_CONFIG.MONTHLY_REPORT.schedule,
  enabled: CRON_CONFIG.MONTHLY_REPORT.enabled,

  handler: async (ctx: CronContext) => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Hanya generate report jika besok adalah tanggal 1 (hari terakhir bulan)
    if (tomorrow.getDate() !== 1) {
      return;
    }

    console.log('[CRON] Triggering MONTHLY Report...');

    const start = new Date();
    start.setDate(1); // 1st of this month
    start.setHours(0, 0, 0, 0);

    await generateAndSendPDF(ctx.sock, 'MONTHLY', ctx.groupJid, start, today);
  },
};

export default monthlyReportJob;
