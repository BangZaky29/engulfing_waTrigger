// =====================================================
// src/cron/jobs/dailyReport.job.ts
// Cron Job: Daily Report — setiap hari jam 23:59
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { generateAndSendPDF } from '../../services/pdfReportService';

const dailyReportJob: CronJobDefinition = {
  name: 'dailyReport',
  description: 'Laporan harian — setiap hari jam 23:59',
  schedule: CRON_CONFIG.DAILY_REPORT.schedule,
  enabled: CRON_CONFIG.DAILY_REPORT.enabled,

  handler: async (ctx: CronContext) => {
    console.log('[CRON] Triggering DAILY Report...');

    const end = new Date();
    const start = new Date();
    start.setHours(0, 0, 0, 0); // Start of today

    await generateAndSendPDF(ctx.sock, 'DAILY', ctx.groupJid, start, end);
  },
};

export default dailyReportJob;
