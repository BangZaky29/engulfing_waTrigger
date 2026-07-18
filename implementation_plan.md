# Rencana Refactoring OOP Web WA Trigger & Verifikasi Sinyal

Dokumen ini memuat rencana kerja untuk merombak arsitektur proyek TypeScript `wa_trigger` (terutama `index.ts` yang mencapai 1200+ baris) menjadi struktur Modular/OOP yang terpisah rapi. Selain itu, rencana ini juga mencakup tahap audit teks *output signal* dengan apa yang dihasilkan oleh bot Python di Supabase.

## User Review Required

> [!IMPORTANT]
> Mohon baca dan setujui struktur fase yang diusulkan. Jika Anda setuju, tekan tombol **Proceed** dan saya akan mulai mengeksekusi Fase A - F secara bertahap.

## Open Questions

> [!WARNING]
> - Apakah nama-nama folder/modul yang saya usulkan di bawah (misal: `src/config`, `src/services`, `src/handlers`) sudah sesuai selera Anda?
> - Apakah Anda memiliki pedoman penamaan variabel TypeScript spesifik yang harus saya ikuti? Jika tidak, saya akan menggunakan standar CamelCase.

## Proposed Changes

Struktur proyek `wa_trigger` saat ini terpusat pada satu raksasa `src/index.ts`. Kita akan memecahnya menjadi struktur berikut:

```text
wa_trigger/src/
├── config/
│   └── env.ts                   # Mengatur pemuatan .env dinamis & ekspor konstan
├── utils/
│   └── helpers.ts               # delay, fetchWithTimeout
├── services/
│   ├── supabaseClient.ts        # Inisialisasi Klien Supabase
│   ├── waSocket.ts              # Logika koneksi @whiskeysockets/baileys & status
│   ├── outboxService.ts         # Enqueue & pemrosesan tabel wa_outbox
│   └── lockManager.ts           # acquireLock, releaseLock, dan heartbeat
├── handlers/
│   ├── signalHandler.ts         # Logika formatting pesan engulfing_signals
│   ├── activeLogHandler.ts      # Logika formatting pesan trade_active_logs
│   ├── tradeResultHandler.ts    # Logika formatting pesan trade_analytics (Profit/Loss)
│   ├── systemHandler.ts         # Startup, Shutdown, dan Logout Requested
│   └── realtimeListeners.ts     # Pendaftaran channel Supabase Realtime
├── cronScheduler.ts             # (Sudah ada, tidak diubah banyak)
├── pdfService.ts                # (Sudah ada, tidak diubah banyak)
├── supabaseAuthState.ts         # (Sudah ada, tidak diubah banyak)
└── index.ts                     # Sangat tipis, hanya orkestrasi modul
```

### Fase Pengerjaan (A-Z)

#### Fase A — Dasar & Konfigurasi (Config & Utilities)
- Ekstrak seluruh logika `dotenv` dan resolusi `ENGULFING_ENV_PATH` (lokasi `.env` python) ke `src/config/env.ts`.
- Pindahkan fungsi `delay` dan `fetchWithTimeout` ke `src/utils/helpers.ts`.
- Buat `src/services/supabaseClient.ts` untuk mengekspor _instance_ tunggal `supabase`.

#### Fase B — Modul Database & Penguncian (Lock & Outbox)
- Ekstrak `acquireLock`, `releaseLock`, dan `startLockHeartbeat` ke `src/services/lockManager.ts`.
- Ekstrak logika `enqueueWaMessage`, `processOutbox`, dan `sendOutboxJob` ke `src/services/outboxService.ts`.

#### Fase C — Modul Inti WhatsApp (WA Socket)
- Pindahkan fungsi `connectToWhatsApp` (koneksi Baileys), logika _reconnect backoff_, penanganan _Auth State_, dan `syncWaStatus` ke `src/services/waSocket.ts`.

#### Fase D — Modul Handler Pesan (Formatting Logika)
- Membedah blok Supabase Realtime dari `index.ts`.
- Ekstrak fungsi pembentuk _caption_ untuk Sinyal OP ke `src/handlers/signalHandler.ts`.
- Ekstrak pembentuk pesan Pending/Cancel/Expired ke `src/handlers/activeLogHandler.ts`.
- Ekstrak pembentuk pesan Profit/Loss/Trade Close ke `src/handlers/tradeResultHandler.ts`.
- Ekstrak logika pengiriman Notifikasi Startup & Shutdown ke `src/handlers/systemHandler.ts`.

#### Fase E — Orkestrasi Realtime Listeners
- Buat `src/handlers/realtimeListeners.ts` yang memuat logika `setupSupabaseListeners` dan melakukan injeksi (panggilan) ke handler yang dibuat di Fase D.

#### Fase F — Refactoring `index.ts` & Audit Python
- Mengubah `index.ts` menjadi _entry point_ yang sangat ramping (meng-*import* dan menjalankan fungsi inisialisasi).
- **Verifikasi Akhir**: Melakukan audit/pengecekan variabel yang diharapkan oleh `wa_trigger` (misalnya pembacaan JSON dari kolom `notes`) dengan apa yang sebenarnya dikirim oleh bot Python di repositori utama (`engulfing`), sehingga teks TP/SL/Info TFM bisa cocok dengan data terupdate Python.

## Verification Plan

### Automated Tests
- TypeScript compiler (`npx tsc --noEmit`) akan dipanggil untuk memastikan tidak ada import atau dependensi tipe yang rusak akibat ekstrak file.

### Manual Verification
- Pengguna diminta untuk menjalankan *build* (`npm run build`) dan menghidupkan bot WA (`npm start`) untuk mengonfirmasi kelancaran _startup_ dan tidak ada _crash_.
- Meminta pengguna untuk mentrigger bot Python sesaat guna mengonfirmasi format signal masuk ke WhatsApp dengan sempurna.
