import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';

const SESSION_ID = 'main_session';

export async function useSupabaseAuthState(supabase: any): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}> {

  // =========================================================
  // 1. Load credentials dari whatsapp_auth_keys
  // =========================================================
  let creds: any = null;

  try {
    const { data, error } = await supabase
      .from('whatsapp_auth_keys')
      .select('value')
      .eq('session_id', SESSION_ID)
      .eq('key_type', 'creds')
      .eq('key_id', 'creds')
      .maybeSingle();

    if (error) {
      console.error('[AUTH] Error membaca creds dari Supabase:', error.message);
    } else if (data?.value) {
      console.log('[AUTH] Creds ditemukan di Supabase. Memuat...');
      creds = JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
      console.log(`[AUTH] ✅ Creds berhasil dimuat. creds.me = ${JSON.stringify(creds?.me)}`);
    } else {
      console.log('[AUTH] Creds kosong atau belum ada. Inisialisasi fresh credentials...');
    }
  } catch (e: any) {
    console.error('[AUTH] Exception saat membaca creds:', e?.message || e);
  }

  // Jika creds null/tidak valid, init fresh
  if (!creds) {
    creds = initAuthCreds();
    console.log('[AUTH] Fresh credentials initialized.');
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
      }
    } catch (e: any) {
      console.error('[AUTH] Exception saat menyimpan creds:', e?.message || e);
    }
  };

  // =========================================================
  // 3. Fungsi clear state (dipanggil saat logout/reconnect)
  //    Hapus seluruh keys dari whatsapp_auth_keys & reset status whatsapp_sessions
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
