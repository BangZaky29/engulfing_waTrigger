// =====================================================
// src/cron/types.ts
// Interface standar untuk semua cron job definitions.
// =====================================================

export interface CronJobDefinition {
  /** Nama unik job (untuk logging & identifikasi) */
  name: string;

  /** Deskripsi singkat job */
  description: string;

  /** Cron expression (e.g., '59 23 * * *') */
  schedule: string;

  /** Toggle aktif/non-aktif — false = job tidak akan di-register */
  enabled: boolean;

  /** Handler yang dijalankan saat cron trigger */
  handler: (ctx: CronContext) => Promise<void>;
}

export interface CronContext {
  /** WhatsApp socket instance (Baileys) */
  sock: any;

  /** Target group/private JID untuk kirim pesan */
  groupJid: string;
}
