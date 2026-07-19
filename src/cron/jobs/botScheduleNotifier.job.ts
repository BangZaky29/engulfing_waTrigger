// =====================================================
// src/cron/jobs/botScheduleNotifier.job.ts
// Cron Job: Bot Trading Schedule Notifier
// Mengirim notifikasi WA saat trading window OPEN/CLOSE.
//
// ⛔ DISABLED by default — aktifkan di cronConfig.ts
//    saat sudah deploy ke production server.
//
// Job ini BUKAN untuk start/stop bot Python.
// Bot Python jalan 24/7, trading schedule diatur di sisi Python
// via TRADING_ACTIVE_ENABLED di .env Python.
// Job ini hanya mengirim notifikasi informasi ke WA group.
// =====================================================

import { CronJobDefinition, CronContext } from '../types';
import { CRON_CONFIG } from '../cronConfig';

// --- Trading Window OPEN Notification (15:00 WIB) ---
const botTradingOpenNotifJob: CronJobDefinition = {
  name: 'botTradingOpenNotif',
  description: 'Notifikasi WA — Trading window OPEN (15:00 WIB)',
  schedule: CRON_CONFIG.BOT_TRADING_OPEN_NOTIF.schedule,
  enabled: CRON_CONFIG.BOT_TRADING_OPEN_NOTIF.enabled,

  handler: async (ctx: CronContext) => {
    console.log('[CRON] Sending Trading Window OPEN notification...');

    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

    const message =
      `🟢 *TRADING WINDOW OPEN*\n\n` +
      `⏰ Waktu: ${timeStr} WIB\n` +
      `📊 Bot mulai execute order\n\n` +
      `Jam aktif trading: 15:00 — 04:00 WIB\n` +
      `_Bot tetap scanning 24/7, execution aktif di jam ini._`;

    await ctx.sock.sendMessage(ctx.groupJid, { text: message });
  },
};

// --- Trading Window CLOSE Notification (04:00 WIB) ---
const botTradingCloseNotifJob: CronJobDefinition = {
  name: 'botTradingCloseNotif',
  description: 'Notifikasi WA — Trading window CLOSE (04:00 WIB)',
  schedule: CRON_CONFIG.BOT_TRADING_CLOSE_NOTIF.schedule,
  enabled: CRON_CONFIG.BOT_TRADING_CLOSE_NOTIF.enabled,

  handler: async (ctx: CronContext) => {
    console.log('[CRON] Sending Trading Window CLOSE notification...');

    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

    const message =
      `🔴 *TRADING WINDOW CLOSED*\n\n` +
      `⏰ Waktu: ${timeStr} WIB\n` +
      `😴 Bot mode scan only — tidak execute order\n\n` +
      `Trading akan aktif kembali jam 15:00 WIB\n` +
      `_Bot tetap scanning & mengumpulkan data market._`;

    await ctx.sock.sendMessage(ctx.groupJid, { text: message });
  },
};

export { botTradingOpenNotifJob, botTradingCloseNotifJob };
