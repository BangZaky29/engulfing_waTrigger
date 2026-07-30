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

    // === EMA & Execution Variables ===
    const emaFast = process.env.EMA_FAST || '10';
    const emaSlow = process.env.EMA_SLOW || '20';
    const tfmEmaFilter = process.env.TFM_USE_EMA_FILTER?.toLowerCase() === 'true' ? 'ON' : 'OFF';
    const lookbackBars = process.env.TFM_TRIGGER_LOOKBACK_BARS || '200';
    const tfmBlocking = process.env.TFM_BLOCKING?.toLowerCase() === 'true' ? 'ON (WAIT/LATE = skip)' : 'OFF';

    const opMode = process.env.EXECUTION_USE_LIMIT?.toLowerCase() === 'true' ? 'PENDING ORDER (Limit)' : 'MARKET (Langsung Execute)';
    const slMode = process.env.EXECUTION_SL_PCT_B ? `Dinamis — ${process.env.EXECUTION_SL_PCT_B}% ekor candle H1 trigger` : 'Statis';
    const tpMode = process.env.EXECUTION_TP_MODE_B === 'USD' ? `Statis USD — Target dinamis per mata uang (default $${process.env.EXECUTION_TP_TARGET_USD_B || '700.0'})` : `Dinamis PCT — ${process.env.EXECUTION_TP_PCT}% jarak OP→SL`;

    const lotList = pairsArray.map(sym => {
        let cleanSym = sym.replace(/-/g, '_').replace(/ /g, '_');
        let override = process.env[`LOT_${cleanSym}`] || process.env[`LOT_${sym}`];
        if (!override && (sym === 'BTC' || sym === 'BTCUSD')) override = process.env.LOT_Bitcoin || process.env.LOT_BTC;
        if (!override && (sym === 'NASDAQ-100' || sym === 'US100')) override = process.env.LOT_NASDAQ_100;
        return `${sym}=${override ? override.split('#')[0].trim() : '0.01'}`;
    });
    const lotInfo = lotList.join(', ');

    const defaultTpUsd = (process.env.EXECUTION_TP_TARGET_USD_B || '700.0').split('#')[0].trim();
    const tpUsdList = pairsArray.map(sym => {
        let cleanSym = sym.replace(/-/g, '_').replace(/ /g, '_');
        let override = process.env[`TP_USD_${cleanSym}`] || process.env[`TP_USD_${sym}`];
        if (!override && (sym === 'BTC' || sym === 'BTCUSD')) override = process.env.TP_USD_Bitcoin || process.env.TP_USD_BTC;
        if (!override && (sym === 'NASDAQ-100' || sym === 'US100')) override = process.env.TP_USD_NASDAQ_100;
        return `${sym}=$${override ? override.split('#')[0].trim() : defaultTpUsd}`;
    });
    const tpUsdInfo = tpUsdList.join(', ');

    // === Trading Schedule Info ===
    const tradingEnabled = process.env.TRADING_ACTIVE_ENABLED?.toLowerCase() === 'true';
    const tradingStart = process.env.TRADING_ACTIVE_START || '15:00';
    const tradingEnd = process.env.TRADING_ACTIVE_END || '04:00';

    const tradingScheduleBlock = tradingEnabled
      ? `🟢 *AKTIF* (${tradingStart} → ${tradingEnd} WIB)\n` +
        `🔸 Di luar jam: scan only, tanpa execute`
      : `🟡 *ALWAYS ACTIVE* (schedule disabled)`;

    // === Dynamic Symbols Status ===
    const activeSymbolsText = pairsArray.map(sym => `✅ Symbol ${sym} aktif.`).join('\n');

    const startupMsg =
      `🟢 *SISTEM AKTIF* 🟢\n\n` +
      `🤖 *ENGULFING PATTERN SCANNER (MODULAR)*\n` +
      `Telah berhasil dinyalakan dan siap beroperasi.\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📅 Tanggal : ${tgl}\n` +
      `🕐 Waktu   : ${jam} WIB\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `⚙️ *KONFIGURASI SCANNER:*\n` +
      `🔸 *Symbols:* ${pairs}\n` +
      `🔸 *Execute TF:* ${tfInfo}\n` +
      `🔸 *Info TFs:* ${infoTfs}\n` +
      `🔸 *EMA:* EMA_${emaFast} / EMA_${emaSlow}\n` +
      `🔸 *Database:* Supabase\n` +
      `🔸 *Strategy:* ${activeFilter}\n` +
      `🔸 *Min Grade:* ${minGradeInfo}\n\n` +
      `📡 *[TF Monitor]* Filter C AKTIF — H1 Bias + M15 Confirm + M5 Trigger\n` +
      `   EMA Filter: ${tfmEmaFilter} | Lookback: ${lookbackBars} bars\n` +
      `   Blocking: ${tfmBlocking}\n\n` +
      `⚙️  *[Execution Config]*\n` +
      `   OP Mode : ${opMode}\n` +
      `   SL Mode : ${slMode}\n` +
      `   TP Mode : ${tpMode}\n` +
      (process.env.EXECUTION_TP_MODE_B === 'USD' ? `   TP USD  : ${tpUsdInfo}\n` : '') +
      `   Lot     : ${lotInfo}\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `⏰ *JAM TRADING:*\n` +
      `${tradingScheduleBlock}\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📊 *LAPORAN OTOMATIS:*\n` +
      `🔸 Harian   : 23:59 WIB\n` +
      `🔸 Mingguan : Minggu 23:58 WIB\n` +
      `🔸 Bulanan  : Akhir bulan 23:57 WIB\n` +
      `🔸 Tahunan  : 31 Des 23:56 WIB\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `✅ MT5 terhubung.\n` +
      `${activeSymbolsText}\n` +
      `✅ Listener sinyal Realtime aktif.\n` +
      `✅ Laporan otomatis terjadwal.\n\n` +
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
