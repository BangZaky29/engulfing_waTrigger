# Penyesuaian Pesan WhatsApp untuk Dynamic SL (H1)

Saat ini, bot Python sudah mengirimkan data SL dinamis dan sumber trigger H1 ke Supabase (`engulfing_signals.notes`). Agar grup WhatsApp menampilkan info tersebut secara elegan, kita perlu melakukan pembaruan di _script_ Node.js (`wa_trigger/src/index.ts`).

## Proposed Changes

### 1. `index.ts` (Project WA Trigger)

Kita akan mengubah cara `caption` (pesan) diformat ketika ada sinyal masuk, tepatnya di baris sekitar `600-615`.

#### [MODIFY] [index.ts](file:///C:/codingVibes/mt5/engulfing_webs/wa_trigger/src/index.ts)

**Logika yang akan ditambahkan:**
1. Mengambil variabel `sl_source` (misal: "H1"), `sl_pct` (misal: 30), dan `h1_trigger_source` (misal: "DB-3", "Engulfing") dari database (via `notesObj` dan field `signal`).
2. Jika `sl_source === 'H1'`, maka kita akan menempelkan label eksklusif pada SL.
3. Menambahkan baris informasi **Trigger Utama (H1)** agar di WA kelihatan jelas sinyal ini didukung oleh candle H1 apa.

**Contoh Format Pesan WhatsApp Baru:**
```text
🌟 *SIGNAL ENGULFING [SELL]* 🌟
----------------------------------
📌 *Pair:* BTC
⏱️ *TF:* M5
📊 *Strategy:* FILTER C
🔥 *Trigger H1:* Sell-DB-3 

📈 *Entry:* 60127.96 (SELL MARKET)
🛑 *SL:* 60183.05 (Dynamic H1 30%) 
🎯 *TP:* 60072.87 (RR 1:1)

💡 *Sesi:* New York
----------------------------------
⚠️ _Harap gunakan manajemen risiko yang baik_
```

## User Review Required

> [!IMPORTANT]
> Apakah format pesan WhatsApp di atas sudah sesuai dengan selera Anda? Atau mungkin Anda ingin icon emoji yang berbeda untuk baris `Trigger H1` dan teks `(Dynamic H1 30%)`?

Jika Anda setuju dengan desain pesan ini, klik **Proceed** dan saya akan langsung merombak `index.ts` di project WA Trigger Anda!
