// =====================================================
// src/services/goldNewsService.ts
// Service pemantau berita real-time market GOLD/USD (XAU/USD)
// Menggabungkan Google Financial News Wire RSS & Kurasi Gemini AI
// =====================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, GEMINI_MODEL } from '../config/env';
import { fetchWithTimeout } from '../utils/helpers';
import { ForexFactoryEvent } from './forexFactoryService';

export interface GoldNewsItem {
  title: string;
  link: string;
  source: string;
  pubDate: string;
}

export interface GoldMarketAnalysis {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'HIGH VOLATILITY';
  biasEmoji: string;
  headline: string;
  keyFactors: string[];
  goldTradingTips: string;
}

const GOLD_RSS_URL =
  'https://news.google.com/rss/search?q=Gold+USD+XAUUSD+forex+when:24h&hl=en-US&gl=US&ceid=US:en';

/**
 * Fetch berita terhangat 24 jam terakhir seputar XAU/USD & Gold Forex
 */
export async function fetchGoldNews(limit: number = 5): Promise<GoldNewsItem[]> {
  try {
    const res = await fetchWithTimeout(GOLD_RSS_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP Error ${res.status}`);
    }

    const xmlText = await res.text();
    const items: GoldNewsItem[] = [];

    // Simple robust regex XML parser untuk RSS item
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xmlText)) !== null && items.length < limit) {
      const itemContent = match[1];

      const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(itemContent);
      const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(itemContent);
      const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(itemContent);
      const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/.exec(itemContent);

      let title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
      let source = sourceMatch ? sourceMatch[1].trim() : '';

      // Bersihkan pemisah sumber di judul (e.g. "Title - Source")
      if (!source && title.includes(' - ')) {
        const parts = title.split(' - ');
        source = parts.pop() || '';
        title = parts.join(' - ');
      }

      if (title) {
        items.push({
          title,
          link: linkMatch ? linkMatch[1].trim() : '',
          source: source || 'Market Wire',
          pubDate: pubDateMatch ? pubDateMatch[1].trim() : new Date().toUTCString(),
        });
      }
    }

    return items;
  } catch (err: any) {
    console.warn('[GOLD_NEWS] ⚠️ Gagal fetch RSS berita emas:', err?.message || err);
    return [];
  }
}

/**
 * Menganalisa sentimen dan arah market GOLD/USD menggunakan Gemini AI
 */
export async function generateGoldMarketAnalysis(
  todayEvents: ForexFactoryEvent[],
  newsItems: GoldNewsItem[]
): Promise<GoldMarketAnalysis> {
  // Default fallback jika Gemini AI tidak aktif atau error
  const fallbackResult: GoldMarketAnalysis = {
    bias: 'NEUTRAL',
    biasEmoji: '⚖️',
    headline: 'Pasar menantikan rilis data ekonomi AS hari ini',
    keyFactors: [
      'Pergerakan Dolar AS (DXY) dan imbal hasil obligasi AS menjadi katalis utama.',
      'Perhatikan volatilitas menjelang sesi New York.',
    ],
    goldTradingTips: 'Disiplin gunakan Stop Loss dan pantau jadwal rilis berita High Impact.',
  };

  if (!GEMINI_API_KEY) {
    return fallbackResult;
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL || 'gemini-2.5-flash' });

    const highImpactCount = todayEvents.filter(e => e.impact === 'High').length;
    const eventSummary = todayEvents
      .map(e => `- [${e.impact.toUpperCase()}] ${e.title} (Forecast: ${e.forecast || '-'}, Prev: ${e.previous || '-'})`)
      .join('\n');

    const newsSummary = newsItems.map(n => `- ${n.title} (${n.source})`).join('\n');

    const prompt = `
Anda adalah Senior Macro & Gold (XAU/USD) Market Strategist.
Analisa data kalender Forex Factory dan berita terkini berikut untuk menyajikan ringkasan singkat, tajam, dan bermanfaat bagi trader GOLD/USD di grup WhatsApp.

Data Kalender Ekonomi Forex Factory Hari Ini:
${eventSummary || 'Tidak ada berita High/Medium impact hari ini.'}

Headline Berita Pasar Emas Terbaru:
${newsSummary || 'Pasar bergerak stabil.'}

Instruksi Output:
Kembalikan HANYA format JSON valid tanpa tanda backtick markdown atau penjelasan pembuka/penutup.
Format JSON yang wajib diikuti:
{
  "bias": "BULLISH" | "BEARISH" | "NEUTRAL" | "HIGH VOLATILITY",
  "headline": "Satu kalimat ringkas sentimen utama emas hari ini (Bahasa Indonesia)",
  "keyFactors": [
    "Poin faktor 1 (korelasi data AS/Dolar/Yield)",
    "Poin faktor 2 (pergerakan teknikal/sentimen safe-haven)"
  ],
  "goldTradingTips": "1 kalimat himbauan/tips eksekusi untuk trader emas hari ini"
}
`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    // Bersihkan codeblock jika ada
    const cleanedJson = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleanedJson);

    let biasEmoji = '⚖️';
    if (parsed.bias === 'BULLISH') biasEmoji = '🟢';
    else if (parsed.bias === 'BEARISH') biasEmoji = '🔴';
    else if (parsed.bias === 'HIGH VOLATILITY') biasEmoji = '⚡';

    return {
      bias: parsed.bias || 'NEUTRAL',
      biasEmoji,
      headline: parsed.headline || fallbackResult.headline,
      keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors : fallbackResult.keyFactors,
      goldTradingTips: parsed.goldTradingTips || fallbackResult.goldTradingTips,
    };
  } catch (err: any) {
    console.warn('[GOLD_NEWS] ⚠️ Error Gemini AI analysis:', err?.message || err);
    return fallbackResult;
  }
}
