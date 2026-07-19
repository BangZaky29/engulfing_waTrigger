// =====================================================
// services/supabaseAuthState.ts
// Class-based Supabase Auth State for WhatsApp (Baileys).
// Manages credentials storage & retrieval via Supabase.
// =====================================================

import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { SupabaseClient } from '@supabase/supabase-js';

// =====================================================
// SupabaseAuthState Class
// =====================================================

export class SupabaseAuthState {
  private supabase: SupabaseClient;
  private sessionId: string;
  private creds: any = null;

  private static readonly MAX_RETRIES = 5;
  private static readonly RETRY_DELAY_MS = 5000;

  constructor(supabase: SupabaseClient, sessionId: string) {
    this.supabase = supabase;
    this.sessionId = sessionId;
  }

  // =====================================================
  // Public API
  // =====================================================

  /**
   * Initialize auth state — load atau create fresh credentials.
   * Return object compatible dengan Baileys useMultiFileAuthState.
   */
  async initialize(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clearState: () => Promise<void>;
  }> {
    await this.loadCreds();

    return {
      state: {
        creds: this.creds,
        keys: {
          get: (type: any, ids: any) => this.getKeys(type, ids),
          set: (data: any) => this.setKeys(data),
        },
      },
      saveCreds: () => this.saveCreds(),
      clearState: () => this.clearState(),
    };
  }

  // =====================================================
  // Credential Management
  // =====================================================

  /**
   * Load credentials dari Supabase dengan retry logic.
   * Bedakan antara:
   * - Network error → HARUS retry, jangan init fresh
   * - Data kosong   → boleh init fresh credentials
   * - Auth error    → stop, butuh fix Supabase
   */
  private async loadCreds(): Promise<void> {
    let success = false;
    let retries = SupabaseAuthState.MAX_RETRIES;
    let lastError: any = null;

    while (!success && retries > 0) {
      try {
        const { data, error } = await this.supabase
          .from('whatsapp_auth_keys')
          .select('value')
          .eq('session_id', this.sessionId)
          .eq('key_type', 'creds')
          .eq('key_id', 'creds')
          .maybeSingle();

        if (error) {
          if (this.isPermissionError(error)) {
            console.error('[AUTH] ❌ Permission error dari Supabase (RLS/policy):', error.message);
            console.error('[AUTH] Pastikan bot menggunakan SUPABASE_SERVICE_KEY, bukan anon key!');
            throw new Error(`Supabase permission error: ${error.message}`);
          }

          console.error('[AUTH] Error membaca creds dari Supabase:', error.message);
          console.log(`[AUTH] Membaca creds gagal, mencoba kembali dalam 5 detik... (${retries - 1} sisa percobaan)`);
          lastError = error;
          await this.delay(SupabaseAuthState.RETRY_DELAY_MS);
          retries--;
          continue;
        }

        if (data?.value) {
          console.log('[AUTH] Creds ditemukan di Supabase. Memuat...');
          this.creds = JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
          console.log(`[AUTH] ✅ Creds berhasil dimuat. creds.me = ${JSON.stringify(this.creds?.me)}`);
        } else {
          console.log('[AUTH] Creds kosong atau belum ada. Akan inisialisasi fresh credentials.');
        }

        success = true;
      } catch (e: any) {
        if (this.isNetworkError(e)) {
          console.error(`[AUTH] 🌐 Network error saat membaca creds: ${e?.message || e}`);
          console.log(`[AUTH] Ini adalah network error, TIDAK akan init fresh credentials.`);
          console.log(`[AUTH] Mencoba kembali dalam 5 detik... (${retries - 1} sisa percobaan)`);
          lastError = e;
          await this.delay(SupabaseAuthState.RETRY_DELAY_MS);
          retries--;
          continue;
        }

        console.error('[AUTH] ❌ Fatal exception saat membaca creds:', e?.message || e);
        throw e;
      }
    }

    if (!success) {
      const errMsg = `Gagal menghubungkan ke database Supabase untuk memuat auth credentials. Last error: ${lastError?.message || lastError}`;
      console.error(`[AUTH] ❌ ${errMsg}`);
      throw new Error(errMsg);
    }

    // Hanya init fresh jika benar-benar tidak ada data (bukan karena network error)
    if (!this.creds) {
      this.creds = initAuthCreds();
      console.log('[AUTH] ✅ Fresh credentials initialized (belum ada data di Supabase).');
    }
  }

  /**
   * Simpan credentials ke Supabase.
   */
  async saveCreds(): Promise<void> {
    try {
      const value = JSON.parse(JSON.stringify(this.creds, BufferJSON.replacer));
      const { error } = await this.supabase
        .from('whatsapp_auth_keys')
        .upsert({
          session_id: this.sessionId,
          key_type: 'creds',
          key_id: 'creds',
          value,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'session_id,key_type,key_id' });

      if (error) {
        console.error('[AUTH] Error menyimpan creds ke Supabase:', error.message);
      } else {
        console.log('[AUTH] ✅ Creds berhasil disimpan ke Supabase.');
      }
    } catch (e: any) {
      console.error('[AUTH] Exception saat menyimpan creds:', e?.message || e);
    }
  }

  /**
   * Clear semua auth keys dan reset status session.
   * Dipanggil saat logout/reconnect.
   */
  async clearState(): Promise<void> {
    try {
      console.log('[AUTH] Menghapus auth keys dari Supabase...');

      const { error: deleteError } = await this.supabase
        .from('whatsapp_auth_keys')
        .delete()
        .eq('session_id', this.sessionId);

      if (deleteError) {
        console.error('[AUTH] Error menghapus auth keys dari Supabase:', deleteError.message);
      }

      const { error: sessionError } = await this.supabase
        .from('whatsapp_sessions')
        .update({
          status: 'UNPAIRED',
          qr_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', this.sessionId);

      if (sessionError) {
        console.error('[AUTH] Error mengupdate status session di Supabase:', sessionError.message);
      }

      const { error: publicError } = await this.supabase
        .from('whatsapp_public_status')
        .upsert({
          id: this.sessionId,
          status: 'UNPAIRED',
          qr_code: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });

      if (publicError) {
        console.error('[AUTH] Error mengupdate status public session di Supabase:', publicError.message);
      }

      // Reset local creds
      Object.assign(this.creds, initAuthCreds());
      console.log('[AUTH] ✅ Session dan auth keys berhasil di-clear.');
    } catch (e: any) {
      console.error('[AUTH] Error clearing state:', e?.message || e);
    }
  }

  // =====================================================
  // Key Management (untuk Baileys signal keys)
  // =====================================================

  /**
   * Get signal keys by type & ids.
   */
  private async getKeys(type: string, ids: string[]): Promise<{ [key: string]: any }> {
    const data: { [key: string]: any } = {};

    try {
      const { data: rows, error } = await this.supabase
        .from('whatsapp_auth_keys')
        .select('key_id, value')
        .eq('session_id', this.sessionId)
        .eq('key_type', type)
        .in('key_id', ids);

      if (error) {
        console.error(`[AUTH] Error getting keys for ${type}:`, error.message);
        return data;
      }

      if (rows) {
        for (const row of rows) {
          let value = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[row.key_id] = value;
        }
      }
    } catch (e: any) {
      console.error(`[AUTH] Exception getting keys for ${type}:`, e?.message || e);
    }

    return data;
  }

  /**
   * Set (upsert/delete) signal keys.
   */
  private async setKeys(data: any): Promise<void> {
    const upserts: any[] = [];

    for (const category in data) {
      for (const id in data[category as keyof SignalDataTypeMap]) {
        const value = data[category as keyof SignalDataTypeMap]?.[id];
        if (value) {
          upserts.push({
            session_id: this.sessionId,
            key_type: category,
            key_id: id,
            value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
            updated_at: new Date().toISOString(),
          });
        } else {
          // Nilai null = hapus key ini
          try {
            await this.supabase
              .from('whatsapp_auth_keys')
              .delete()
              .eq('session_id', this.sessionId)
              .eq('key_type', category)
              .eq('key_id', id);
          } catch (e: any) {
            console.error(`[AUTH] Exception deleting key ${category}/${id}:`, e?.message || e);
          }
        }
      }
    }

    if (upserts.length > 0) {
      try {
        const { error } = await this.supabase
          .from('whatsapp_auth_keys')
          .upsert(upserts, { onConflict: 'session_id,key_type,key_id' });
        if (error) {
          console.error('[AUTH] Error upserting keys:', error.message);
        }
      } catch (e: any) {
        console.error('[AUTH] Exception upserting keys:', e?.message || e);
      }
    }
  }

  // =====================================================
  // Error Classification Helpers
  // =====================================================

  /**
   * Deteksi apakah error adalah network error
   * (bukan logic error seperti RLS / permission denied).
   */
  private isNetworkError(err: any): boolean {
    const msg = String(err?.message ?? err?.code ?? err ?? '').toLowerCase();
    return (
      msg.includes('fetch failed') ||
      msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('enotfound') ||
      msg.includes('econnrefused') ||
      msg.includes('network') ||
      msg.includes('socket hang up') ||
      msg.includes('aborted')
    );
  }

  /**
   * Deteksi apakah error adalah permission/RLS error.
   */
  private isPermissionError(error: any): boolean {
    return (
      error.code === 'PGRST301' ||
      error.code === '42501' ||
      error.message?.includes('permission denied') ||
      error.message?.includes('RLS')
    );
  }

  /**
   * Simple delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =====================================================
// Backward-compatible function export
// waSocket.ts masih bisa:
//   import { useSupabaseAuthState } from './supabaseAuthState';
// =====================================================
export async function useSupabaseAuthState(supabase: SupabaseClient): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}> {
  const authState = new SupabaseAuthState(supabase, 'main_session');
  return authState.initialize();
}
