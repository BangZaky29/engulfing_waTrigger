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

          extraInfo += '\n';

          const opPriceStr = trade.op_price != null ? trade.op_price : (notesObj.op_price || '-');
          const slPriceStr = trade.sl_price != null ? trade.sl_price : (notesObj.sl_price || '-');
          const tpPriceStr = trade.tp_price != null ? trade.tp_price : (notesObj.tp_price || '-');
          
          const isBuy = trade.mode?.toUpperCase() === 'BUY';
          const slSourceRaw = notesObj.sl_source || 'M5';
          const slPctVal = notesObj.sl_pct ? Math.round(notesObj.sl_pct * 100) : 30;
          const slSource = slSourceRaw === 'H1' ? `_(Dynamic H1 ${slPctVal}%)_` : `_(M5 Default)_`;

          extraInfo += `📈 *Entry:* ${opPriceStr} (${isBuy ? 'BUY' : 'SELL'} MARKET)\n`;
          extraInfo += `🛑 *SL:* ${slPriceStr} ${slSource}\n`;
          const targetUsd = notesObj.target_usd ? notesObj.target_usd : 8.0;
          extraInfo += `🎯 *TP:* ${tpPriceStr} (Target $${targetUsd})\n\n`;
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
