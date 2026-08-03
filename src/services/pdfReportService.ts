// =====================================================
// services/pdfReportService.ts
// Class-based PDF Report Service — Dual Strategy Enabled.
// Decomposed & Modularized.
// =====================================================

import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import { format, subHours } from 'date-fns';
import { supabase } from './supabaseClient';
import {
  geminiService,
  GeminiInsight,
  CombinedStats,
  EngulfingStats,
  RCSStats,
  TradeDetail
} from './geminiService';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class PdfReportService {

  /**
   * Public API — entry point utama.
   * Generate dual strategy report PDF, upload ke Supabase, kirim ke WA.
   */
  async generateAndSend(
    sock: any,
    reportType: string,
    groupJid: string,
    dateStart: Date,
    dateEnd: Date,
  ): Promise<boolean> {
    try {
      console.log(`[PDF] Generating Dual-Strategy ${reportType} report...`);
      console.log(`[PDF] Period: ${dateStart.toISOString()} → ${dateEnd.toISOString()}`);

      // 1. Fetch raw trades & RCS logs from Supabase
      const { engulfingTrades, rcsTrades } = await this.fetchDualStrategyData(dateStart, dateEnd);

      // 2. Format trade details
      const allTrades: TradeDetail[] = this.formatAllTrades(engulfingTrades, rcsTrades);

      // 3. Calculate 3-tier stats
      const { combined, engulfing, rcs } = this.calculateDualStats(engulfingTrades, rcsTrades, reportType);

      // 4. Performance level
      const performance = this.getPerformanceLevel(combined.combinedWinRate, combined.totalNetProfit, combined.totalExecutions);

      // 5. Gemini Dual-Strategy AI Insight
      console.log('[PDF] Meminta Dual-Strategy Insight dari Gemini AI...');
      const geminiInsight = await geminiService.getDualInsight(combined, engulfing, rcs, allTrades);

      // 6. Sentiment visuals
      const sentimentVisuals = this.getSentimentVisuals(geminiInsight.sentiment);

      // 7. Report title
      const reportTitle = this.getReportTitle(reportType, dateStart);

      const sessionStart = format(dateStart, 'dd MMM yyyy, HH:mm');
      const sessionEnd = format(dateEnd, 'dd MMM yyyy, HH:mm');
      const periodRange = `${sessionStart} → ${sessionEnd}`;

      // 8. Render HTML string via EJS
      const htmlString = await this.renderHtml({
        reportType,
        reportTitle,
        periodRange,
        sessionStart,
        sessionEnd,
        currentDate: format(new Date(), 'dd MMMM yyyy HH:mm'),
        stats: {
          combined,
          engulfing,
          rcs,
          performanceLevel: performance.label,
          performanceColor: performance.color,
          aiInsight: geminiInsight,
          ...sentimentVisuals,
        },
        trades: allTrades,
      });

      // 9. Generate PDF via Puppeteer
      const pdfBuffer = await this.renderPdf(htmlString);

      // 10. Upload to Supabase Storage
      const fileName = `Report_DualStrategy_${reportType}_${Date.now()}.pdf`;
      const publicUrl = await this.uploadToStorage(fileName, pdfBuffer);

      // 11. Save to report_history
      await this.saveReportHistory(reportType, dateStart, publicUrl, combined);

      // 12. Send to WhatsApp
      await this.sendToWhatsApp(sock, groupJid, pdfBuffer, reportType, reportTitle, combined, performance, sessionStart, sessionEnd);

      console.log(`[PDF] ${reportType} Dual-Strategy report sent successfully!`);
      return true;
    } catch (error) {
      console.error(`[PDF] Failed to generate/send ${reportType} report:`, error);
      return false;
    }
  }

  // =====================================================
  // Private Data Fetching & Calculations
  // =====================================================

  private async fetchDualStrategyData(dateStart: Date, dateEnd: Date): Promise<{ engulfingTrades: any[]; rcsTrades: any[] }> {
    // 1. Fetch Engulfing Trades
    const { data: engulfingTrades } = await supabase
      .from('trade_deep_analytics_view')
      .select('*')
      .gte('trade_created_at', dateStart.toISOString())
      .lt('trade_created_at', dateEnd.toISOString())
      .order('trade_created_at', { ascending: true });

    // 2. Fetch RCS Results from wa_outbox
    const { data: rcsOutbox } = await supabase
      .from('wa_outbox')
      .select('*')
      .eq('event_type', 'RCS_RESULT')
      .gte('created_at', dateStart.toISOString())
      .lt('created_at', dateEnd.toISOString())
      .order('created_at', { ascending: true });

    const rcsTrades: any[] = [];
    if (rcsOutbox) {
      for (const row of rcsOutbox) {
        const msg = row.message || '';
        // Extract PnL: Closed PnL: *$5.00*
        const profitMatch = msg.match(/Closed PnL:\s*\*?\$?\s*(-?[\d.]+)\*?/i);
        const profit = profitMatch ? parseFloat(profitMatch[1]) : 0.0;
        const symbolMatch = msg.match(/Symbol:\s*([\w-]+)/i);
        const symbol = symbolMatch ? symbolMatch[1] : 'XAUUSD';
        const infoMatch = msg.match(/Info:\s*([^\n]+)/i);
        const info = infoMatch ? infoMatch[1].trim() : 'Siklus Selesai';

        rcsTrades.push({
          symbol,
          info,
          profit,
          created_at: row.created_at,
          result: profit >= 0 ? 'PROFIT' : 'LOSS'
        });
      }
    }

    return {
      engulfingTrades: engulfingTrades || [],
      rcsTrades
    };
  }

  private formatAllTrades(engulfingTrades: any[], rcsTrades: any[]): TradeDetail[] {
    const formatted: TradeDetail[] = [];

    for (const t of engulfingTrades) {
      formatted.push({
        strategy: 'ENGULFING',
        symbol: t.symbol || 'XAUUSD',
        mode: t.mode || 'BUY',
        result: t.result || (t.profit >= 0 ? 'PROFIT' : 'LOSS'),
        profit: t.profit || 0.0,
        engulf_ratio: t.engulf_ratio,
        timeframe: t.timeframe || 'M5',
        formattedTime: t.entry_time ? format(subHours(new Date(t.entry_time), 3), 'dd MMM HH:mm') : '-'
      });
    }

    for (const r of rcsTrades) {
      formatted.push({
        strategy: 'RCS',
        symbol: r.symbol || 'XAUUSD',
        mode: r.info || 'RCS Cycle',
        result: r.result,
        profit: r.profit,
        formattedTime: format(new Date(r.created_at), 'dd MMM HH:mm')
      });
    }

    return formatted.sort((a, b) => (a.formattedTime || '').localeCompare(b.formattedTime || ''));
  }

  private calculateDualStats(engulfingTrades: any[], rcsTrades: any[], reportType: string): { combined: CombinedStats; engulfing: EngulfingStats; rcs: RCSStats } {
    // 1. Engulfing Stats
    let eWins = 0, eLosses = 0, eGrossProfit = 0, eGrossLoss = 0;
    const symbolMap: Record<string, { profit: number; count: number; wins: number }> = {};

    for (const t of engulfingTrades) {
      const p = t.profit || 0;
      if (t.result === 'PROFIT' || p >= 0) {
        eWins++;
        eGrossProfit += p;
      } else {
        eLosses++;
        eGrossLoss += Math.abs(p);
      }
      const sym = t.symbol || 'XAUUSD';
      if (!symbolMap[sym]) symbolMap[sym] = { profit: 0, count: 0, wins: 0 };
      symbolMap[sym].profit += p;
      symbolMap[sym].count++;
      if (p >= 0) symbolMap[sym].wins++;
    }

    const eTotal = engulfingTrades.length;
    const eNetProfit = eGrossProfit - eGrossLoss;
    const eWinRate = eTotal > 0 ? (eWins / eTotal) * 100 : 0;
    const eProfitFactor = eGrossLoss > 0 ? eGrossProfit / eGrossLoss : eGrossProfit > 0 ? 999 : 0;
    const symbolList = Object.entries(symbolMap).map(([sym, s]) => ({ sym, ...s }));
    const eMostActive = symbolList.sort((a, b) => b.count - a.count)[0] || null;

    const engulfing: EngulfingStats = {
      totalTrades: eTotal,
      wins: eWins,
      losses: eLosses,
      winRate: eWinRate,
      grossProfit: eGrossProfit,
      grossLoss: eGrossLoss,
      netProfit: eNetProfit,
      profitFactor: eProfitFactor,
      mostActive: eMostActive
    };

    // 2. RCS Stats
    let rcsNetProfit = 0, op1Hits = 0, op2ReentryHits = 0, op3SlHits = 0, freezeCount = 0;
    for (const r of rcsTrades) {
      const p = r.profit || 0;
      rcsNetProfit += p;
      if (r.info.includes('OP2')) op2ReentryHits++;
      else if (r.info.includes('OP3') || r.info.includes('SL')) op3SlHits++;
      else op1Hits++;
      if (r.info.includes('Unfreeze') || r.info.includes('FREEZE')) freezeCount++;
    }

    const rcsTotalCycles = rcsTrades.length;
    const rcsRecoveryRate = freezeCount > 0 ? 100.0 : 0.0;

    const rcs: RCSStats = {
      totalCycles: rcsTotalCycles,
      op1Hits,
      op2ReentryHits,
      op3SlHits,
      freezeCount,
      recoveryRate: rcsRecoveryRate,
      netProfit: rcsNetProfit
    };

    // 3. Combined Stats
    const totalExecutions = eTotal + rcsTotalCycles;
    const totalNetProfit = eNetProfit + rcsNetProfit;
    const totalWins = eWins + rcsTrades.filter(r => r.profit >= 0).length;
    const combinedWinRate = totalExecutions > 0 ? (totalWins / totalExecutions) * 100 : 0;
    const combinedProfitFactor = (eGrossLoss > 0) ? (eGrossProfit + Math.max(0, rcsNetProfit)) / eGrossLoss : 999;

    let bestTrade = 0, worstTrade = 0;
    for (const t of engulfingTrades) {
      if ((t.profit || 0) > bestTrade) bestTrade = t.profit;
      if ((t.profit || 0) < worstTrade) worstTrade = t.profit;
    }
    for (const r of rcsTrades) {
      if ((r.profit || 0) > bestTrade) bestTrade = r.profit;
      if ((r.profit || 0) < worstTrade) worstTrade = r.profit;
    }

    const combined: CombinedStats = {
      reportType,
      totalExecutions,
      totalNetProfit,
      combinedWinRate,
      combinedProfitFactor,
      bestTrade,
      worstTrade
    };

    return { combined, engulfing, rcs };
  }

  private getPerformanceLevel(winRate: number, netProfit: number, totalExecutions: number) {
    if (totalExecutions === 0) return { label: 'TIDAK ADA DATA', color: 'gray' as const };
    if (winRate >= 60 && netProfit > 0) return { label: 'PERFORMA BAGUS', color: 'green' as const };
    if (winRate >= 45) return { label: 'PERFORMA CUKUP', color: 'yellow' as const };
    return { label: 'PERLU EVALUASI', color: 'red' as const };
  }

  private getSentimentVisuals(sentiment: string) {
    const map: Record<string, { gradient: string; accent: string; label: string }> = {
      positive: { gradient: 'linear-gradient(135deg, #0f4c2a 0%, #1a6b3a 100%)', accent: '#22c55e', label: '✅ Positif' },
      warning: { gradient: 'linear-gradient(135deg, #4a3000 0%, #6b4500 100%)', accent: '#f59e0b', label: '⚠️ Waspada' },
      critical: { gradient: 'linear-gradient(135deg, #4a0000 0%, #6b1a1a 100%)', accent: '#ef4444', label: '🚨 Kritis' },
    };
    return map[sentiment] || { gradient: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)', accent: '#818cf8', label: '🔵 Netral' };
  }

  private getReportTitle(reportType: string, dateStart: Date): string {
    switch (reportType) {
      case 'DAILY': return `Laporan Harian Portofolio — ${format(dateStart, 'dd MMM yyyy')}`;
      case 'WEEKLY': return 'Laporan Mingguan Portofolio';
      case 'MONTHLY': return `Laporan Bulanan Portofolio — ${format(dateStart, 'MMMM yyyy')}`;
      case 'YEARLY': return `Laporan Tahunan Portofolio — ${format(dateStart, 'yyyy')}`;
      case 'SHUTDOWN': return 'Laporan Sesi Manual Bot';
      default: return `Laporan ${reportType}`;
    }
  }

  private async renderHtml(data: Record<string, any>): Promise<string> {
    const templatePath = path.join(__dirname, '..', 'templates', 'reportTemplate.ejs');
    return ejs.renderFile(templatePath, data);
  }

  private async renderPdf(htmlString: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(htmlString, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
      });
      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  }

  private async uploadToStorage(fileName: string, pdfBuffer: Buffer): Promise<string> {
    const { data, error } = await supabase.storage
      .from('engulfing')
      .upload(`reports/${fileName}`, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (error) {
      console.error('[PDF] Storage Upload Error:', error);
      return '';
    }

    const { data: publicUrlData } = supabase.storage
      .from('engulfing')
      .getPublicUrl(data.path);

    return publicUrlData.publicUrl;
  }

  private async saveReportHistory(reportType: string, dateStart: Date, pdfUrl: string, combined: CombinedStats) {
    try {
      await supabase.from('report_history').insert({
        report_type: reportType,
        period_start: dateStart.toISOString(),
        pdf_url: pdfUrl,
        total_trades: combined.totalExecutions,
        net_profit: combined.totalNetProfit,
        win_rate: combined.combinedWinRate,
      });
    } catch (e) {
      console.warn('[PDF] Failed to save report history:', e);
    }
  }

  private async sendToWhatsApp(
    sock: any,
    groupJid: string,
    pdfBuffer: Buffer,
    reportType: string,
    reportTitle: string,
    combined: CombinedStats,
    performance: { label: string },
    sessionStart: string,
    sessionEnd: string,
  ) {
    const pnlPrefix = combined.totalNetProfit >= 0 ? '+' : '';
    const caption =
      `📄 *${reportTitle.toUpperCase()}*\n` +
      `📊 Performa Portofolio: *${performance.label}*\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📅 Periode : ${sessionStart} → ${sessionEnd}\n` +
      `📈 Total Eksekusi : ${combined.totalExecutions}\n` +
      `💰 Net P&L Combined : *${pnlPrefix}$${combined.totalNetProfit.toFixed(2)}*\n` +
      `🎯 Win Rate Combined : ${combined.combinedWinRate.toFixed(1)}%\n` +
      `⚖️ Profit Factor : ${combined.combinedProfitFactor === 999 ? '∞' : combined.combinedProfitFactor.toFixed(2)}x\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `_File PDF memuat analisa Gemini AI & breakdown dual-strategi (Tuyul Maling & Tuyul Copet)_`;

    await sock.sendMessage(groupJid, {
      document: pdfBuffer,
      mimetype: 'application/pdf',
      fileName: `Portfolio_Report_${reportType}_${format(new Date(), 'yyyyMMdd')}.pdf`,
      caption,
    });
  }
}

export const pdfReportService = new PdfReportService();
export const generateAndSendPDF = (
  sock: any,
  reportType: string,
  groupJid: string,
  dateStart: Date,
  dateEnd: Date,
) => pdfReportService.generateAndSend(sock, reportType, groupJid, dateStart, dateEnd);
