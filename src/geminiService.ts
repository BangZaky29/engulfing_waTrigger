import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../.env') });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export interface GeminiInsight {
  summary: string;       // Narasi utama dari sudut pandang AI
  observations: string[]; // Poin-poin pengamatan spesifik
  recommendation: string; // Rekomendasi strategis dari AI
  sentiment: 'positive' | 'neutral' | 'warning' | 'critical'; // Sentimen keseluruhan
}

export async function getGeminiInsight(stats: {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
  avgProfit: number;
  mostActive: { sym: string; count: number; wins: number } | null;
  mostProfit: { sym: string; profit: number } | null;
  reportType: string;
  sessionDuration?: string;
}, trades: Array<{
  symbol: string;
  mode: string;
  result: string;
  profit: number;
  engulf_ratio?: number;
  timeframe?: string;
  formattedTime?: string;
}>): Promise<GeminiInsight> {

  // Fallback jika API key tidak tersedia
  if (!process.env.GEMINI_API_KEY) {
    return buildFallbackInsight(stats);
  }

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });

    // Bangun context data trading yang detail untuk Gemini
    const tradeDetails = trades.slice(0, 20).map((t, i) =>
      `  ${i + 1}. [${t.formattedTime || '?'}] ${t.symbol} ${t.mode} — Rasio Engulfing: ${t.engulf_ratio ? t.engulf_ratio.toFixed(2) + 'x' : 'N/A'} — ${t.result} (${t.profit >= 0 ? '+' : ''}$${(t.profit || 0).toFixed(2)})`
    ).join('\n');

    const winRateContext = stats.winRate >= 65 ? 'tinggi (bagus)' : stats.winRate >= 45 ? 'sedang' : 'rendah (perlu perhatian)';
    const pfContext = stats.profitFactor >= 1.5 ? 'sangat sehat' : stats.profitFactor >= 1 ? 'marginal' : 'rugi (di bawah 1)';

    const prompt = `Kamu adalah seorang analis trading berpengalaman dengan keahlian khusus dalam Price Action dan strategi Engulfing Pattern di forex/komoditas. 
Analisa data trading berikut dari sudut pandangmu sebagai AI, berikan insight yang bermakna, jujur, dan actionable — bukan sekedar ringkasan angka.

═══════════════════════════════════════════
📊 DATA LAPORAN: ${stats.reportType}
═══════════════════════════════════════════
• Total Trade     : ${stats.totalTrades}
• Win / Loss      : ${stats.wins}W / ${stats.losses}L
• Win Rate        : ${stats.winRate.toFixed(1)}% (${winRateContext})
• Net P&L         : ${stats.netProfit >= 0 ? '+' : ''}$${stats.netProfit.toFixed(2)}
• Gross Profit    : +$${stats.grossProfit.toFixed(2)}
• Gross Loss      : -$${stats.grossLoss.toFixed(2)}
• Profit Factor   : ${stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2)}x (${pfContext})
• Trade Terbaik   : +$${stats.bestTrade.toFixed(2)}
• Trade Terburuk  : $${stats.worstTrade.toFixed(2)}
• Avg per Trade   : ${stats.avgProfit >= 0 ? '+' : ''}$${stats.avgProfit.toFixed(2)}
• Pair Paling Aktif : ${stats.mostActive ? `${stats.mostActive.sym} (${stats.mostActive.count} trade, ${stats.mostActive.wins} profit)` : 'N/A'}
• Pair Paling Profit: ${stats.mostProfit ? `${stats.mostProfit.sym} ($${stats.mostProfit.profit.toFixed(2)})` : 'N/A'}

📋 DETAIL TRADE:
${tradeDetails || '  (tidak ada data trade)'}
═══════════════════════════════════════════

Berikan analisa dalam format JSON yang tepat berikut (HANYA JSON, tanpa markdown, tanpa teks tambahan di luar JSON):
{
  "summary": "Narasi analisa utamamu (2-3 kalimat, pakai bahasa yang insightful, bukan sekedar restate angka). Ceritakan apa yang sebenarnya terjadi dari sudut pandang AI.",
  "observations": [
    "Pengamatan spesifik pertama tentang pola, risiko, atau peluang yang kamu lihat",
    "Pengamatan kedua — bisa tentang konsistensi strategi engulfing, timing, atau risk management",
    "Pengamatan ketiga — tentang pair yang ditrading, atau hubungan antara engulf ratio dengan hasil",
    "Pengamatan keempat — insight lain yang menurutmu penting"
  ],
  "recommendation": "Satu rekomendasi konkret dan spesifik yang bisa langsung diterapkan untuk sesi berikutnya",
  "sentiment": "positive|neutral|warning|critical"
}

Gunakan bahasa Indonesia yang profesional tapi mudah dipahami. Jadilah jujur jika performanya kurang baik.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Parse JSON response dari Gemini
    // Bersihkan markdown code block jika ada
    const cleanedText = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed: GeminiInsight = JSON.parse(cleanedText);

    // Validasi minimal field
    if (!parsed.summary || !parsed.observations || !parsed.recommendation) {
      throw new Error('Response Gemini tidak lengkap');
    }

    console.log('[Gemini] AI insight berhasil digenerate.');
    return parsed;

  } catch (err) {
    console.error('[Gemini] Error mendapatkan insight, pakai fallback:', err);
    return buildFallbackInsight(stats);
  }
}

/**
 * Fallback insight jika Gemini API gagal / tidak tersedia
 */
function buildFallbackInsight(stats: {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  profitFactor: number;
  bestTrade: number;
  worstTrade: number;
  mostActive: { sym: string; count: number; wins: number } | null;
  reportType: string;
}): GeminiInsight {
  let summary = '';
  let sentiment: GeminiInsight['sentiment'] = 'neutral';

  if (stats.totalTrades === 0) {
    summary = 'Tidak ada transaksi yang tercatat pada sesi ini.';
    sentiment = 'neutral';
  } else if (stats.winRate >= 65 && stats.netProfit > 0) {
    summary = `Sesi ${stats.reportType.toLowerCase()} ini menunjukkan performa yang baik dengan win rate ${stats.winRate.toFixed(1)}% dan profit bersih $${stats.netProfit.toFixed(2)}.`;
    sentiment = 'positive';
  } else if (stats.winRate >= 45) {
    summary = `Win rate ${stats.winRate.toFixed(1)}% menunjukkan strategi engulfing cukup valid, namun manajemen risiko perlu dievaluasi.`;
    sentiment = stats.netProfit >= 0 ? 'neutral' : 'warning';
  } else {
    summary = `Win rate ${stats.winRate.toFixed(1)}% berada di bawah threshold. Perlu review kondisi market dan parameter strategy.`;
    sentiment = 'critical';
  }

  const observations: string[] = [];
  if (stats.totalTrades > 0) {
    observations.push(`${stats.wins} dari ${stats.totalTrades} trade menghasilkan profit (${stats.winRate.toFixed(1)}%).`);
    if (stats.profitFactor > 0) {
      observations.push(`Profit Factor ${stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2)}x menunjukkan rasio reward/risk strategy ini.`);
    }
    if (stats.worstTrade < 0) {
      observations.push(`Trade terburuk ($${stats.worstTrade.toFixed(2)}) perlu diperhatikan dalam konteks SL management.`);
    }
    if (stats.mostActive) {
      observations.push(`${stats.mostActive.sym} menjadi pair paling aktif dengan ${stats.mostActive.count} trade.`);
    }
  }

  return {
    summary,
    observations,
    recommendation: stats.netProfit < 0
      ? 'Review konfigurasi SL dan TP — pertimbangkan menaikkan minimum engulf ratio untuk filter sinyal yang lebih berkualitas.'
      : 'Pertahankan parameter yang ada, fokus pada konsistensi eksekusi di sesi berikutnya.',
    sentiment,
  };
}
