// =====================================================
// src/services/forexPdfService.ts
// Service pembuat dokumen PDF kalender bulanan Forex Factory
// menggunakan Puppeteer dengan tampilan visual modern.
// =====================================================

import puppeteer from 'puppeteer';
import { ForexFactoryEvent, formatToWIB } from './forexFactoryService';

export class ForexPdfService {
  /**
   * Render HTML Kalender ke Dokumen PDF Buffer
   */
  async generateMonthlyCalendarPdf(
    events: ForexFactoryEvent[],
    year: number,
    month: number,
    monthName: string
  ): Promise<Buffer> {
    const html = this.buildHtmlTemplate(events, year, month, monthName);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
      });

      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  }

  /**
   * Bangun string HTML / CSS untuk dokumen PDF
   */
  private buildHtmlTemplate(
    events: ForexFactoryEvent[],
    year: number,
    month: number,
    monthName: string
  ): string {
    const highCount = events.filter(e => e.impact === 'High').length;
    const mediumCount = events.filter(e => e.impact === 'Medium').length;

    // Kelompokkan event per tanggal
    const grouped: { [dateStr: string]: ForexFactoryEvent[] } = {};
    events.forEach(e => {
      const d = new Date(e.event_date);
      const dateKey = new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta',
        weekday: 'long',
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }).format(d);

      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push(e);
    });

    let tableRows = '';
    for (const [dateTitle, evts] of Object.entries(grouped)) {
      tableRows += `
        <tr class="date-header-row">
          <td colspan="6">📅 ${dateTitle}</td>
        </tr>
      `;

      evts.forEach(e => {
        const timeStr = formatToWIB(e.event_date);
        const isHigh = e.impact === 'High';
        const impactBadge = isHigh
          ? `<span class="badge badge-high">🔴 HIGH</span>`
          : `<span class="badge badge-medium">🟠 MED</span>`;

        tableRows += `
          <tr class="${isHigh ? 'row-high' : ''}">
            <td class="col-time">${timeStr}</td>
            <td class="col-curr"><strong>${e.country}</strong></td>
            <td class="col-impact">${impactBadge}</td>
            <td class="col-title">${e.title}</td>
            <td class="col-data">${e.forecast || '-'}</td>
            <td class="col-data">${e.previous || '-'}</td>
          </tr>
        `;
      });
    }

    if (events.length === 0) {
      tableRows = `
        <tr>
          <td colspan="6" style="text-align:center; padding: 30px; color: #888;">
            Tidak ada agenda High/Medium impact yang terjadwal.
          </td>
        </tr>
      `;
    }

    return `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Forex Factory Monthly Calendar - ${monthName} ${year}</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      background-color: #0b1120;
      color: #e2e8f0;
      padding: 10px;
      font-size: 11px;
      line-height: 1.4;
    }
    .header {
      border-bottom: 2px solid #eab308;
      padding-bottom: 12px;
      margin-bottom: 15px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .title-box h1 {
      font-size: 18px;
      color: #f8fafc;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title-box h1 span {
      color: #eab308;
    }
    .title-box p {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 3px;
    }
    .badge-month {
      background: linear-gradient(135deg, #ca8a04, #eab308);
      color: #000;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      letter-spacing: 0.5px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 15px;
    }
    .summary-card {
      background-color: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 10px;
      text-align: center;
    }
    .summary-card .label {
      font-size: 10px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .summary-card .val {
      font-size: 16px;
      font-weight: 700;
      margin-top: 4px;
    }
    .val.high { color: #ef4444; }
    .val.medium { color: #f97316; }
    .val.total { color: #38bdf8; }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    th {
      background-color: #1e293b;
      color: #94a3b8;
      padding: 8px 6px;
      text-align: left;
      font-size: 10px;
      text-transform: uppercase;
      border-bottom: 1px solid #475569;
    }
    td {
      padding: 6px;
      border-bottom: 1px solid #1e293b;
      font-size: 10.5px;
    }
    .date-header-row td {
      background-color: #1e293b;
      color: #fde047;
      font-weight: 600;
      padding: 6px 8px;
      font-size: 11px;
      border-top: 1px solid #334155;
      border-bottom: 1px solid #334155;
    }
    .row-high {
      background-color: rgba(239, 68, 68, 0.05);
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 700;
    }
    .badge-high {
      background-color: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .badge-medium {
      background-color: rgba(249, 115, 22, 0.2);
      color: #fb923c;
      border: 1px solid rgba(249, 115, 22, 0.3);
    }
    .col-time { width: 85px; color: #cbd5e1; font-weight: 500; }
    .col-curr { width: 55px; }
    .col-impact { width: 75px; }
    .col-title { color: #f8fafc; font-weight: 500; }
    .col-data { width: 75px; text-align: right; color: #94a3b8; }

    .footer {
      margin-top: 20px;
      padding-top: 10px;
      border-top: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      color: #64748b;
      font-size: 9.5px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-box">
      <h1>FOREX FACTORY <span>ECONOMIC CALENDAR</span></h1>
      <p>Katalog Agenda Ekonomi Penggerak Pasar Emas (GOLD / USD)</p>
    </div>
    <div class="badge-month">${monthName.toUpperCase()} ${year}</div>
  </div>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">Total Agenda Terjadwal</div>
      <div class="val total">${events.length} Event</div>
    </div>
    <div class="summary-card">
      <div class="label">Agenda High Impact (Red)</div>
      <div class="val high">${highCount} Event</div>
    </div>
    <div class="summary-card">
      <div class="label">Agenda Medium Impact (Orange)</div>
      <div class="val medium">${mediumCount} Event</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="col-time">Waktu (WIB)</th>
        <th class="col-curr">Valuta</th>
        <th class="col-impact">Dampak</th>
        <th class="col-title">Peristiwa / Indikator Ekonomi</th>
        <th class="col-data">Forecast</th>
        <th class="col-data">Previous</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>

  <div class="footer">
    <div>Sistem Otomasi: Engulfing Strategy Bot & WA Trigger Suite</div>
    <div>Zona Waktu: WIB (GMT+7) | Sumber Data: Forex Factory via Fair Economy Media</div>
  </div>
</body>
</html>
    `;
  }
}

export const forexPdfService = new ForexPdfService();
