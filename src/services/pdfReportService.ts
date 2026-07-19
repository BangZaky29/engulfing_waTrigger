// =====================================================
// services/pdfReportService.ts
// Class-based PDF Report Service — singleton pattern.
// Decomposed dari god function menjadi concern-specific methods.
// =====================================================

import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'path';
import { format, subHours } from 'date-fns';
import { supabase } from './supabaseClient';
import { geminiService, GeminiInsight, TradeStats } from './geminiService';

// =====================================================
// Type Definitions
// =====================================================

interface SymbolAgg {
  sym: string;
  profit: number;
  count: number;
  wins: number;
}

interface ReportStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  avgProfit: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
  mostActive: SymbolAgg | null;
  mostProfit: SymbolAgg | null;
}

interface PerformanceLevel {
  label: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
}

interface SentimentVisuals {
  gradient: string;
  accent: string;
  label: string;
}

// =====================================================
// PdfReportService Class
// =====================================================

export class PdfReportService {

  /**
   * Public API — entry point utama.
   * Generate report PDF, upload ke Supabase, kirim ke WA.
   */
  async generateAndSend(
    sock: any,
    reportType: string,
    groupJid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<boolean> {
    try {
      console.log(`[PDF] Generating ${reportType} report...`);
      console.log(`[PDF] Period: ${dateStart.toISOString()} → ${dateEnd.toISOString()}`);

      // 1. Fetch trades
      const trades = await this.fetchTrades(dateStart, dateEnd);

      // 2. Format trades & calculate stats
      const formattedTrades = this.formatTrades(trades);
      const stats = this.calculateStats(trades, formattedTrades);

      // 3. Performance level
      const performance = this.getPerformanceLevel(stats.winRate, stats.netProfit, stats.totalTrades);

      // 4. Gemini AI Insight
      console.log('[PDF] Meminta insight dari Gemini AI...');
      const geminiInsight = await geminiService.getInsight(
        { ...stats, reportType } as TradeStats,
        formattedTrades,
      );

      // 5. Sentiment visuals
      const sentimentVisuals = this.getSentimentVisuals(geminiInsight.sentiment);

      // 6. Report title
      const reportTitle = this.getReportTitle(reportType, dateStart);

      // 7. Build template data & render HTML
      const templateStats = {
        ...stats,
        performanceLevel: performance.label,
        performanceColor: performance.color,
        aiInsight: geminiInsight,
        ...sentimentVisuals,
      };

      const sessionStart = format(dateStart, 'dd MMM yyyy, HH:mm');
      const sessionEnd = format(dateEnd, 'dd MMM yyyy, HH:mm');
      const periodRange = `${sessionStart} → ${sessionEnd}`;

      const htmlString = await this.renderHtml({
        reportType,
        reportTitle,
        periodRange,
        sessionStart,
        sessionEnd,
        currentDate: format(new Date(), 'dd MMMM yyyy HH:mm'),
        stats: templateStats,
        trades: formattedTrades,
      });

      // 8. Generate PDF
      const pdfBuffer = await this.renderPdf(htmlString);

      // 9. Upload to Supabase Storage
      const fileName = `Report_${reportType}_${Date.now()}.pdf`;
      const publicUrl = await this.uploadToStorage(fileName, pdfBuffer);

      // 10. Save to report_history
      await this.saveReportHistory(reportType, dateStart, publicUrl, stats);

      // 11. Send to WhatsApp
      await this.sendToWhatsApp(sock, groupJid, pdfBuffer, reportType, reportTitle, stats, performance, sessionStart, sessionEnd);

      console.log(`[PDF] ${reportType} report sent successfully!`);
      return true;
    } catch (error) {
      console.error(`[PDF] Failed to generate/send ${reportType} report:`, error);
      return false;
    }
  }

  // =====================================================
  // Private Methods — setiap method 1 concern
  // =====================================================

  /**
   * Fetch trades dari Supabase view berdasarkan date range.
   */
  private async fetchTrades(dateStart: Date, dateEnd: Date): Promise<any[]> {
    const { data: trades, error } = await supabase
      .from('trade_deep_analytics_view')
      .select('*')
      .gte('trade_created_at', dateStart.toISOString())
      .lt('trade_created_at', dateEnd.toISOString())
      .order('trade_created_at', { ascending: true });

    if (error) throw error;
    return trades || [];
  }

  /**
   * Format raw trades — tambah formattedTime.
   */
  private formatTrades(trades: any[]): any[] {
    return trades.map(t => ({
      ...t,
      formattedTime: t.entry_time
        ? format(subHours(new Date(t.entry_time), 3), 'dd MMM HH:mm')
        : '-',
    }));
  }

  /**
   * Hitung statistik dari data trade.
   */
  private calculateStats(trades: any[], _formattedTrades: any[]): ReportStats {
    const totalTrades = trades.length;
    let wins = 0;
    let losses = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let bestTrade = 0;
    let worstTrade = 0;

    const symbolMap: Record<string, { profit: number; count: number; wins: number }> = {};

    for (const t of trades) {
      const profit = t.profit || 0;

      if (t.result === 'PROFIT') {
        wins++;
        grossProfit += profit;
      } else {
        losses++;
        grossLoss += Math.abs(profit);
      }

      if (profit > bestTrade) bestTrade = profit;
      if (profit < worstTrade) worstTrade = profit;

      const sym = t.symbol || 'UNKNOWN';
      if (!symbolMap[sym]) symbolMap[sym] = { profit: 0, count: 0, wins: 0 };
      symbolMap[sym].profit += profit;
      symbolMap[sym].count++;
      if (t.result === 'PROFIT') symbolMap[sym].wins++;
    }

    const netProfit = grossProfit - grossLoss;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgProfit = totalTrades > 0 ? netProfit / totalTrades : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const symbolList: SymbolAgg[] = Object.entries(symbolMap).map(([sym, s]) => ({ sym, ...s }));
    const mostActive = [...symbolList].sort((a, b) => b.count - a.count)[0] || null;
    const mostProfit = [...symbolList].sort((a, b) => b.profit - a.profit)[0] || null;

    return {
      totalTrades, wins, losses, winRate,
      grossProfit, grossLoss, netProfit, avgProfit,
      profitFactor, bestTrade, worstTrade,
      mostActive, mostProfit,
    };
  }

  /**
   * Tentukan performance level berdasarkan win rate & net profit.
   */
  private getPerformanceLevel(winRate: number, netProfit: number, totalTrades: number): PerformanceLevel {
    if (totalTrades === 0) {
      return { label: 'TIDAK ADA DATA', color: 'gray' };
    } else if (winRate >= 65 && netProfit > 0) {
      return { label: 'PERFORMA BAGUS', color: 'green' };
    } else if (winRate >= 45) {
      return { label: 'PERFORMA CUKUP', color: 'yellow' };
    } else {
      return { label: 'PERLU EVALUASI', color: 'red' };
    }
  }

  /**
   * Map sentiment ke visual properties untuk EJS template.
   */
  private getSentimentVisuals(sentiment: string): SentimentVisuals {
    const map: Record<string, SentimentVisuals> = {
      positive: {
        gradient: 'linear-gradient(135deg, #0f4c2a 0%, #1a6b3a 100%)',
        accent: '#22c55e',
        label: '✅ Positif',
      },
      warning: {
        gradient: 'linear-gradient(135deg, #4a3000 0%, #6b4500 100%)',
        accent: '#f59e0b',
        label: '⚠️ Waspada',
      },
      critical: {
        gradient: 'linear-gradient(135deg, #4a0000 0%, #6b1a1a 100%)',
        accent: '#ef4444',
        label: '🚨 Kritis',
      },
    };

    return map[sentiment] || {
      gradient: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
      accent: '#818cf8',
      label: '🔵 Netral',
    };
  }

  /**
   * Generate report title berdasarkan tipe.
   */
  private getReportTitle(reportType: string, dateStart: Date): string {
    switch (reportType) {
      case 'DAILY':    return `Laporan Harian — ${format(dateStart, 'dd MMM yyyy')}`;
      case 'WEEKLY':   return 'Laporan Mingguan';
      case 'MONTHLY':  return `Laporan Bulanan — ${format(dateStart, 'MMMM yyyy')}`;
      case 'YEARLY':   return `Laporan Tahunan — ${format(dateStart, 'yyyy')}`;
      case 'SHUTDOWN': return 'Laporan Sesi Manual';
      default:         return `Laporan ${reportType}`;
    }
  }

  /**
   * Render EJS template ke HTML string.
   */
  private async renderHtml(data: Record<string, any>): Promise<string> {
    const templatePath = path.join(__dirname, '..', 'templates', 'reportTemplate.ejs');
    return ejs.renderFile(templatePath, data);
  }

  /**
   * Render HTML string ke PDF buffer via Puppeteer.
   */
  private async renderPdf(htmlString: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(htmlString, { waitUntil: 'load' });
      await new Promise(resolve => setTimeout(resolve, 1500));

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      });

      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  }

  /**
   * Upload PDF ke Supabase Storage, return public URL.
   */
  private async uploadToStorage(fileName: string, pdfBuffer: Buffer): Promise<string> {
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
    return publicUrlData.publicUrl;
  }

  /**
   * Simpan record ke tabel report_history.
   */
  private async saveReportHistory(
    reportType: string,
    dateStart: Date,
    fileUrl: string,
    stats: ReportStats,
  ): Promise<void> {
    await supabase.from('report_history').insert({
      report_type: reportType,
      report_date: dateStart.toISOString().split('T')[0],
      file_url: fileUrl,
      total_trades: stats.totalTrades,
      win_rate: stats.winRate,
      total_profit: stats.netProfit,
    });
  }

  /**
   * Kirim PDF ke WhatsApp dengan caption informatif.
   */
  private async sendToWhatsApp(
    sock: any,
    groupJid: string,
    pdfBuffer: Buffer,
    reportType: string,
    reportTitle: string,
    stats: ReportStats,
    performance: PerformanceLevel,
    sessionStart: string,
    sessionEnd: string,
  ): Promise<void> {
    const perfEmoji = performance.color === 'green' ? '🟢'
      : performance.color === 'yellow' ? '🟡' : '🔴';
    const profitSign = stats.netProfit >= 0 ? '+' : '';

    const caption =
      `📊 *${reportTitle}*\n` +
      `🕐 Sesi: ${sessionStart} → ${sessionEnd}\n\n` +
      `${perfEmoji} *${performance.label}*\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🎯 Total Trade  : ${stats.totalTrades}\n` +
      `✅ Profit       : ${stats.wins} trade\n` +
      `❌ Loss         : ${stats.losses} trade\n` +
      `📈 Win Rate     : ${stats.winRate.toFixed(1)}%\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `💰 Gross Profit : $${stats.grossProfit.toFixed(2)}\n` +
      `💸 Gross Loss   : -$${stats.grossLoss.toFixed(2)}\n` +
      `🏦 Net P&L      : ${profitSign}$${stats.netProfit.toFixed(2)}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      (stats.mostProfit ? `🏆 Best Pair    : ${stats.mostProfit.sym} (+$${stats.mostProfit.profit.toFixed(2)})\n━━━━━━━━━━━━━━━━━\n\n` : '\n') +
      `_Laporan PDF lengkap terlampir._`;

    await sock.sendMessage(groupJid, {
      document: Buffer.from(pdfBuffer),
      mimetype: 'application/pdf',
      fileName: `Engulfing_${reportType}_Report.pdf`,
      caption,
    });
  }
}

// =====================================================
// Singleton Instance
// =====================================================
export const pdfReportService = new PdfReportService();

// =====================================================
// Backward-compatible function export
// Supaya cron jobs dan index.ts tetap bisa:
//   import { generateAndSendPDF } from '../../services/pdfReportService';
// =====================================================
export const generateAndSendPDF = (
  sock: any,
  reportType: string,
  groupJid: string,
  dateStart: Date,
  dateEnd: Date,
) => pdfReportService.generateAndSend(sock, reportType, groupJid, dateStart, dateEnd);
