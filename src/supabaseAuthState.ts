import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';

const SESSION_ID = 'main_session';

export async function useSupabaseAuthState(supabase: any): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void>, clearState: () => Promise<void> }> {
  
  // Read session from Supabase
  let sessionData: any = {};
  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('id', SESSION_ID)
      .single();
      
    if (data && (data as any).session_data) {
      // Parse JSON stringified with BufferJSON if it was stringified,
      // but in JSONB it's already an object, so we convert it to string then parse with BufferJSON
      sessionData = JSON.parse(JSON.stringify((data as any).session_data), BufferJSON.reviver);
    }
  } catch (error) {
    console.error('Error reading session from Supabase:', error);
  }

  const creds = sessionData.creds || initAuthCreds();
  const keys: any = sessionData.keys || {};

  const saveState = async () => {
    try {
      const dataToSave = JSON.parse(JSON.stringify({ creds, keys }, BufferJSON.replacer));
      await supabase
        .from('whatsapp_sessions')
        .update({ session_data: dataToSave })
        .eq('id', SESSION_ID);
    } catch (error) {
      console.error('Error saving session to Supabase:', error);
    }
  };

  const clearState = async () => {
    try {
      await supabase
        .from('whatsapp_sessions')
        .update({ 
          session_data: '{}',
          status: 'UNPAIRED',
          qr_code: null
        })
        .eq('id', SESSION_ID);
      
      // Reset local state
      Object.keys(keys).forEach(k => delete keys[k]);
      Object.assign(creds, initAuthCreds());
    } catch (error) {
      console.error('Error clearing session:', error);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data: { [key: string]: any } = {};
          for (const id of ids) {
            let value = keys[type]?.[id];
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
          saveState();
        }
      }
    },
    saveCreds: () => saveState(),
    clearState
  };
}
