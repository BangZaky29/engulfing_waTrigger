import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Karena file ini sekarang berada di src/config/, naik 2 tingkat untuk ke root wa_trigger
dotenv.config({ path: resolve(__dirname, '../../.env') }); // load local .env

// Load Python bot .env secara dinamis
const pythonEnvPath = process.env.ENGULFING_ENV_PATH || resolve(__dirname, '../../../../engulfing/.env');
if (fs.existsSync(pythonEnvPath)) {
  dotenv.config({ path: pythonEnvPath });
} else {
  console.warn(`\n[WARNING] Python .env tidak ditemukan di jalur: ${pythonEnvPath}`);
  console.warn(`[WARNING] Jika berjalan di Live Server, pastikan variabel konfigurasi (seperti MT5_SYMBOL, dll) sudah di-set langsung di Environment Variables OS/Server Anda.\n`);
}

export const SUPABASE_URL = process.env.SUPABASE_URL!;
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!;
export const GROUP_JID = process.env.GROUP_JID!;
export const PRIVATE_JID = process.env.PRIVATE_JID || GROUP_JID;
export const SKIP_SIGNAL = process.env.SKIP_SIGNAL || GROUP_JID;
export const PROFIT_SIGNAL = process.env.PROFIT_SIGNAL || GROUP_JID;
export const LOSS_SIGNAL = process.env.LOSS_SIGNAL || GROUP_JID;
export const GROUP_SAR = process.env.GROUP_SAR;
export const EXECUTOR = process.env.EXECUTOR;
export const SESSION_ID = 'main_session';
