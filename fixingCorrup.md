Bro, **kesimpulan finalnya: masalah WA lo bukan cuma dari Node.js**, tapi **Supabase security + lifecycle bot WA belum aman**.

Dari data grant yang lo kirim, `anon` dan `authenticated` masih punya akses `DELETE`, `INSERT`, `SELECT`, `UPDATE`, bahkan `TRUNCATE` ke banyak table termasuk `whatsapp_sessions` dan `whatsapp_auth_keys`. Ini bahaya banget karena session/key WA bisa kebaca, ke-update, atau ketimpa dari client yang salah. 

## Kesimpulan final masalah

### Penyebab utama dari sisi Supabase

1. **`whatsapp_sessions` dan `whatsapp_auth_keys` kebuka untuk `anon` dan `authenticated`.**
   Ini bisa bikin session Baileys corrupt, key ketimpa, lock berubah, dan bot reconnect random.

2. **Policy sebelumnya pakai role `{public}`.**
   Jadi walaupun namanya “service role full access”, sebenarnya semua role bisa akses.

3. **Belum ada table antrian pesan WA.**
   Jadi ketika WA socket close saat kirim pesan, pesan langsung hilang karena tidak ada retry.

4. **Realtime listener bisa error, tapi code masih merasa listener sudah terdaftar.**
   Ini bikin event dari `trade_analytics`, `trade_active_logs`, atau `engulfing_signals` kadang tidak diproses.

### Penyebab utama dari sisi Node.js

1. Saat Supabase `fetch failed`, bot malah bikin **fresh credentials**. Ini salah.
   Kalau Supabase gagal dibaca karena network, bot harus retry, bukan bikin session baru.

2. Bot langsung kirim pesan dari listener.
   Kalau WA close pas proses kirim gambar, pesan gagal dan tidak dikirim ulang.

3. Listener, cron, dan startup logic kemungkinan ikut terpanggil ulang saat reconnect.

---

# 1. SQL final untuk beresin Supabase

Run ini di **Supabase SQL Editor**. Saran gue: jalanin di luar jam market dulu, karena script ini akan mengunci akses frontend langsung ke table sensitif.

## A. Bersihkan policy public yang salah

```sql
begin;

-- Drop semua policy yang masih pakai role public di schema public
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and roles::text ilike '%public%'
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      r.policyname,
      r.schemaname,
      r.tablename
    );
  end loop;
end $$;

commit;
```

---

## B. Cabut akses `anon` dan `authenticated` dari semua table public

```sql
begin;

-- Cabut akses table dari anon/authenticated
revoke all privileges on all tables in schema public from anon;
revoke all privileges on all tables in schema public from authenticated;

-- Cabut akses sequence, supaya anon/auth tidak bisa insert via auto increment
revoke all privileges on all sequences in schema public from anon;
revoke all privileges on all sequences in schema public from authenticated;

-- Cabut akses function public dari anon/authenticated
revoke all privileges on all functions in schema public from anon;
revoke all privileges on all functions in schema public from authenticated;

commit;
```

---

## C. Aktifkan RLS di semua table utama

```sql
alter table public.candles enable row level security;
alter table public.engulfing_signals enable row level security;
alter table public.engulfing_stats enable row level security;
alter table public.trade_analytics enable row level security;
alter table public.trade_active_logs enable row level security;
alter table public.report_history enable row level security;
alter table public.whatsapp_sessions enable row level security;
alter table public.whatsapp_auth_keys enable row level security;
```

---

## D. Grant full access hanya untuk `service_role`

```sql
begin;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- Untuk table baru ke depan, service_role tetap dapat akses
alter default privileges in schema public
grant all privileges on tables to service_role;

alter default privileges in schema public
grant all privileges on sequences to service_role;

alter default privileges in schema public
grant all privileges on functions to service_role;

commit;
```

---

## E. Buat policy service role yang benar

```sql
create policy "Service role full access on candles"
on public.candles
for all
to service_role
using (true)
with check (true);

create policy "Service role full access on engulfing_signals"
on public.engulfing_signals
for all
to service_role
using (true)
with check (true);

create policy "Service role full access on engulfing_stats"
on public.engulfing_stats
for all
to service_role
using (true)
with check (true);

create policy "Service role full access on trade_analytics"
on public.trade_analytics
for all
to service_role
using (true)
with check (true);

create policy "Service role full access on trade_active_logs"
on public.trade_active_logs
for all
to service_role
using (true)
with check (true);

create policy "Service role full access on report_history"
on public.report_history
for all
to service_role
using (true)
with check (true);

create policy "Service role full access on whatsapp_sessions"
on public.whatsapp_sessions
for all
to service_role
using (true)
with check (true);

create policy "Service role full access on whatsapp_auth_keys"
on public.whatsapp_auth_keys
for all
to service_role
using (true)
with check (true);
```

---

# 2. SQL buat bikin `wa_outbox`

Ini bagian penting supaya pesan WA tidak hilang kalau koneksi WA close.

```sql
create table if not exists public.wa_outbox (
  id uuid primary key default gen_random_uuid(),

  source_table text not null,
  source_id bigint,
  ticket_id bigint,

  event_type text not null,
  group_jid text not null,

  message_type text not null default 'TEXT'
    check (message_type in ('TEXT', 'IMAGE', 'DOCUMENT')),

  message text not null,
  image_url text,
  payload jsonb not null default '{}'::jsonb,

  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELED')),

  attempts integer not null default 0,
  max_attempts integer not null default 5,

  next_retry_at timestamptz not null default now(),
  last_error text,

  wa_message_id text,

  locked_by text,
  locked_at timestamptz,

  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  dedupe_key text not null unique
);
```

Index biar worker cepat ambil antrean:

```sql
create index if not exists idx_wa_outbox_status_retry
on public.wa_outbox (status, next_retry_at);

create index if not exists idx_wa_outbox_ticket_id
on public.wa_outbox (ticket_id);

create index if not exists idx_wa_outbox_created_at
on public.wa_outbox (created_at desc);
```

Trigger `updated_at`:

```sql
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_wa_outbox_updated_at on public.wa_outbox;

create trigger trg_wa_outbox_updated_at
before update on public.wa_outbox
for each row
execute function public.set_updated_at();
```

Aktifkan RLS dan kunci `wa_outbox` untuk backend only:

```sql
alter table public.wa_outbox enable row level security;

revoke all privileges on table public.wa_outbox from anon;
revoke all privileges on table public.wa_outbox from authenticated;

grant select, insert, update, delete on table public.wa_outbox to service_role;

create policy "Service role full access on wa_outbox"
on public.wa_outbox
for all
to service_role
using (true)
with check (true);
```

---

# 3. SQL Supabase Realtime Publication

Pastikan table yang dibutuhkan masuk publication:

```sql
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'trade_analytics'
  ) then
    alter publication supabase_realtime add table public.trade_analytics;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'trade_active_logs'
  ) then
    alter publication supabase_realtime add table public.trade_active_logs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'engulfing_signals'
  ) then
    alter publication supabase_realtime add table public.engulfing_signals;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'whatsapp_sessions'
  ) then
    alter publication supabase_realtime add table public.whatsapp_sessions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'wa_outbox'
  ) then
    alter publication supabase_realtime add table public.wa_outbox;
  end if;
end $$;
```

Untuk update/delete event lebih lengkap:

```sql
alter table public.trade_analytics replica identity full;
alter table public.trade_active_logs replica identity full;
alter table public.engulfing_signals replica identity full;
alter table public.whatsapp_sessions replica identity full;
alter table public.wa_outbox replica identity full;
```

---

# 4. SQL fix view security

Karena sebelumnya view lo juga punya grant ke `anon/authenticated`, bersihin juga:

```sql
revoke all privileges on table public.v_latest_engulfing from anon;
revoke all privileges on table public.v_latest_engulfing from authenticated;

revoke all privileges on table public.trade_deep_analytics_view from anon;
revoke all privileges on table public.trade_deep_analytics_view from authenticated;

grant select on table public.v_latest_engulfing to service_role;
grant select on table public.trade_deep_analytics_view to service_role;

alter view public.v_latest_engulfing
set (security_invoker = true);

alter view public.trade_deep_analytics_view
set (security_invoker = true);
```

---

# 5. Kalau dashboard frontend perlu baca data

Kalau frontend lo memang perlu nampilin analytics, kasih read-only ke `authenticated`, bukan `anon`.

```sql
grant select on table public.trade_analytics to authenticated;
grant select on table public.trade_active_logs to authenticated;
grant select on table public.engulfing_signals to authenticated;
grant select on table public.engulfing_stats to authenticated;
grant select on table public.report_history to authenticated;
grant select on table public.v_latest_engulfing to authenticated;
grant select on table public.trade_deep_analytics_view to authenticated;

create policy "Authenticated read trade_analytics"
on public.trade_analytics
for select
to authenticated
using (true);

create policy "Authenticated read trade_active_logs"
on public.trade_active_logs
for select
to authenticated
using (true);

create policy "Authenticated read engulfing_signals"
on public.engulfing_signals
for select
to authenticated
using (true);

create policy "Authenticated read engulfing_stats"
on public.engulfing_stats
for select
to authenticated
using (true);

create policy "Authenticated read report_history"
on public.report_history
for select
to authenticated
using (true);
```

**Jangan pernah kasih akses frontend ke ini:**

```txt
public.whatsapp_sessions
public.whatsapp_auth_keys
public.wa_outbox
```

---

# 6. SQL reset session WA — hanya kalau session sudah corrupt

Run ini **hanya kalau lo siap scan QR ulang**.

```sql
begin;

delete from public.whatsapp_auth_keys
where session_id = 'main_session';

update public.whatsapp_sessions
set
  status = 'UNPAIRED',
  qr_code = null,
  session_data = '{}'::jsonb,
  owner_id = null,
  locked_at = null,
  updated_at = now()
where id = 'main_session';

commit;
```

Setelah itu unlink device lama dari HP WhatsApp, lalu scan QR ulang.

---

# 7. SQL cek final setelah semua fix

```sql
select
  table_schema,
  table_name,
  grantee,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'whatsapp_sessions',
    'whatsapp_auth_keys',
    'wa_outbox',
    'trade_analytics',
    'trade_active_logs',
    'engulfing_signals',
    'engulfing_stats',
    'report_history',
    'v_latest_engulfing',
    'trade_deep_analytics_view'
  )
order by table_name, grantee, privilege_type;
```

Target sehatnya:

```txt
whatsapp_sessions      -> service_role only
whatsapp_auth_keys     -> service_role only
wa_outbox              -> service_role only
trade_analytics        -> service_role, optional authenticated SELECT
trade_active_logs      -> service_role, optional authenticated SELECT
engulfing_signals      -> service_role, optional authenticated SELECT
```

Cek policy:

```sql
select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

Yang tidak boleh ada lagi:

```txt
roles = {public}
cmd = ALL
tablename = whatsapp_sessions
tablename = whatsapp_auth_keys
```

Cek realtime:

```sql
select
  pubname,
  schemaname,
  tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
order by tablename;
```

---

# 8. Perbaikan yang wajib di Node.js

## A. Backend WA wajib pakai service role key

Di Node.js bot, jangan pakai anon key.

```ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
)
```

`.env`:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxxx
GROUP_JID=120363427469982924@g.us
```

Service role key **jangan pernah masuk frontend**.

---

## B. Jangan bikin fresh credentials saat `fetch failed`

Ini penting banget.

Salah:

```ts
catch (err) {
  console.log('Error membaca creds dari Supabase')
  initFreshCredentials()
}
```

Benar:

```ts
function isNetworkError(err: unknown) {
  const msg = String((err as any)?.message ?? err)
  return (
    msg.includes('fetch failed') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ENOTFOUND')
  )
}

async function loadCredsSafe() {
  try {
    const creds = await loadCredsFromSupabase()

    if (!creds) {
      console.log('[AUTH] Creds kosong, baru boleh init fresh credentials.')
      return initFreshCredentials()
    }

    return creds
  } catch (err) {
    if (isNetworkError(err)) {
      console.error('[AUTH] Supabase network error. Jangan init fresh credentials. Retry...')
      await delay(5000)
      throw err
    }

    throw err
  }
}
```

Rule-nya:

| Kondisi                | Action             |
| ---------------------- | ------------------ |
| Supabase network error | retry              |
| row benar-benar kosong | fresh credentials  |
| auth key corrupt       | reset manual       |
| logout WhatsApp        | reset + scan QR    |
| RLS permission error   | stop, fix Supabase |

---

## C. Simpan Baileys auth key pakai `whatsapp_auth_keys`, bukan `session_data`

`whatsapp_sessions` cukup buat metadata:

```txt
id
status
qr_code
owner_id
locked_at
updated_at
```

`whatsapp_auth_keys` buat data Baileys:

```txt
session_id
key_type
key_id
value
updated_at
```

Dan pastikan JSON pakai `BufferJSON`:

```ts
import { BufferJSON } from '@whiskeysockets/baileys'

function encodeAuthValue(value: any) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer))
}

function decodeAuthValue(value: any) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver)
}
```

Kalau Buffer tidak disimpan/di-restore dengan benar, efeknya bisa jadi:

```txt
Bad MAC
Failed to decrypt message
Key used already or never filled
```

---

## D. Jangan langsung kirim WA dari listener

Flow lama:

```txt
INSERT trade_analytics -> langsung kirim WA
```

Flow baru yang lebih aman:

```txt
INSERT trade_analytics -> insert wa_outbox -> worker kirim WA -> kalau gagal retry
```

Contoh enqueue:

```ts
async function enqueueWaMessage(input: {
  sourceTable: string
  sourceId?: number
  ticketId?: number
  eventType: string
  groupJid: string
  messageType: 'TEXT' | 'IMAGE'
  message: string
  imageUrl?: string
  payload?: any
}) {
  const dedupeKey = [
    input.sourceTable,
    input.ticketId ?? input.sourceId ?? 'noid',
    input.eventType,
    input.messageType,
  ].join(':')

  const { error } = await supabase
    .from('wa_outbox')
    .upsert(
      {
        source_table: input.sourceTable,
        source_id: input.sourceId ?? null,
        ticket_id: input.ticketId ?? null,
        event_type: input.eventType,
        group_jid: input.groupJid,
        message_type: input.messageType,
        message: input.message,
        image_url: input.imageUrl ?? null,
        payload: input.payload ?? {},
        status: 'PENDING',
        next_retry_at: new Date().toISOString(),
        dedupe_key: dedupeKey,
      },
      {
        onConflict: 'dedupe_key',
        ignoreDuplicates: true,
      }
    )

  if (error) {
    console.error('[OUTBOX] Gagal enqueue WA message:', error)
  }
}
```

---

## E. Worker pengirim WA dengan retry

```ts
let outboxRunning = false

function isWaReady() {
  return Boolean(sock?.user && waConnectionState === 'open')
}

async function processOutbox() {
  if (outboxRunning) return
  if (!isWaReady()) return

  outboxRunning = true

  try {
    const { data: jobs, error } = await supabase
      .from('wa_outbox')
      .select('*')
      .eq('status', 'PENDING')
      .lte('next_retry_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(5)

    if (error) {
      console.error('[OUTBOX] Gagal ambil jobs:', error)
      return
    }

    for (const job of jobs ?? []) {
      await sendOutboxJob(job)
    }
  } finally {
    outboxRunning = false
  }
}
```

```ts
async function sendOutboxJob(job: any) {
  const instanceId = process.env.INSTANCE_ID ?? `bot-${process.pid}`

  await supabase
    .from('wa_outbox')
    .update({
      status: 'SENDING',
      locked_by: instanceId,
      locked_at: new Date().toISOString(),
      attempts: job.attempts + 1,
    })
    .eq('id', job.id)
    .eq('status', 'PENDING')

  try {
    if (!isWaReady()) {
      throw new Error('WA socket not ready')
    }

    let result

    if (job.message_type === 'IMAGE' && job.image_url) {
      result = await sock.sendMessage(job.group_jid, {
        image: { url: job.image_url },
        caption: job.message,
      })
    } else {
      result = await sock.sendMessage(job.group_jid, {
        text: job.message,
      })
    }

    await supabase
      .from('wa_outbox')
      .update({
        status: 'SENT',
        sent_at: new Date().toISOString(),
        wa_message_id: result?.key?.id ?? null,
        last_error: null,
        locked_by: null,
        locked_at: null,
      })
      .eq('id', job.id)

    console.log(`[OUTBOX] ✅ Sent: ${job.dedupe_key}`)
  } catch (err) {
    const message = String((err as any)?.message ?? err)
    const nextAttempts = job.attempts + 1
    const isFinal = nextAttempts >= job.max_attempts

    const retryDelayMs = Math.min(5 * 60_000, 15_000 * nextAttempts)

    await supabase
      .from('wa_outbox')
      .update({
        status: isFinal ? 'FAILED' : 'PENDING',
        last_error: message,
        next_retry_at: new Date(Date.now() + retryDelayMs).toISOString(),
        locked_by: null,
        locked_at: null,
      })
      .eq('id', job.id)

    console.error(`[OUTBOX] ❌ Failed: ${job.dedupe_key}`, message)
  }
}
```

Jalankan worker interval:

```ts
setInterval(processOutbox, 10_000)
```

Dan panggil setelah WA open:

```ts
if (connection === 'open') {
  waConnectionState = 'open'
  await delay(3000)
  await processOutbox()
}
```

---

## F. Listener harus enqueue, bukan send langsung

Contoh untuk `trade_active_logs`:

```ts
supabase
  .channel('trade_active_logs_changes')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'trade_active_logs',
    },
    async (payload) => {
      const row: any = payload.new

      await enqueueWaMessage({
        sourceTable: 'trade_active_logs',
        sourceId: row.id,
        ticketId: row.ticket_id,
        eventType: 'TRADE_ACTIVE',
        groupJid: process.env.GROUP_JID!,
        messageType: row.image_url ? 'IMAGE' : 'TEXT',
        message: row.message,
        imageUrl: row.image_url,
        payload: row,
      })
    }
  )
  .subscribe()
```

Contoh untuk `trade_analytics`:

```ts
supabase
  .channel('trade_analytics_changes')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'trade_analytics',
    },
    async (payload) => {
      const row: any = payload.new

      const message =
`📊 Trade Closed
Ticket: ${row.ticket_id}
Symbol: ${row.symbol}
TF: ${row.timeframe}
Mode: ${row.mode}
Result: ${row.result}
Profit: ${row.profit}`

      await enqueueWaMessage({
        sourceTable: 'trade_analytics',
        sourceId: row.id,
        ticketId: row.ticket_id,
        eventType: 'TRADE_CLOSED',
        groupJid: process.env.GROUP_JID!,
        messageType: row.image_url ? 'IMAGE' : 'TEXT',
        message,
        imageUrl: row.image_url,
        payload: row,
      })
    }
  )
  .subscribe()
```

---

## G. Kalau Realtime `CHANNEL_ERROR`, cleanup dan daftar ulang

Jangan cuma:

```txt
listeners sudah terdaftar, skip
```

Karena channel bisa sudah error.

```ts
let listenerChannels: any[] = []
let listenersHealthy = false

async function cleanupListeners() {
  for (const ch of listenerChannels) {
    try {
      await supabase.removeChannel(ch)
    } catch {}
  }

  listenerChannels = []
  listenersHealthy = false
}

async function registerListeners() {
  if (listenersHealthy) {
    console.log('[LISTENER] Sudah sehat, skip.')
    return
  }

  await cleanupListeners()

  const tradeChannel = supabase
    .channel('trade_analytics_changes')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'trade_analytics' },
      async (payload) => {
        console.log('[LISTENER] New trade:', payload.new)
        // enqueue di sini
      }
    )
    .subscribe((status) => {
      console.log('[LISTENER] trade_analytics:', status)

      if (status === 'SUBSCRIBED') {
        listenersHealthy = true
      }

      if (
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        listenersHealthy = false
        setTimeout(registerListeners, 5000)
      }
    })

  listenerChannels.push(tradeChannel)
}
```

---

## H. Cron jangan start berkali-kali

```ts
let cronStarted = false

function startCronOnce() {
  if (cronStarted) {
    console.log('[CRON] Sudah jalan, skip.')
    return
  }

  cronStarted = true
  console.log('[CRON] Starting PDF Report schedulers...')

  // start cron di sini
}
```

---

## I. Hindari recursive `startBot()` yang numpuk

Kalau connection close:

```ts
if (connection === 'close') {
  waConnectionState = 'close'

  if (shouldReconnect) {
    setTimeout(() => {
      startWhatsAppSocketOnly()
    }, 5000)
  }
}
```

Jangan biarkan setiap reconnect ikut daftar listener dan cron lagi.

Ideal struktur:

```txt
main()
├── acquireLock()
├── startCronOnce()
├── registerListeners()
├── startOutboxWorker()
└── startWhatsAppSocket()
```

Saat WA reconnect, yang diulang cukup:

```txt
startWhatsAppSocket()
```

Bukan semua aplikasi.

---

# Final action plan

Urutan yang paling aman lo kerjain:

1. **Run SQL hardening RLS + revoke grants.**
2. **Pastikan `whatsapp_sessions`, `whatsapp_auth_keys`, `wa_outbox` cuma `service_role`.**
3. **Pastikan Node.js pakai `SUPABASE_SERVICE_ROLE_KEY`, bukan anon key.**
4. **Tambahkan `wa_outbox`.**
5. **Ubah listener: insert event → enqueue outbox, bukan langsung kirim WA.**
6. **Tambahkan worker retry.**
7. **Ubah auth logic: `fetch failed` jangan init fresh credentials.**
8. **Fix listener reconnect: `CHANNEL_ERROR` harus cleanup dan subscribe ulang.**
9. **Pastikan cron cuma start sekali.**
10. Kalau masih muncul `Bad MAC` / decrypt error, baru **reset session + scan QR ulang**.

Poin paling penting: **Supabase harus jadi sumber data yang aman, lalu Node.js harus punya outbox retry.** Dengan dua ini, walaupun WA close atau Supabase Realtime sempat error, pesan tidak akan hilang lagi.
