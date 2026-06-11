import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { format, subHours } from 'date-fns';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function generateAndSendPDF(sock: any, reportType: string, groupJid: string, dateStart: Date, dateEnd: Date) {
  try {
    console.log(`[PDF] Generating ${reportType} report...`);

    // 1. Fetch Data from View
    const { data: trades, error } = await supabase
      .from('trade_deep_analytics_view')
      .select('*')
      .gte('trade_created_at', dateStart.toISOString())
      .lt('trade_created_at', dateEnd.toISOString())
      .order('trade_created_at', { ascending: true });

    if (error) throw error;

    // 2. Calculate Stats
    const totalTrades = trades?.length || 0;
    let totalProfit = 0;
    let wins = 0;
    
    const formattedTrades = (trades || []).map(t => {
      totalProfit += (t.profit || 0);
      if (t.result === 'PROFIT') wins++;
      return {
        ...t,
        formattedTime: t.entry_time ? format(subHours(new Date(t.entry_time), 3), 'dd MMM HH:mm') : '-',
      };
    });

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    
    // We'll calculate netProfit as the same as totalProfit for simplicity since MT5 profit includes swap/commission usually.
    const netProfit = totalProfit;

    const stats = {
      totalTrades,
      winRate,
      totalProfit,
      netProfit
    };

    let reportTitle = '';
    if (reportType === 'DAILY') reportTitle = `Laporan Harian (${format(dateStart, 'dd MMM yyyy')})`;
    else if (reportType === 'WEEKLY') reportTitle = `Laporan Mingguan`;
    else if (reportType === 'MONTHLY') reportTitle = `Laporan Bulanan (${format(dateStart, 'MMMM yyyy')})`;
    else if (reportType === 'SHUTDOWN') reportTitle = `Laporan Terakhir (Shutdown System)`;

    // 3. Render HTML
    const templatePath = path.join(__dirname, 'templates', 'reportTemplate.ejs');
    
    // Format period range
    const periodRange = `${format(dateStart, 'dd MMM yyyy HH:mm')} - ${format(dateEnd, 'dd MMM yyyy HH:mm')}`;

    const htmlString = await ejs.renderFile(templatePath, {
      reportTitle,
      periodRange,
      currentDate: format(new Date(), 'dd MMMM yyyy HH:mm'),
      stats,
      trades: formattedTrades
    });

    // 4. Generate PDF via Puppeteer
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: 'load' });
    
    // Beri waktu 1.5 detik agar script Tailwind CDN selesai me-render CSS-nya
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
    });

    await browser.close();

    // 5. Upload to Supabase Storage
    const fileName = `Report_${reportType}_${Date.now()}.pdf`;
    
    // Konversi buffer (Uint8Array) untuk upload
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('pdf_reports')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false
      });

    if (uploadError) {
      console.error('[PDF] Supabase Upload Error:', uploadError.message);
      // Fallback: send directly without URL if upload fails?
      throw uploadError;
    }

    const { data: publicUrlData } = supabase.storage.from('pdf_reports').getPublicUrl(fileName);
    const publicUrl = publicUrlData.publicUrl;

    // 6. Save to report_history
    await supabase.from('report_history').insert({
      report_type: reportType,
      report_date: dateStart.toISOString().split('T')[0],
      file_url: publicUrl,
      total_trades: totalTrades,
      win_rate: winRate,
      total_profit: totalProfit
    });

    // 7. Send to WA
    const caption = `📊 *${reportTitle}*\n\n` +
      `Total Trade: ${totalTrades}\n` +
      `Win Rate: ${winRate.toFixed(1)}%\n` +
      `Net Profit: $${netProfit.toFixed(2)}\n\n` +
      `_File PDF Laporan lengkap terlampir._`;

    await sock.sendMessage(groupJid, {
      document: Buffer.from(pdfBuffer),
      mimetype: 'application/pdf',
      fileName: `Engulfing_${reportType}_Report.pdf`,
      caption: caption
    });

    console.log(`[PDF] ${reportType} report sent successfully!`);
    return true;
  } catch (error) {
    console.error(`[PDF] Failed to generate/send ${reportType} report:`, error);
    return false;
  }
}
