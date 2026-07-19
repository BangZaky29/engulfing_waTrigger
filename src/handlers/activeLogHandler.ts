import { enqueueWaMessage } from '../services/outboxService';
import { SKIP_SIGNAL } from '../config/env';

export async function handleActiveLog(payload: any) {
  const log = payload.new;
  console.log(`New active log detected! Ticket: ${log.ticket_id}`);

  try {
    const sessionStr = log.trading_session ? `\n🔸 *Sesi:* ${log.trading_session}` : '';

    let title = '🎯 *PENDING ORDER TERSENTUH* 🎯';
    let finalMsg = log.message || `🔥 LIMIT ORDER TERSENTUH! Posisi ${log.mode} aktif sekarang.`;

    if (log.message?.includes('EXPIRED')) {
      title = '⏳ *PENDING ORDER KADALUWARSA (EXPIRED)* ⏳';
    } else if (log.message?.includes('OVERRIDDEN') || log.message?.includes('DIBATALKAN')) {
      title = '🧹 *PENDING ORDER DIBATALKAN (OVERRIDE)* 🧹';
    } else if (log.message?.includes('HAPUS OP-2 OTOMATIS')) {
      title = '✅ *OP-1 TELAH PROFIT (TAKE PROFIT)*';
      finalMsg = `🧹 *OP-2 DIBATALKAN (AUTO-CLEANUP)* 🧹\n` +
                 `🗑️ _Info: Limit Order Hedging (OP-2) telah berhasil dibatalkan dan dihapus secara otomatis dari market._`;
    } else if (log.message?.includes('HEDGE OP-2 TERSENTUH')) {
      title = '🚨 *HEDGE (OP-2) AKTIF - MANUAL EXIT REQUIRED!* 🚨';
      finalMsg = `⚠️ *PERHATIAN KHUSUS:* Posisi Hedging (OP-2) telah tersentuh dan terbuka!\n\n` +
                 `🗑️ _Info: TP yang terpasang pada OP-1 telah dihapus secara otomatis oleh sistem._\n\n` +
                 `👉 *Harap pantau dan lakukan eksekusi (Close/Exit) secara MANUAL (Manusia) untuk kedua posisi ini!*`;
    }

    const cleanSym = log.symbol ? log.symbol.replace(/ /g, '_').replace(/-/g, '_') : '';
    let lotSize = process.env[`LOT_${cleanSym}`] || process.env[`LOT_${log.symbol}`];
    if (!lotSize && log.symbol) {
        if (log.symbol === 'BTC' || log.symbol === 'BTCUSD') lotSize = process.env.LOT_Bitcoin;
        else if (log.symbol === 'NASDAQ-100' || log.symbol === 'US100' || log.symbol === 'USTEC') lotSize = process.env.LOT_US_Tech_100_index || process.env.LOT_NASDAQ_100;
    }
    lotSize = lotSize || process.env.EXECUTION_LOT_SIZE || '0.01';

    const caption = 
      `${title}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `${finalMsg}\n\n` +
      `📌 *Pair:* ${log.symbol}\n` +
      `🎯 *Entry:* ${log.op_price ? log.op_price.toFixed(5) : '-'}\n` +
      `🛑 *SL:* ${log.sl_price ? log.sl_price.toFixed(5) : '-'}\n` +
      `🏆 *TP:* ${log.tp_price ? log.tp_price.toFixed(5) : '-'}\n` +
      `⚖️ *Lot:* ${lotSize}` +
      `${sessionStr}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🎫 *Ticket:* ${log.ticket_id}`;

    await enqueueWaMessage({
      sourceTable: 'trade_active_logs',
      sourceId: log.id,
      ticketId: log.ticket_id,
      eventType: 'TRADE_ACTIVE',
      groupJid: SKIP_SIGNAL,
      messageType: log.image_url ? 'IMAGE' : 'TEXT',
      message: caption,
      imageUrl: log.image_url,
      payload: log,
    });
  } catch (error) {
    console.error('Error handling active log message:', error);
  }
}
