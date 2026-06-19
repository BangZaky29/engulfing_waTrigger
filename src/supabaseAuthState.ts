import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';

const SESSION_ID = 'main_session';

// =========================================================
// Helper: Deteksi apakah error adalah network error
// (bukan logic error seperti RLS / permission denied)
// =========================================================
function isNetworkError(err: any): boolean {
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

// =========================================================
// Helper: Delay
// =========================================================
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function useSupabaseAuthState(supabase: any): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}> {

  // =========================================================
  // 1. Load credentials dari whatsapp_auth_keys
  //    PENTING: Bedain antara:
  //    - Network error  → HARUS retry, jangan init fresh
  //    - Data kosong    → boleh init fresh credentials
  //    - Auth error     → stop, butuh fix Supabase
  // =========================================================
  let creds: any = null;
  let success = false;
  let retries = 5;
  let lastError: any = null;

  while (!success && retries > 0) {
    try {
      const { data, error } = await supabase
        .from('whatsapp_auth_keys')
        .select('value')
        .eq('session_id', SESSION_ID)
        .eq('key_type', 'creds')
        .eq('key_id', 'creds')
        .maybeSingle();

      if (error) {
        // Cek apakah ini error permission/logic (langsung stop)
        if (
          error.code === 'PGRST301' ||
          error.code === '42501' ||
          error.message?.includes('permission denied') ||
          error.message?.includes('RLS')
        ) {
          console.error('[AUTH] ❌ Permission error dari Supabase (RLS/policy):', error.message);
          console.error('[AUTH] Pastikan bot menggunakan SUPABASE_SERVICE_KEY, bukan anon key!');
          throw new Error(`Supabase permission error: ${error.message}`);
        }

        // Error lain → retry
        console.error('[AUTH] Error membaca creds dari Supabase:', error.message);
        console.log(`[AUTH] Membaca creds gagal, mencoba kembali dalam 5 detik... (${retries - 1} sisa percobaan)`);
        lastError = error;
        await delay(5000);
        retries--;
        continue;
      }

      if (data?.value) {
        console.log('[AUTH] Creds ditemukan di Supabase. Memuat...');
        creds = JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
        console.log(`[AUTH] ✅ Creds berhasil dimuat. creds.me = ${JSON.stringify(creds?.me)}`);
      } else {
        // Row tidak ada sama sekali = belum pernah scan QR → fresh credentials DIIZINKAN
        console.log('[AUTH] Creds kosong atau belum ada. Akan inisialisasi fresh credentials.');
      }

      success = true;
    } catch (e: any) {
      // Kalau ini network error → JANGAN init fresh, harus retry
      if (isNetworkError(e)) {
        console.error(`[AUTH] 🌐 Network error saat membaca creds: ${e?.message || e}`);
        console.log(`[AUTH] Ini adalah network error, TIDAK akan init fresh credentials.`);
        console.log(`[AUTH] Mencoba kembali dalam 5 detik... (${retries - 1} sisa percobaan)`);
        lastError = e;
        await delay(5000);
        retries--;
        continue;
      }

      // Error non-network (mis. permission/RLS) → langsung throw
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
  if (!creds) {
    creds = initAuthCreds();
    console.log('[AUTH] ✅ Fresh credentials initialized (belum ada data di Supabase).');
  }

  // =========================================================
  // 2. Fungsi simpan creds ke Supabase
  // =========================================================
  const saveCreds = async () => {
    try {
      const value = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      const { error } = await supabase
        .from('whatsapp_auth_keys')
        .upsert({
          session_id: SESSION_ID,
          key_type: 'creds',
          key_id: 'creds',
          value,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_id,key_type,key_id' });

      if (error) {
        console.error('[AUTH] Error menyimpan creds ke Supabase:', error.message);
      } else {
        console.log('[AUTH] ✅ Creds berhasil disimpan ke Supabase.');
      }
    } catch (e: any) {
      console.error('[AUTH] Exception saat menyimpan creds:', e?.message || e);
    }
  };

  // =========================================================
  // 3. Fungsi clear state (dipanggil saat logout/reconnect)
  //    Hapus seluruh keys dari whatsapp_auth_keys & reset status
  // =========================================================
  const clearState = async () => {
    try {
      console.log('[AUTH] Menghapus auth keys dari Supabase...');

      const { error: deleteError } = await supabase
        .from('whatsapp_auth_keys')
        .delete()
        .eq('session_id', SESSION_ID);

      if (deleteError) {
        console.error('[AUTH] Error menghapus auth keys dari Supabase:', deleteError.message);
      }

      const { error: sessionError } = await supabase
        .from('whatsapp_sessions')
        .update({
          status: 'UNPAIRED',
          qr_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', SESSION_ID);

      if (sessionError) {
        console.error('[AUTH] Error mengupdate status session di Supabase:', sessionError.message);
      }

      const { error: publicError } = await supabase
        .from('whatsapp_public_status')
        .upsert({
          id: SESSION_ID,
          status: 'UNPAIRED',
          qr_code: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });

      if (publicError) {
        console.error('[AUTH] Error mengupdate status public session di Supabase:', publicError.message);
      }

      // Reset local creds
      Object.assign(creds, initAuthCreds());
      console.log('[AUTH] ✅ Session dan auth keys berhasil di-clear.');
    } catch (e: any) {
      console.error('[AUTH] Error clearing state:', e?.message || e);
    }
  };

  // =========================================================
  // 4. Return state object dengan dynamic async keys
  // =========================================================
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [key: string]: any } = {};
          try {
            const { data: rows, error } = await supabase
              .from('whatsapp_auth_keys')
              .select('key_id, value')
              .eq('session_id', SESSION_ID)
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
        },
        set: async (data) => {
          const upserts: any[] = [];

          for (const category in data) {
            for (const id in data[category as keyof SignalDataTypeMap]) {
              const value = data[category as keyof SignalDataTypeMap]?.[id];
              if (value) {
                upserts.push({
                  session_id: SESSION_ID,
                  key_type: category,
                  key_id: id,
                  value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
                  updated_at: new Date().toISOString()
                });
              } else {
                // Nilai null = hapus key ini
                try {
                  await supabase
                    .from('whatsapp_auth_keys')
                    .delete()
                    .eq('session_id', SESSION_ID)
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
              const { error } = await supabase
                .from('whatsapp_auth_keys')
                .upsert(upserts, { onConflict: 'session_id,key_type,key_id' });
              if (error) {
                console.error('[AUTH] Error upserting keys:', error.message);
              }
            } catch (e: any) {
              console.error('[AUTH] Exception upserting keys:', e?.message || e);
            }
          }
        },
      },
    },
    saveCreds,
    clearState,
  };
}
