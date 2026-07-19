// =====================================================
// src/cron/jobs/weeklyReport.job.ts
// Cron Job: Weekly Report — setiap Minggu jam 23:58
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { generateAndSendPDF } from '../../pdfService';

const weeklyReportJob: CronJobDefinition = {
  name: 'weeklyReport',
  description: 'Laporan mingguan — setiap Minggu jam 23:58',
  schedule: CRON_CONFIG.WEEKLY_REPORT.schedule,
  enabled: CRON_CONFIG.WEEKLY_REPORT.enabled,

  handler: async (ctx: CronContext) => {
    console.log('[CRON] Triggering WEEKLY Report...');

    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7); // 7 days ago

    await generateAndSendPDF(ctx.sock, 'WEEKLY', ctx.groupJid, start, end);
  },
};

export default weeklyReportJob;
