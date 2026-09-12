// =====================================================
// src/cron/cronConfig.ts
// Config terpusat untuk semua cron jobs.
// Ubah enabled/schedule di sini tanpa sentuh logic job.
// =====================================================

export const CRON_CONFIG = {
  // ========== REPORT JOBS (AKTIF) ==========

  DAILY_REPORT: {
    enabled: true,
    schedule: '59 23 * * *',         // Setiap hari jam 23:59
  },

  WEEKLY_REPORT: {
    enabled: true,
    schedule: '58 23 * * 0',         // Setiap Minggu jam 23:58
  },

  MONTHLY_REPORT: {
    enabled: true,
    schedule: '57 23 * * *',         // Cek hari terakhir bulan jam 23:57
  },

  YEARLY_REPORT: {
    enabled: true,
    schedule: '56 23 31 12 *',       // 31 Desember jam 23:56
  },

  // ========== BOT SCHEDULE NOTIFIER (DISABLED — untuk production nanti) ==========

  BOT_TRADING_OPEN_NOTIF: {
    enabled: false,                   // ⛔ DISABLED — aktifkan di production
    schedule: '0 15 * * *',          // Jam 15:00 WIB — trading window OPEN
  },

  BOT_TRADING_CLOSE_NOTIF: {
    enabled: false,                   // ⛔ DISABLED — aktifkan di production
    schedule: '0 4 * * *',           // Jam 04:00 WIB — trading window CLOSE
  },

  // ========== FOREX FACTORY & GOLD/USD JOBS ==========

  FF_CALENDAR_SYNC: {
    enabled: true,                   // Sinkronisasi data kalender FairEconomy
    schedule: '0 */2 * * *',         // Setiap 2 jam sekali
  },

  FF_DAILY_BRIEFING: {
    enabled: true,                   // Briefing harian Forex Factory & Gold/USD
    schedule: '30 6 * * 1-5',        // Senin - Jumat pukul 06:30 WIB
  },

  FF_PRE_NEWS_ALERT: {
    enabled: true,                   // Alert flash 15-20 menit sebelum High Impact
    schedule: '*/5 * * * 1-5',       // Polling setiap 5 menit (Senin - Jumat)
  },

  FF_MONTHLY_CALENDAR: {
    enabled: true,                   // Dokumen PDF Kalender Bulanan
    schedule: '0 7 1 * *',           // Tanggal 1 setiap bulan pukul 07:00 WIB
  },
} as const;
