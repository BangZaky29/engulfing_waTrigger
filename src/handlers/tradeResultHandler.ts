import { supabase } from '../services/supabaseClient';
import { enqueueWaMessage } from '../services/outboxService';
import { PROFIT_SIGNAL, LOSS_SIGNAL } from '../config/env';

export async function handleTradeResult(payload: any) {
  const trade = payload.new;
  console.log(`New trade detected! Ticket: ${trade.ticket_id}`);

  try {
    const modeEmoji = trade.mode?.toUpperCase() === 'BUY' ? '🟢' : '🔴';
    const resultEmoji = trade.result?.toUpperCase() === 'PROFIT' ? '🎉' : '💀';

    // Ambil notes dari engulfing_signals untuk mendapatkan trigger & details
    let extraInfo = '';
    if (trade.ticket_id) {
      try {
        const { data: signalData } = await supabase
          .from('engulfing_signals')
          .select('notes')
          .eq('ticket_id', String(trade.ticket_id))
          .maybeSingle();

        if (signalData && signalData.notes) {
          const notesObj = JSON.parse(signalData.notes);
          
          const filterStrategy = process.env.ACTIVE_FILTER_STRATEGY ? `FILTER ${process.env.ACTIVE_FILTER_STRATEGY}` : 'FILTER B';
          extraInfo += `📊 *Strategy:* ${filterStrategy}\n`;
          
          if (notesObj.tfm_status) {
            extraInfo += `📡 *TF Monitor:* ${notesObj.tfm_status}\n`;
          }

          if (notesObj.h1_trigger_source) {
            const h1Time = notesObj.h1_trigger_time ? ` (${notesObj.h1_trigger_time})` : '';
            extraInfo += `🔥 *Trigger H1:* ${notesObj.h1_trigger_source}${h1Time}\n`;
          }

          if (notesObj.m15_trigger_source) {
            const m15Time = notesObj.m15_trigger_time ? ` (${notesObj.m15_trigger_time})` : '';
            const m15Age = typeof notesObj.m15_trigger_age === 'number' ? notesObj.m15_trigger_age : null;
            const m15AgeSuffix = m15Age === 0 ? ' (N)' : m15Age ? ` (${m15Age})` : '';
            extraInfo += `🔥 *Trigger M15:* ${notesObj.m15_trigger_source}${m15Time}${m15AgeSuffix}\n`;
          }

          if (notesObj.m5_trigger_source) {
            const m5Time = notesObj.m5_trigger_time ? ` (${notesObj.m5_trigger_time})` : '';
            extraInfo += `🔥 *M5 Trigger:* ${notesObj.m5_trigger_source.replace(/^Multi:/, '').replace(/\+/g, ' / ')}${m5Time}\n`;
          }

          const emaDistPts = notesObj.ema_distance_pts ?? notesObj.h1_ema_distance_pts;
          const emaDistStatus = notesObj.ema_distance_status ?? notesObj.h1_ema_distance_status;
          if (emaDistStatus && emaDistPts != null) {
            const statusEmoji = emaDistStatus === 'STRONG' ? '🟢🔥' : (emaDistStatus === 'VALID' ? '🟡' : '🔴');
            extraInfo += `📏 *EMA Distance H1 C1:* ${statusEmoji} ${emaDistStatus} (${emaDistPts} pts)\n`;
          }

          extraInfo += '\n';

          const opPriceStr = trade.op_price != null ? trade.op_price : (notesObj.op_price || '-');
          const slPriceStr = trade.sl_price != null ? trade.sl_price : (notesObj.sl_price || '-');
          const tpPriceStr = trade.tp_price != null ? trade.tp_price : (notesObj.tp_price || '-');
          
          const isBuy = trade.mode?.toUpperCase() === 'BUY';
          const slSourceRaw = notesObj.sl_source || 'M5';
          const defaultSlPct = process.env.EXECUTION_SL_PCT_B || '50';
          const slPctVal = notesObj.sl_pct ? Math.round(notesObj.sl_pct * 100) : Number(defaultSlPct);
          const slSource = slSourceRaw === 'H1' ? `_(Dynamic H1 ${slPctVal}%)_` : `_(M5 Default)_`;

          const isLimit = process.env.EXECUTION_USE_LIMIT?.toLowerCase() === 'true';
          const orderType = isLimit ? 'LIMIT' : 'MARKET';

          const cleanSym = trade.symbol ? trade.symbol.replace(/ /g, '_').replace(/-/g, '_') : '';
          let lotSize = process.env[`LOT_${cleanSym}`] || process.env[`LOT_${trade.symbol}`];
          if (!lotSize && trade.symbol) {
              if (trade.symbol === 'BTC' || trade.symbol === 'BTCUSD') lotSize = process.env.LOT_Bitcoin;
              else if (trade.symbol === 'NASDAQ-100' || trade.symbol === 'US100' || trade.symbol === 'USTEC') lotSize = process.env.LOT_US_Tech_100_index || process.env.LOT_NASDAQ_100;
          }
          lotSize = lotSize || process.env.EXECUTION_LOT_SIZE || '0.01';


          extraInfo += `📈 *Entry:* ${opPriceStr} (${isBuy ? 'BUY' : 'SELL'} ${orderType})\n`;
          extraInfo += `🛑 *SL:* ${slPriceStr} ${slSource}\n`;
          const defaultTpUsd = process.env.EXECUTION_TP_TARGET_USD_B || '70.0';
          const targetUsd = notesObj.target_usd ? notesObj.target_usd : Number(defaultTpUsd);
          extraInfo += `🎯 *TP:* ${tpPriceStr} (Target $${targetUsd})\n`;
          extraInfo += `⚖️ *Lot:* ${lotSize}\n\n`;
        }
      } catch (e) {
        console.error('Error fetching/parsing notes for trade result:', e);
      }
    }

    const caption = 
      `📊 *TRADE RESULT* 📊\n\n` +
      `${modeEmoji} *${trade.mode} ${trade.result}* ${resultEmoji}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📌 *Pair:* ${trade.symbol}\n` +
      `⏱️ *TF:* ${trade.timeframe}\n` +
      `💰 *Profit:* $${trade.profit ? trade.profit.toFixed(2) : '0.00'}\n\n` +
      `${extraInfo}` +
      `🔸 *Sesi:* ${trade.trading_session || '-'}\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🎫 *Ticket:* ${trade.ticket_id}`;

    const targetGroup = trade.result?.toUpperCase() === 'PROFIT' ? PROFIT_SIGNAL : LOSS_SIGNAL;

    await enqueueWaMessage({
      sourceTable: 'trade_analytics',
      sourceId: trade.id,
      ticketId: trade.ticket_id,
      eventType: 'TRADE_CLOSED',
      groupJid: targetGroup,
      messageType: trade.image_url ? 'IMAGE' : 'TEXT',
      message: caption,
      imageUrl: trade.image_url,
      payload: trade,
    });
  } catch (error) {
    console.error('Error handling trade message:', error);
  }
}
