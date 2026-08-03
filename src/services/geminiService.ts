// =====================================================
// services/geminiService.ts
// Class-based Gemini AI Service — singleton pattern.
// Provides Dual-Strategy AI Trading Insights for PDF Reports.
// =====================================================

import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

// =====================================================
// Shared Type Definitions
// =====================================================

export interface StrategySubInsight {
  summary: string;
  observations: string[];
  recommendation: string;
}

export interface GeminiInsight {
  summary: string;
  observations: string[];
  recommendation: string;
  sentiment: 'positive' | 'neutral' | 'warning' | 'critical';
  engulfingAnalysis?: StrategySubInsight;
  rcsAnalysis?: StrategySubInsight;
}

export interface EngulfingStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number;
  mostActive: { sym: string; count: number; wins: number } | null;
}

export interface RCSStats {
  totalCycles: number;
  op1Hits: number;
  op2ReentryHits: number;
  op3SlHits: number;
  freezeCount: number;
  recoveryRate: number;
  netProfit: number;
}

export interface CombinedStats {
  reportType: string;
  totalExecutions: number;
  totalNetProfit: number;
  combinedWinRate: number;
  combinedProfitFactor: number;
  bestTrade: number;
  worstTrade: number;
}

export interface TradeDetail {
  strategy: 'ENGULFING' | 'RCS';
  symbol: string;
  mode: string;
  result: string;
  profit: number;
  engulf_ratio?: number;
  timeframe?: string;
  formattedTime?: string;
}

// Backward-compatible TradeStats interface
export interface TradeStats extends CombinedStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  avgProfit: number;
  mostActive: { sym: string; count: number; wins: number } | null;
  mostProfit: { sym: string; profit: number } | null;
}

// =====================================================
// GeminiService Class
// =====================================================

export class GeminiService {
  private genAI: GoogleGenerativeAI | null = null;
  private model: GenerativeModel | null = null;
  private modelName: string;

  constructor() {
    this.modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    if (process.env.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      this.model = this.genAI.getGenerativeModel({ model: this.modelName });
      console.log(`[Gemini] ✅ Service initialized (model: ${this.modelName})`);
    } else {
      console.warn('[Gemini] ⚠️ GEMINI_API_KEY tidak tersedia — fallback mode aktif');
    }
  }

  /** Cek apakah Gemini API tersedia */
  get isAvailable(): boolean {
    return this.model !== null;
  }

  /**
   * Generate Dual Strategy AI insight dari trading stats.
   */
  async getDualInsight(
    combined: CombinedStats,
    engulfing: EngulfingStats,
    rcs: RCSStats,
    trades: TradeDetail[]
  ): Promise<GeminiInsight> {
    if (!this.isAvailable) {
      return this.buildFallbackInsight(combined, engulfing, rcs);
    }

    try {
      const prompt = this.buildDualPrompt(combined, engulfing, rcs, trades);
      const result = await this.model!.generateContent(prompt);
      const responseText = result.response.text().trim();

      const parsed = this.parseResponse(responseText);
      console.log('[Gemini] Dual-Strategy AI insight berhasil digenerate.');
      return parsed;
    } catch (err) {
      console.error('[Gemini] Error mendapatkan insight, pakai fallback:', err);
      return this.buildFallbackInsight(combined, engulfing, rcs);
    }
  }

  /**
   * Legacy method for backward compatibility
   */
  async getInsight(stats: TradeStats, trades: TradeDetail[]): Promise<GeminiInsight> {
    const dummyEngulfing: EngulfingStats = {
      totalTrades: stats.totalTrades || 0,
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      winRate: stats.winRate || 0,
      grossProfit: stats.grossProfit || 0,
      grossLoss: stats.grossLoss || 0,
      netProfit: stats.netProfit || 0,
      profitFactor: stats.profitFactor || 0,
      mostActive: stats.mostActive || null
    };

    const dummyRCS: RCSStats = {
      totalCycles: 0,
      op1Hits: 0,
      op2ReentryHits: 0,
      op3SlHits: 0,
      freezeCount: 0,
      recoveryRate: 0,
      netProfit: 0
    };

    return this.getDualInsight(stats, dummyEngulfing, dummyRCS, trades);
  }

  // =====================================================
  // Private Methods
  // =====================================================

  private parseResponse(responseText: string): GeminiInsight {
    const cleanedText = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed: GeminiInsight = JSON.parse(cleanedText);

    if (!parsed.summary || !parsed.recommendation) {
      throw new Error('Response Gemini tidak lengkap');
    }

    return parsed;
  }

  private buildDualPrompt(
    combined: CombinedStats,
    engulfing: EngulfingStats,
    rcs: RCSStats,
    trades: TradeDetail[]
  ): string {
    const tradeDetails = trades.slice(0, 25).map((t, i) =>
      `  ${i + 1}. [${t.formattedTime || '?'}] [${t.strategy}] ${t.symbol} ${t.mode} — ${t.result} (${t.profit >= 0 ? '+' : ''}$${(t.profit || 0).toFixed(2)})`
    ).join('\n');

    return `Kamu adalah Quant Trading & Risk Management Analyst senior. 
Analisa data portofolio trading berikut yang mengoperasikan 2 strategi trading otomatis MetaTrader 5:
1. TUYUL MALING (Strategi Engulfing Pattern Price Action)
2. TUYUL COPET (Strategi Reversal Candle System / RCS dengan OP2 Limit Reentry & Freeze Recovery)

═══════════════════════════════════════════
📊 OVERALL PORTFOLIO METRICS (${combined.reportType})
═══════════════════════════════════════════
• Total Eksekusi  : ${combined.totalExecutions}
• Net P&L Combined: ${combined.totalNetProfit >= 0 ? '+' : ''}$${combined.totalNetProfit.toFixed(2)}
• Win Rate Combined: ${combined.combinedWinRate.toFixed(1)}%
• Profit Factor   : ${combined.combinedProfitFactor === 999 ? '∞' : combined.combinedProfitFactor.toFixed(2)}x
• Best Trade      : +$${combined.bestTrade.toFixed(2)}
• Worst Trade     : $${combined.worstTrade.toFixed(2)}

═══════════════════════════════════════════
🤖 STRATEGI 1: TUYUL MALING (ENGULFING PATTERN)
═══════════════════════════════════════════
• Total Trades    : ${engulfing.totalTrades}
• Win / Loss      : ${engulfing.wins}W / ${engulfing.losses}L (Win Rate: ${engulfing.winRate.toFixed(1)}%)
• Gross Profit    : +$${engulfing.grossProfit.toFixed(2)}
• Gross Loss      : -$${engulfing.grossLoss.toFixed(2)}
• Net Profit      : ${engulfing.netProfit >= 0 ? '+' : ''}$${engulfing.netProfit.toFixed(2)}
• Profit Factor   : ${engulfing.profitFactor === 999 ? '∞' : engulfing.profitFactor.toFixed(2)}x
• Pair Teraktif   : ${engulfing.mostActive ? `${engulfing.mostActive.sym} (${engulfing.mostActive.count} trade)` : 'N/A'}

═══════════════════════════════════════════
🤖 STRATEGI 2: TUYUL COPET (REVERSAL CANDLE SYSTEM / RCS)
═══════════════════════════════════════════
• Total Siklus    : ${rcs.totalCycles}
• OP1 Hits        : ${rcs.op1Hits}
• OP2 Reentry Hits: ${rcs.op2ReentryHits}
• OP3 SL / Hedge  : ${rcs.op3SlHits}
• Freeze Count    : ${rcs.freezeCount}
• Recovery Rate   : ${rcs.recoveryRate.toFixed(1)}%
• Net Profit      : ${rcs.netProfit >= 0 ? '+' : ''}$${rcs.netProfit.toFixed(2)}

📋 SAMPEL LOG TRANSAKSI MENTAH:
${tradeDetails || '  (tidak ada data trade)'}

Berikan analisa tajam, profesional, jujur, dan actionable dalam format JSON berikut (HANYA JSON, tanpa markdown codeblock):
{
  "summary": "Narasi analisa portofolio gabungan (2-3 kalimat tajam menceritakan performa akumulasi).",
  "observations": [
    "Pengamatan 1 tentang dinamika portofolio",
    "Pengamatan 2 tentang manajemen risiko",
    "Pengamatan 3 tentang korelasi atau performa pair"
  ],
  "recommendation": "Rekomendasi eksekutif utama untuk pengoptimalan sesi berikutnya.",
  "sentiment": "positive|neutral|warning|critical",
  "engulfingAnalysis": {
    "summary": "Analisa performa strategi Engulfing (Tuyul Maling).",
    "observations": ["Pengamatan kualitatif sinyal engulfing", "Kualitas trend & EMA alignment"],
    "recommendation": "Saran optimasi parameter Engulfing."
  },
  "rcsAnalysis": {
    "summary": "Analisa performa strategi RCS (Tuyul Copet).",
    "observations": ["Pengamatan efisiensi OP2 Hedge Reentry", "Performa Freeze & Recovery"],
    "recommendation": "Saran optimasi parameter RCS."
  }
}
Gunakan Bahasa Indonesia profesional.`;
  }

  private buildFallbackInsight(
    combined: CombinedStats,
    engulfing: EngulfingStats,
    rcs: RCSStats
  ): GeminiInsight {
    const isNetProfit = combined.totalNetProfit >= 0;
    const sentiment: GeminiInsight['sentiment'] = isNetProfit ? (combined.combinedWinRate >= 50 ? 'positive' : 'neutral') : 'warning';

    return {
      summary: `Laporan portofolio ${combined.reportType.toLowerCase()} mencatatkan ${combined.totalExecutions} total eksekusi dengan hasil PnL akumulasi $${combined.totalNetProfit.toFixed(2)}.`,
      observations: [
        `Strategi Engulfing (Tuyul Maling) berkontribusi PnL $${engulfing.netProfit.toFixed(2)} dari ${engulfing.totalTrades} transaksi (Win Rate: ${engulfing.winRate.toFixed(1)}%).`,
        `Strategi RCS (Tuyul Copet) berkontribusi PnL $${rcs.netProfit.toFixed(2)} dari ${rcs.totalCycles} siklus trading.`,
        `Profit Factor portofolio gabungan berada di level ${combined.combinedProfitFactor.toFixed(2)}x.`
      ],
      recommendation: isNetProfit
        ? 'Pertahankan parameter strategi yang ada dan terus pantau rasio drawdown.'
        : 'Evaluasi jarak EMA 20 dan jam aktif trading untuk mengurangi entry berisiko.',
      sentiment,
      engulfingAnalysis: {
        summary: `Tuyul Maling mencatatkan Win Rate ${engulfing.winRate.toFixed(1)}%.`,
        observations: [`Total ${engulfing.wins} win dan ${engulfing.losses} loss.`],
        recommendation: 'Jaga filter ketebalan body candle.'
      },
      rcsAnalysis: {
        summary: `Tuyul Copet menyelesaikan ${rcs.totalCycles} siklus dengan Net PnL $${rcs.netProfit.toFixed(2)}.`,
        observations: [`OP2 Reentry tersentuh sebanyak ${rcs.op2ReentryHits} kali.`],
        recommendation: 'Pastikan Open C1 tetap di sisi benar EMA 20.'
      }
    };
  }
}

export const geminiService = new GeminiService();
export const getGeminiInsight = (stats: TradeStats, trades: TradeDetail[]) =>
  geminiService.getInsight(stats, trades);
