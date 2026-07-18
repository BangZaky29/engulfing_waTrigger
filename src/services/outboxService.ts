import { supabase } from './supabaseClient';

let outboxRunning = false;

export async function enqueueWaMessage(input: {
  sourceTable: string;
  sourceId?: number;
  ticketId?: number;
  eventType: string;
  groupJid: string;
  messageType: 'TEXT' | 'IMAGE' | 'DOCUMENT';
  message: string;
  imageUrl?: string | null;
  payload?: any;
}) {
  const dedupeKey = [
    input.sourceTable,
    input.ticketId ?? input.sourceId ?? 'noid',
    input.eventType,
    input.groupJid,
    input.messageType,
  ].join(':');

  console.log(`[OUTBOX] Enqueuing message for dedupe key: ${dedupeKey}`);

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
    );

  if (error) {
    console.error('[OUTBOX] Gagal enqueue WA message:', error.message);
  } else {
    console.log('[OUTBOX] ✅ Message enqueued.');
  }
}

export async function processOutbox(sock: any, isWaReady: () => boolean, instanceId: string) {
  if (outboxRunning) return;
  if (!isWaReady()) return;

  outboxRunning = true;

  try {
    const { data: jobs, error } = await supabase
      .from('wa_outbox')
      .select('*')
      .eq('status', 'PENDING')
      .lte('next_retry_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(5);

    if (error) {
      console.error('[OUTBOX] Gagal ambil jobs:', error.message);
      return;
    }

    if (jobs && jobs.length > 0) {
      console.log(`[OUTBOX] Processing ${jobs.length} pending jobs...`);
      for (const job of jobs) {
        await sendOutboxJob(sock, job, isWaReady, instanceId);
      }
    }
  } catch (err: any) {
    console.error('[OUTBOX] Exception in processOutbox:', err?.message || err);
  } finally {
    outboxRunning = false;
  }
}

async function sendOutboxJob(sock: any, job: any, isWaReady: () => boolean, instanceId: string) {
  // Lock job first
  const { error: lockError } = await supabase
    .from('wa_outbox')
    .update({
      status: 'SENDING',
      locked_by: instanceId,
      locked_at: new Date().toISOString(),
      attempts: job.attempts + 1,
    })
    .eq('id', job.id)
    .eq('status', 'PENDING');

  if (lockError) {
    console.error(`[OUTBOX] Gagal lock job ${job.id}:`, lockError.message);
    return;
  }

  try {
    if (!isWaReady()) {
      throw new Error('WA socket not ready during execution');
    }

    let result;

    if (job.message_type === 'IMAGE' && job.image_url) {
      console.log(`[OUTBOX] Sending image message to ${job.group_jid} for key: ${job.dedupe_key}`);
      result = await sock.sendMessage(job.group_jid, {
        image: { url: job.image_url },
        caption: job.message,
      });
    } else {
      console.log(`[OUTBOX] Sending text message to ${job.group_jid} for key: ${job.dedupe_key}`);
      result = await sock.sendMessage(job.group_jid, {
        text: job.message,
      });
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
      .eq('id', job.id);

    console.log(`[OUTBOX] ✅ Sent: ${job.dedupe_key}`);
  } catch (err: any) {
    const message = String(err?.message ?? err);
    console.error(`[OUTBOX] ❌ Failed to send ${job.dedupe_key}:`, message);

    const nextAttempts = job.attempts + 1;
    const isFinal = nextAttempts >= job.max_attempts;
    const retryDelayMs = Math.min(5 * 60_000, 15_000 * nextAttempts);

    await supabase
      .from('wa_outbox')
      .update({
        status: isFinal ? 'FAILED' : 'PENDING',
        last_error: message,
        next_retry_at: new Date(Date.now() + retryDelayMs).toISOString(),
        locked_by: null,
        locked_at: null,
      })
      .eq('id', job.id);
  }
}
