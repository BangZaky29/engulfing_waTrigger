import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';

const SESSION_ID = 'main_session';

export async function useSupabaseAuthState(supabase: any): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}> {

  // =========================================================
  // 1. Load session dari Supabase
  // =========================================================
  let creds: any = null;
  let keys: any = {};

  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('session_data, status')
      .eq('id', SESSION_ID)
      .single();

    if (error) {
      console.error('[AUTH] Error membaca session dari Supabase:', error.message);
    } else if (data?.session_data && Object.keys(data.session_data).length > 0) {
      // Ada session data — parse dengan BufferJSON reviver untuk restore Buffer objects
      console.log(`[AUTH] Session ditemukan di Supabase (status: ${data.status}). Memuat...`);
      const parsed = JSON.parse(JSON.stringify(data.session_data), BufferJSON.reviver);
      creds = parsed.creds || null;
      keys  = parsed.keys  || {};
      console.log(`[AUTH] ✅ Session berhasil dimuat. creds.me = ${JSON.stringify(creds?.me)}`);
    } else {
      console.log('[AUTH] Session kosong atau belum ada. Inisialisasi fresh credentials...');
    }
  } catch (e: any) {
    console.error('[AUTH] Exception saat baca session:', e?.message || e);
  }

  // Jika creds null/tidak valid, init fresh
  if (!creds) {
    creds = initAuthCreds();
    console.log('[AUTH] Fresh credentials initialized.');
  }

  // =========================================================
  // 2. Fungsi simpan state ke Supabase
  // =========================================================
  const saveState = async () => {
    try {
      const dataToSave = JSON.parse(JSON.stringify({ creds, keys }, BufferJSON.replacer));
      await supabase
        .from('whatsapp_sessions')
        .update({ session_data: dataToSave, updated_at: new Date().toISOString() })
        .eq('id', SESSION_ID);
    } catch (e: any) {
      console.error('[AUTH] Error menyimpan session:', e?.message || e);
    }
  };

  // =========================================================
  // 3. Fungsi clear state (dipanggil saat logout)
  //    Hapus session_data → bot akan minta QR baru saat restart
  // =========================================================
  const clearState = async () => {
    try {
      console.log('[AUTH] Menghapus session dari Supabase...');
      await supabase
        .from('whatsapp_sessions')
        .update({
          session_data: {},
          status: 'UNPAIRED',
          qr_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', SESSION_ID);

      // Reset local in-memory state
      Object.keys(keys).forEach(k => delete keys[k]);
      Object.assign(creds, initAuthCreds());

      console.log('[AUTH] ✅ Session berhasil dihapus. Bot siap scan QR baru.');
    } catch (e: any) {
      console.error('[AUTH] Error menghapus session:', e?.message || e);
    }
  };

  // =========================================================
  // 4. Return state object
  // =========================================================
  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data: { [key: string]: any } = {};
          for (const id of ids) {
            let value = keys[type]?.[id];
            // Baileys membutuhkan Uint8Array bukan Buffer untuk app-state-sync-key
            if (type === 'app-state-sync-key' && value) {
              value = { ...value, syncKey: new Uint8Array(value.syncKey) };
            }
            data[id] = value;
          }
          return data;
        },
        set: (data) => {
          for (const category in data) {
            for (const id in data[category as keyof SignalDataTypeMap]) {
              const value = data[category as keyof SignalDataTypeMap]?.[id];
              keys[category] = keys[category] || {};
              if (value) {
                keys[category][id] = value;
              } else {
                delete keys[category][id];
              }
            }
          }
          // Save setiap kali keys berubah (Signal Protocol key updates)
          saveState();
        },
      },
    },
    saveCreds: () => saveState(),
    clearState,
  };
}
