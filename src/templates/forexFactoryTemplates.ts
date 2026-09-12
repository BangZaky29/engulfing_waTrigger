// =====================================================
// src/templates/forexFactoryTemplates.ts
// Format pesan WhatsApp untuk notifikasi Forex Factory & Gold/USD
// =====================================================

import { ForexFactoryEvent, formatToWIB } from '../services/forexFactoryService';
import { GoldMarketAnalysis, GoldNewsItem } from '../services/goldNewsService';

/**
 * Format pesan Daily Morning Briefing (06:30 WIB)
 */
export function formatDailyBriefingMessage(
  events: ForexFactoryEvent[],
  analysis: GoldMarketAnalysis,
  newsItems: GoldNewsItem[]
): string {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);

  const highEvents = events.filter(e => e.impact === 'High');
  const mediumEvents = events.filter(e => e.impact === 'Medium');

  let msg = `🌅 *FOREX FACTORY DAILY BRIEFING*\n`;
  msg += `📅 *${dateStr}*\n`;
  msg += `🎯 Fokus Pasar: *GOLD/USD (XAU/USD)*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // 1. Sentimen AI & Pasar Emas
  msg += `🤖 *OUTLOOK & SENTIMEN EMAS (AI)*\n`;
  msg += `• Sentimen: ${analysis.biasEmoji} *${analysis.bias}*\n`;
  msg += `• *${analysis.headline}*\n`;

  if (analysis.keyFactors && analysis.keyFactors.length > 0) {
    analysis.keyFactors.forEach(f => {
      msg += `  ▫️ ${f}\n`;
    });
  }
  msg += `💡 _Tips: ${analysis.goldTradingTips}_\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // 2. Jadwal Berita Hari Ini
  msg += `📊 *JADWAL BERITA EKONOMI HARI INI*\n`;
  msg += `🔴 High Impact: *${highEvents.length}* | 🟠 Medium Impact: *${mediumEvents.length}*\n\n`;

  if (events.length === 0) {
    msg += `✅ *Tidak ada berita High/Medium impact hari ini.*\n`;
    msg += `Pasar GOLD/USD cenderung bergerak murni berdasarkan struktur teknikal.\n`;
  } else {
    events.forEach(e => {
      const timeWib = formatToWIB(e.event_date);
      const impactIcon = e.impact === 'High' ? '🔴' : '🟠';
      const forecastStr = e.forecast ? e.forecast : '-';
      const prevStr = e.previous ? e.previous : '-';

      msg += `${impactIcon} *${timeWib}* | *${e.title}* (${e.country})\n`;
      msg += `   📈 Forecast: \`${forecastStr}\` | Previous: \`${prevStr}\`\n\n`;
    });
  }

  // 3. Headline Berita Global Terhangat
  if (newsItems.length > 0) {
    msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📰 *HEADLINE PASAR TERBARU:*\n`;
    newsItems.slice(0, 3).forEach((n, idx) => {
      msg += `${idx + 1}. *${n.title}*\n   _Sumber: ${n.source}_\n`;
    });
    msg += `\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⚠️ *PERINGATAN RISIKO:*\n`;
  msg += `_Volatilitas dan pelebaran spread dapat terjadi saat rilis data High Impact. Selalu jaga manajemen risiko & gunakan Stop Loss._\n`;

  return msg;
}

/**
 * Format pesan Pre-News Flash Alert (15-20 menit sebelum High Impact News)
 */
export function formatPreNewsAlertMessage(event: ForexFactoryEvent): string {
  const timeWib = formatToWIB(event.event_date);
  const forecastStr = event.forecast ? event.forecast : '-';
  const prevStr = event.previous ? event.previous : '-';

  return (
    `🚨 *PERINGATAN HIGH IMPACT NEWS INCOMING* 🚨\n\n` +
    `📢 *Event:* ${event.title}\n` +
    `⏰ *Waktu Rilis:* *${timeWib}* (±15-20 Menit Lagi)\n` +
    `💵 *Mata Uang:* ${event.country}\n` +
    `🔴 *Tingkat Dampak:* HIGH IMPACT (Red Folder)\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 *Konsensus Data:*\n` +
    `• Forecast : \`${forecastStr}\`\n` +
    `• Previous : \`${prevStr}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ *PERHATIAN KHUSUS TRADER GOLD/USD (XAU/USD):*\n` +
    `• Berita ini berpotensi memicu *lonjakan volatilitas instan*, slippage, dan pelebaran spread drastis.\n` +
    `• Amankan posisi terbuka Anda (pasang SL/BEP) atau hindari open posisi baru sesaat sebelum dan sesudah data dirilis.`
  );
}

/**
 * Caption pengantar saat mengirim dokumen PDF Kalender Bulanan
 */
export function formatMonthlyCalendarCaption(
  monthName: string,
  year: number,
  totalEvents: number,
  highImpactCount: number
): string {
  return (
    `📄 *FOREX FACTORY MONTHLY CALENDAR — GOLD/USD*\n` +
    `📅 Periode: *${monthName} ${year}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Total Agenda Ekonomi: *${totalEvents} Event*\n` +
    `🔴 High Impact (Red Folder): *${highImpactCount} Event*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `_Dokumen PDF kalender terlampir di atas. Memuat rincian agenda per pekan, konsensus data, serta panduan tanggal-tanggal krusial untuk trading Emas (XAU/USD)._`
  );
}
