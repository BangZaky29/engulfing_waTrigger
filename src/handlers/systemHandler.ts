import { sock } from '../services/waSocket';
import { GROUP_JID, PRIVATE_JID, SKIP_SIGNAL } from '../config/env';
import { delay } from '../utils/helpers';

export async function sendStartupMessage(retryCount = 0): Promise<void> {
  const MAX_RETRY = 5;
  const RETRY_DELAY = 3000;

  if (!sock || !GROUP_JID || !PRIVATE_JID || !SKIP_SIGNAL) {
    console.log(`[STARTUP] sock atau GROUP_JID/PRIVATE_JID/SKIP_SIGNAL belum siap, skip.`);
    return;
  }

  try {
    const now = new Date();
    const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tgl = now.toLocaleDateString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    const rawPairs = process.env.MT5_SYMBOLS ? process.env.MT5_SYMBOLS.split('#')[0].trim() : 'XAUUSD';
    const pairsArray = rawPairs.split(',').map(s => s.trim());
    const pairs = pairsArray.join(', ');
    
    const defaultTf = (process.env.STRATEGY_TIMEFRAME || 'M5').split('#')[0].trim();
    const tfList = pairsArray.map(sym => {
        const override = process.env[`TF_${sym}`];
        return `${sym}(${override ? override.split('#')[0].trim() : defaultTf})`;
    });
    const tfInfo = tfList.join(', ');
    
    const infoTfs = (process.env.INFO_TIMEFRAMES || 'M15,H1').split('#')[0].trim();

    const activeFilter = process.env.ACTIVE_FILTER_STRATEGY ? `Filter ${process.env.ACTIVE_FILTER_STRATEGY.split('#')[0].trim()}` : 'Filter B';
    const minGradeInfo = (process.env.MIN_GRADE_ALLOWED || 'C+').split('#')[0].trim();

    const startupMsg =
      `🟢 *SISTEM AKTIF* 🟢\n\n` +
      `🤖 *Engulfing Analytics Bot* telah berhasil dinyalakan dan siap beroperasi.\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📅 Tanggal : ${tgl}\n` +
      `🕐 Waktu   : ${jam} WIB\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `⚙️ *KONFIGURASI AKTIF:*\n` +
      `🔸 *Pairs:* ${pairs}\n` +
      `🔸 *Execute TF:* ${tfInfo}\n` +
      `🔸 *Info TFs:* ${infoTfs}\n` +
      `🔸 *Strategy:* ${activeFilter}\n` +
      `🔸 *Min Grade:* ${minGradeInfo}\n\n` +
      `✅ Multi-Currency Scanner aktif\n` +
      `✅ Listener sinyal Realtime aktif\n` +
      `✅ Laporan otomatis terjadwal\n\n` +
      `_Bot akan mengirim notifikasi OP jika market memenuhi kriteria di atas._ 🚀`;

    console.log(`[STARTUP] Mencoba kirim pesan ke ${GROUP_JID}, ${PRIVATE_JID}, dan ${SKIP_SIGNAL} (attempt ${retryCount + 1}/${MAX_RETRY})...`);

    try {
      await sock.groupMetadata(GROUP_JID);
      await delay(2000);
    } catch (e) {
      console.log(`[STARTUP] Warmup group gagal (bukan error fatal): ${e}`);
    }

    await sock.sendMessage(GROUP_JID, { text: startupMsg });
    if (PRIVATE_JID !== GROUP_JID) {
      await sock.sendMessage(PRIVATE_JID, { text: startupMsg });
    }
    if (SKIP_SIGNAL !== GROUP_JID && SKIP_SIGNAL !== PRIVATE_JID) {
      await sock.sendMessage(SKIP_SIGNAL, { text: startupMsg });
    }
    console.log('[STARTUP] ✅ Notifikasi startup BERHASIL dikirim ke grup WA!');

  } catch (e: any) {
    console.error(`[STARTUP] ❌ Gagal kirim startup (attempt ${retryCount + 1}): ${e?.message || e}`);

    if (retryCount < MAX_RETRY - 1) {
      console.log(`[STARTUP] Retry dalam ${RETRY_DELAY / 1000} detik...`);
      await delay(RETRY_DELAY);
      await sendStartupMessage(retryCount + 1);
    } else {
      console.error('[STARTUP] ❌ Semua retry habis. Startup message tidak terkirim.');
    }
  }
}

export async function sendShutdownMessage(message: string): Promise<void> {
  if (!sock) {
    console.log('[SHUTDOWN] Socket belum siap, skip kirim shutdown message.');
    return;
  }

  const targets = [GROUP_JID, PRIVATE_JID, SKIP_SIGNAL].filter((jid, index, arr) => jid && arr.indexOf(jid) === index);
  for (const groupJid of targets) {
    try {
      await sock.sendMessage(groupJid, { text: message });
      console.log(`[SHUTDOWN] Pesan mati dikirim ke ${groupJid}`);
    } catch (e: any) {
      console.error(`[SHUTDOWN] Gagal kirim pesan ke ${groupJid}: ${e?.message || e}`);
    }
  }
}
