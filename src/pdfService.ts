import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { format, subHours } from 'date-fns';
import { getGeminiInsight } from './geminiService';

import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../.env') });


const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function generateAndSendPDF(sock: any, reportType: string, groupJid: string, dateStart: Date, dateEnd: Date) {
  try {
    console.log(`[PDF] Generating ${reportType} report...`);
    console.log(`[PDF] Period: ${dateStart.toISOString()} → ${dateEnd.toISOString()}`);

    // =====================================================
    // 1. Fetch Data from View
    // =====================================================
    const { data: trades, error } = await supabase
      .from('trade_deep_analytics_view')
      .select('*')
      .gte('trade_created_at', dateStart.toISOString())
      .lt('trade_created_at', dateEnd.toISOString())
      .order('trade_created_at', { ascending: true });

    if (error) throw error;

    // =====================================================
    // 2. Calculate Enhanced Stats
    // =====================================================
    const totalTrades = trades?.length || 0;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;   // jumlah profit dari trade winner
    let grossLoss = 0;     // jumlah kerugian dari trade loser (nilai positif)
    let bestTrade = 0;
    let worstTrade = 0;

    // Per-symbol tracking
    const symbolMap: Record<string, { profit: number; count: number; wins: number }> = {};

    const formattedTrades = (trades || []).map(t => {
      const profit = t.profit || 0;

      // Win / Loss counting
      if (t.result === 'PROFIT') {
        wins++;
        grossProfit += profit;
      } else {
        losses++;
        grossLoss += Math.abs(profit); // simpan sebagai nilai positif
      }

      // Best & Worst trade
      if (profit > bestTrade) bestTrade = profit;
      if (profit < worstTrade) worstTrade = profit;

      // Per-symbol aggregation
      const sym = t.symbol || 'UNKNOWN';
      if (!symbolMap[sym]) symbolMap[sym] = { profit: 0, count: 0, wins: 0 };
      symbolMap[sym].profit += profit;
      symbolMap[sym].count++;
      if (t.result === 'PROFIT') symbolMap[sym].wins++;

      return {
        ...t,
        formattedTime: t.entry_time
          ? format(subHours(new Date(t.entry_time), 3), 'dd MMM HH:mm')
          : '-',
      };
    });

    const netProfit = grossProfit - grossLoss;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgProfit = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    // Symbol paling aktif & paling profit
    const symbolList = Object.entries(symbolMap).map(([sym, s]) => ({ sym, ...s }));
    const mostActive = symbolList.sort((a, b) => b.count - a.count)[0] || null;
    const mostProfit = symbolList.sort((a, b) => b.profit - a.profit)[0] || null;

    // =====================================================
    // Performance Level (badge header)
    // =====================================================
    let performanceLevel = 'PERLU EVALUASI';
    let performanceColor = 'red';

    if (totalTrades === 0) {
      performanceLevel = 'TIDAK ADA DATA';
      performanceColor = 'gray';
    } else if (winRate >= 65 && netProfit > 0) {
      performanceLevel = 'PERFORMA BAGUS';
      performanceColor = 'green';
    } else if (winRate >= 45) {
      performanceLevel = 'PERFORMA CUKUP';
      performanceColor = 'yellow';
    } else {
      performanceLevel = 'PERLU EVALUASI';
      performanceColor = 'red';
    }

    // =====================================================
    // Gemini AI Insight
    // =====================================================
    console.log('[PDF] Meminta insight dari Gemini AI...');
    const geminiInsight = await getGeminiInsight(
      {
        totalTrades,
        wins,
        losses,
        winRate,
        netProfit,
        grossProfit,
        grossLoss,
        profitFactor,
        bestTrade,
        worstTrade,
        avgProfit,
        mostActive,
        mostProfit,
        reportType,
      },
      formattedTrades
    );

    // Kalkulasi variabel sentiment untuk template (hindari logic JS di EJS)
    const sentiment = geminiInsight.sentiment;
    const sentimentGradient =
      sentiment === 'positive' ? 'linear-gradient(135deg, #0f4c2a 0%, #1a6b3a 100%)'
      : sentiment === 'warning'  ? 'linear-gradient(135deg, #4a3000 0%, #6b4500 100%)'
      : sentiment === 'critical' ? 'linear-gradient(135deg, #4a0000 0%, #6b1a1a 100%)'
      :                            'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)';
    const sentimentAccent =
      sentiment === 'positive' ? '#22c55e'
      : sentiment === 'warning'  ? '#f59e0b'
      : sentiment === 'critical' ? '#ef4444'
      :                            '#818cf8';
    const sentimentLabel =
      sentiment === 'positive' ? '✅ Positif'
      : sentiment === 'warning'  ? '⚠️ Waspada'
      : sentiment === 'critical' ? '🚨 Kritis'
      :                            '🔵 Netral';

    const stats = {
      totalTrades,
      wins,
      losses,
      winRate,
      grossProfit,
      grossLoss,
      netProfit,
      avgProfit,
      profitFactor,
      bestTrade,
      worstTrade,
      mostActive,
      mostProfit,
      performanceLevel,
      performanceColor,
      // AI-powered insight (menggantikan analisa statis)
      aiInsight: geminiInsight,
      // Variabel sentiment siap pakai untuk template
      sentimentGradient,
      sentimentAccent,
      sentimentLabel,
    };

    // =====================================================
    // Report Title
    // =====================================================
    let reportTitle = '';
    if (reportType === 'DAILY')    reportTitle = `Laporan Harian — ${format(dateStart, 'dd MMM yyyy')}`;
    else if (reportType === 'WEEKLY')  reportTitle = `Laporan Mingguan`;
    else if (reportType === 'MONTHLY') reportTitle = `Laporan Bulanan — ${format(dateStart, 'MMMM yyyy')}`;
    else if (reportType === 'YEARLY')  reportTitle = `Laporan Tahunan — ${format(dateStart, 'yyyy')}`;
    else if (reportType === 'SHUTDOWN') reportTitle = `Laporan Sesi Manual`;

    // =====================================================
    // 3. Render HTML
    // =====================================================
    const templatePath = path.join(__dirname, 'templates', 'reportTemplate.ejs');

    const sessionStart = format(dateStart, 'dd MMM yyyy, HH:mm');
    const sessionEnd   = format(dateEnd,   'dd MMM yyyy, HH:mm');
    const periodRange  = `${sessionStart} → ${sessionEnd}`;

    const htmlString = await ejs.renderFile(templatePath, {
      reportType,
      reportTitle,
      periodRange,
      sessionStart,
      sessionEnd,
      currentDate: format(new Date(), 'dd MMMM yyyy HH:mm'),
      stats,
      trades: formattedTrades,
    });

    // =====================================================
    // 4. Generate PDF via Puppeteer
    // =====================================================
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: 'load' });
    await new Promise(resolve => setTimeout(resolve, 1500));

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });

    await browser.close();

    // =====================================================
    // 5. Upload to Supabase Storage
    // =====================================================
    const fileName = `Report_${reportType}_${Date.now()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from('pdf_reports')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadError) {
      console.error('[PDF] Supabase Upload Error:', uploadError.message);
      throw uploadError;
    }

    const { data: publicUrlData } = supabase.storage.from('pdf_reports').getPublicUrl(fileName);
    const publicUrl = publicUrlData.publicUrl;

    // =====================================================
    // 6. Save to report_history
    // =====================================================
    await supabase.from('report_history').insert({
      report_type: reportType,
      report_date: dateStart.toISOString().split('T')[0],
      file_url: publicUrl,
      total_trades: totalTrades,
      win_rate: winRate,
      total_profit: netProfit,
    });

    // =====================================================
    // 7. Send to WA — caption lebih informatif
    // =====================================================
    const perfEmoji = performanceColor === 'green' ? '🟢' : performanceColor === 'yellow' ? '🟡' : '🔴';
    const profitSign = netProfit >= 0 ? '+' : '';

    const caption =
      `📊 *${reportTitle}*\n` +
      `🕐 Sesi: ${sessionStart} → ${sessionEnd}\n\n` +
      `${perfEmoji} *${performanceLevel}*\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🎯 Total Trade  : ${totalTrades}\n` +
      `✅ Profit       : ${wins} trade\n` +
      `❌ Loss         : ${losses} trade\n` +
      `📈 Win Rate     : ${winRate.toFixed(1)}%\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `💰 Gross Profit : $${grossProfit.toFixed(2)}\n` +
      `💸 Gross Loss   : -$${grossLoss.toFixed(2)}\n` +
      `🏦 Net P&L      : ${profitSign}$${netProfit.toFixed(2)}\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `_Laporan PDF lengkap terlampir._`;

    await sock.sendMessage(groupJid, {
      document: Buffer.from(pdfBuffer),
      mimetype: 'application/pdf',
      fileName: `Engulfing_${reportType}_Report.pdf`,
      caption,
    });

    console.log(`[PDF] ${reportType} report sent successfully!`);
    return true;
  } catch (error) {
    console.error(`[PDF] Failed to generate/send ${reportType} report:`, error);
    return false;
  }
}
