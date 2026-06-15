Bro, dari screenshot + log yang lo kirim, **DB-nya kelihatan `CONNECTED`, tapi session key WA-nya sudah tidak sinkron / corrupt**.

Di log bot lo ada tanda jelas:

`Session ditemukan di Supabase (status: CONNECTED). Memuat...` lalu session berhasil load dan `creds.me` kebaca. Tapi setelah itu muncul berulang:

`Failed to decrypt message with any known session`, `MessageCounterError: Key used already or never filled`, dan `Bad MAC`. Itu artinya koneksi socket bisa kebuka, tapi **key enkripsi untuk baca pesan WhatsApp sudah rusak / stale / kepakai dobel**. 

Di screenshot juga terlihat row `main_session` status-nya `CONNECTED`, `qr_code` null, dan `session_data` ada isinya. Jadi secara database memang bot menganggap session masih aktif. 

## Kenapa bisa kejadian?

### 1. `CONNECTED` di DB bukan jaminan session sehat

Kolom ini cuma status dari aplikasi lo sendiri:

```sql
status text not null default 'UNPAIRED'
```

Jadi kalau sebelumnya bot pernah connect, status disimpan `CONNECTED`. Tapi isi `session_data` bisa saja sudah **tidak valid**.

Analogi simpelnya:

> `CONNECTED` itu kayak kartu akses masih ada.
> Tapi `session_data` itu kunci enkripsi ruangan.
> Kalau kuncinya udah beda/korup, lo tetap bisa masuk gedung, tapi nggak bisa buka pintu chat.

---

### 2. Kemungkinan besar ada 2 instance bot jalan pakai session yang sama

Error ini sering banget muncul kalau:

* bot lokal dan bot production sama-sama jalan,
* `npm run dev` kebuka dua terminal,
* nodemon/ts-node restart tapi proses lama belum mati,
* server deploy jalan multi-instance,
* atau session `main_session` dipakai oleh dua service berbeda.

WhatsApp/Baileys pakai sistem **message counter**. Kalau satu pesan/key sudah dipakai oleh instance A, lalu instance B pakai key yang sama, muncullah:

```txt
Key used already or never filled
Bad MAC
```

Ini paling masuk akal dari kasus lo.

---

### 3. `session_data jsonb` disimpan satu blob besar, rawan overwrite

Struktur lo sekarang:

```sql
session_data jsonb null default '{}'::jsonb
```

Ini bisa jalan, tapi untuk Baileys agak riskan kalau seluruh auth state disimpan sebagai **satu JSON besar**.

Kenapa?

Baileys punya banyak key kecil:

* `creds`
* `pre-key`
* `session`
* `sender-key`
* `app-state-sync-key`
* `sender-key-memory`
* dll.

Kalau tiap update lo simpan ulang seluruh `session_data`, lalu ada update paralel, sebagian key bisa ketimpa versi lama. Akhirnya DB masih ada isi, tapi isinya **nggak konsisten**.

---

### 4. Session pernah expired / device WhatsApp berubah

Bisa juga karena:

* nomor WA logout dari Linked Devices,
* session di HP dicabut,
* Baileys reconnect pakai session lama,
* nomor WA sempat relink,
* atau data session lama masih dipakai setelah pairing ulang.

Kalau begitu, `creds.me` masih bisa kebaca dari DB, tapi key decrypt pesan sudah nggak cocok.

---

## Kesimpulan utama

Menurut gue penyebabnya **bukan struktur table SQL-nya yang salah total**, tapi **isi `session_data` sudah tidak sinkron dengan state WhatsApp saat ini**.

Urutan penyebab paling probable:

| Prioritas |                                        Penyebab |   Kemungkinan |
| --------- | ----------------------------------------------: | ------------: |
| 1         |         Ada 2 instance bot pakai `main_session` | Sangat tinggi |
| 2         |    `session_data` overwrite / save tidak atomic |        Tinggi |
| 3         | Session lama dipakai setelah reconnect / relink |        Tinggi |
| 4         |    Format JSON Buffer tidak revive dengan benar |        Sedang |
| 5         |      Status DB tidak pernah di-reset saat error |        Sedang |

---

## Fix cepat sekarang

Stop semua bot dulu. Pastikan cuma **1 proses node** yang jalan.

Di Windows cek:

```bash
tasklist | findstr node
```

Kalau ada banyak, kill dulu:

```bash
taskkill /F /IM node.exe
```

Lalu reset session di Supabase:

```sql
update public.whatsapp_sessions
set
  status = 'UNPAIRED',
  qr_code = null,
  session_data = '{}'::jsonb,
  updated_at = now()
where id = 'main_session';
```

Setelah itu:

1. buka WhatsApp HP,
2. masuk **Linked Devices**,
3. hapus device bot lama kalau masih ada,
4. jalankan bot lagi,
5. scan QR baru.

Ini cara paling bersih untuk balikin session sehat.

---

## Fix arsitektur biar nggak kejadian lagi

### 1. Jangan izinkan dua bot jalan pakai session yang sama

Tambahkan lock di database. Minimal tambah kolom:

```sql
alter table public.whatsapp_sessions
add column if not exists owner_id text,
add column if not exists locked_at timestamptz;
```

Saat bot start, isi `owner_id` pakai `process.pid` atau UUID instance. Kalau sudah ada lock aktif, bot kedua jangan start.

---

### 2. Pisahkan auth keys dari `session_data`

Lebih aman bikin table baru:

```sql
create table public.whatsapp_auth_keys (
  session_id text not null references public.whatsapp_sessions(id) on delete cascade,
  key_type text not null,
  key_id text not null,
  value jsonb not null,
  updated_at timestamptz default now(),
  primary key (session_id, key_type, key_id)
);
```

Lalu `whatsapp_sessions` cukup buat metadata:

```sql
create table public.whatsapp_sessions (
  id text primary key,
  status text not null default 'UNPAIRED',
  qr_code text null,
  updated_at timestamptz default now()
);
```

Jadi key Baileys disimpan per item, bukan satu `session_data` besar.

---

### 3. Pastikan save auth pakai `BufferJSON`

Kalau lo pakai Baileys, penyimpanan JSON harus preserve Buffer/Uint8Array.

Pattern-nya kira-kira:

```ts
JSON.stringify(data, BufferJSON.replacer)
JSON.parse(json, BufferJSON.reviver)
```

Kalau ini nggak dipakai, key bisa kebaca sebagai object biasa, tapi pas decrypt gagal.

---

### 4. Jangan cuma update `status = CONNECTED`

Status sebaiknya update begini:

```ts
if (connection === 'open') {
  status = 'CONNECTED'
}

if (connection === 'close') {
  status = 'DISCONNECTED'
}

if (loggedOut) {
  status = 'UNPAIRED'
  session_data = {}
}
```

Karena sekarang kemungkinan status tetap `CONNECTED` walaupun decrypt key-nya sudah error.

---

## Jawaban singkatnya

Bro, ini terjadi karena **session WhatsApp di Supabase kelihatan connected, tapi key enkripsi Baileys di `session_data` sudah tidak valid/sinkron**. Penyebab paling kuat: **session yang sama dipakai dobel oleh lebih dari satu proses**, atau **penyimpanan `session_data` sebagai satu JSON besar bikin key overwrite/stale**.

Action paling aman sekarang: **stop semua node process → reset row `main_session` → unlink device lama di WhatsApp → scan QR ulang → pastikan cuma 1 instance bot aktif**.
