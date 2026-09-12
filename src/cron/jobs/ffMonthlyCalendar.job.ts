// =====================================================
// src/cron/jobs/ffMonthlyCalendar.job.ts
// Cron Job: Pengiriman Kalender Bulanan Forex Factory (Format PDF)
// Jadwal: Tanggal 1 setiap bulan pukul 07:00 WIB
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';
import { GROUP_FOREX_FACTORY_JID } from '../../config/env';
import { getMonthEvents, syncForexFactoryCalendar } from '../../services/forexFactoryService';
import { forexPdfService } from '../../services/forexPdfService';
import { formatMonthlyCalendarCaption } from '../../templates/forexFactoryTemplates';

const ffMonthlyCalendarJob: CronJobDefinition = {
  name: 'ffMonthlyCalendar',
  description: 'Mengirimkan dokumen PDF kalender bulanan Forex Factory setiap tanggal 1 pukul 07:00 WIB',
  schedule: CRON_CONFIG.FF_MONTHLY_CALENDAR.schedule,
  enabled: CRON_CONFIG.FF_MONTHLY_CALENDAR.enabled,

  handler: async (ctx: CronContext) => {
    console.log('[CRON] 📄 Memulai pembuatan PDF Kalender Bulanan Forex Factory...');

    try {
      await syncForexFactoryCalendar();

      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1; // 1-12
      const monthName = new Intl.DateTimeFormat('id-ID', { month: 'long' }).format(now);

      const events = await getMonthEvents(year, month);
      const highImpactCount = events.filter(e => e.impact === 'High').length;

      console.log(`[CRON] Ditemukan ${events.length} event untuk bulan ${monthName} ${year}`);

      // 1. Generate PDF via Puppeteer
      const pdfBuffer = await forexPdfService.generateMonthlyCalendarPdf(
        events,
        year,
        month,
        monthName
      );

      // 2. Format caption
      const caption = formatMonthlyCalendarCaption(
        monthName,
        year,
        events.length,
        highImpactCount
      );

      const targetJid = GROUP_FOREX_FACTORY_JID || ctx.groupJid;
      const fileName = `ForexFactory_Calendar_${monthName}_${year}.pdf`;

      // 3. Kirim ke WhatsApp sebagai dokumen PDF
      console.log(`[CRON] 📤 Mengirimkan PDF kalender ke ${targetJid}...`);
      await ctx.sock.sendMessage(targetJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName,
        caption,
      });

      console.log('[CRON] ✅ PDF Kalender Bulanan Forex Factory berhasil dikirim!');
    } catch (err: any) {
      console.error('[CRON] ❌ Gagal membuat/mengirim PDF Kalender Bulanan:', err?.message || err);
    }
  },
};

export default ffMonthlyCalendarJob;
