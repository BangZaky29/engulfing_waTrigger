import { SupabaseClient } from '@supabase/supabase-js';

export async function acquireLock(supabase: SupabaseClient, sessionId: string, instanceId: string): Promise<boolean> {
  try {
    const { data: session, error } = await supabase
      .from('whatsapp_sessions')
      .select('owner_id, locked_at')
      .eq('id', sessionId)
      .maybeSingle();

    if (error) {
      console.error('[LOCK] Error reading lock status:', error.message);
      return false;
    }

    if (!session) {
      console.error('[LOCK] Session not found in database.');
      return false;
    }

    const now = Date.now();
    const lockedAtTime = session.locked_at ? new Date(session.locked_at).getTime() : 0;
    const isStale = !session.locked_at || (now - lockedAtTime > 60000); // 1 minute stale threshold

    // Case 1: Unlocked
    if (!session.owner_id) {
      const { error: updateError } = await supabase
        .from('whatsapp_sessions')
        .update({
          owner_id: instanceId,
          locked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', sessionId)
        .is('owner_id', null);

      if (!updateError) {
        console.log('[LOCK] Lock acquired successfully (was unlocked).');
        return true;
      }
      console.warn('[LOCK] Failed to acquire lock (was unlocked but claimed by someone else).');
      return false;
    }

    // Case 2: Already locked by us
    if (session.owner_id === instanceId) {
      const { error: updateError } = await supabase
        .from('whatsapp_sessions')
        .update({
          locked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', sessionId)
        .eq('owner_id', instanceId);

      if (!updateError) {
        return true;
      }
      return false;
    }

    // Case 3: Locked by another instance but stale
    if (isStale) {
      console.log(`[LOCK] Lock is stale (held by ${session.owner_id} since ${session.locked_at}). Attempting to override...`);
      const { error: updateError } = await supabase
        .from('whatsapp_sessions')
        .update({
          owner_id: instanceId,
          locked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', sessionId)
        .eq('owner_id', session.owner_id);

      if (!updateError) {
        console.log(`[LOCK] Lock overridden successfully. New owner: ${instanceId}`);
        return true;
      }
      console.warn('[LOCK] Failed to override stale lock.');
      return false;
    }

    // Case 4: Locked by another active instance
    console.warn(`[LOCK] ⚠️ Gagal start! Sesi sedang dikunci oleh instance lain (${session.owner_id}) yang aktif.`);
    return false;
  } catch (e: any) {
    console.error('[LOCK] Exception during lock acquisition:', e?.message || e);
    return false;
  }
}

export async function releaseLock(supabase: SupabaseClient, sessionId: string, instanceId: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('whatsapp_sessions')
      .update({
        owner_id: null,
        locked_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .eq('owner_id', instanceId);

    if (error) {
      console.error('[LOCK] Gagal melepaskan lock:', error.message);
    } else {
      console.log('[LOCK] Lock dilepaskan secara bersih.');
    }
  } catch (e: any) {
    console.error('[LOCK] Exception saat melepaskan lock:', e?.message || e);
  }
}

export function startLockHeartbeat(supabase: SupabaseClient, sessionId: string, instanceId: string) {
  return setInterval(async () => {
    try {
      const { error } = await supabase
        .from('whatsapp_sessions')
        .update({
          locked_at: new Date().toISOString()
        })
        .eq('id', sessionId)
        .eq('owner_id', instanceId);

      if (error) {
        console.warn('[LOCK] Heartbeat gagal, lock mungkin direbut atau terputus:', error.message);
      }
    } catch (e: any) {
      console.warn('[LOCK] Exception saat heartbeat (non-fatal):', e?.message || e);
    }
  }, 20000); // 20 detik
}
