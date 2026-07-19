// =====================================================
// src/cron/jobs/yearlyReport.job.ts
// Cron Job: Yearly Report — 31 Desember jam 23:56
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { generateAndSendPDF } from '../../services/pdfReportService';

const yearlyReportJob: CronJobDefinition = {
  name: 'yearlyReport',
  description: 'Laporan tahunan — 31 Desember jam 23:56',
  schedule: CRON_CONFIG.YEARLY_REPORT.schedule,
  enabled: CRON_CONFIG.YEARLY_REPORT.enabled,

  handler: async (ctx: CronContext) => {
    console.log('[CRON] Triggering YEARLY Report...');

    const end = new Date();
    const start = new Date(end.getFullYear(), 0, 1); // Jan 1st of this year

    await generateAndSendPDF(ctx.sock, 'YEARLY', ctx.groupJid, start, end);
  },
};

export default yearlyReportJob;
