import { supabase } from './src/services/supabaseClient.js';
import { SESSION_ID } from './src/config/env.js';

async function clearAuth() {
    console.log(`Clearing auth keys for session: ${SESSION_ID}`);
    const { error } = await supabase
        .from('whatsapp_auth_keys')
        .delete()
        .eq('session_id', SESSION_ID);
    
    if (error) {
        console.error('Error clearing auth:', error);
    } else {
        console.log('Successfully cleared auth keys.');
    }
}

clearAuth();
