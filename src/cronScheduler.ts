import cron from 'node-cron';
import { generateAndSendPDF } from './pdfService';

export function startCronJobs(sock: any, groupJid: string) {
  console.log('[CRON] Starting PDF Report schedulers...');

  // 1. Daily Report - Every day at 23:59
  cron.schedule('59 23 * * *', async () => {
    console.log('[CRON] Triggering DAILY Report...');
    const end = new Date();
    const start = new Date();
    start.setHours(0, 0, 0, 0); // Start of today
    await generateAndSendPDF(sock, 'DAILY', groupJid, start, end);
  });

  // 2. Weekly Report - Every Sunday at 23:58
  cron.schedule('58 23 * * 0', async () => {
    console.log('[CRON] Triggering WEEKLY Report...');
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 7); // 7 days ago
    await generateAndSendPDF(sock, 'WEEKLY', groupJid, start, end);
  });

  // 3. Monthly Report - Last day of month at 23:57
  // Note: cron node doesn't have native "L" for last day, but we can run it daily and check if tomorrow is 1st
  cron.schedule('57 23 * * *', async () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    
    if (tomorrow.getDate() === 1) {
      console.log('[CRON] Triggering MONTHLY Report...');
      const start = new Date();
      start.setDate(1); // 1st of this month
      start.setHours(0, 0, 0, 0);
      await generateAndSendPDF(sock, 'MONTHLY', groupJid, start, today);
    }
  });

  // 4. Yearly Report - Dec 31 at 23:56
  cron.schedule('56 23 31 12 *', async () => {
    console.log('[CRON] Triggering YEARLY Report...');
    const end = new Date();
    const start = new Date(end.getFullYear(), 0, 1); // Jan 1st
    await generateAndSendPDF(sock, 'YEARLY', groupJid, start, end);
  });
}
