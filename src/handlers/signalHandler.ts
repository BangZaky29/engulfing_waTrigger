import { enqueueWaMessage } from '../services/outboxService';
import { GROUP_JID, PRIVATE_JID, SKIP_SIGNAL } from '../config/env';

export async function handleEngulfingSignal(payload: any) {
  const signal = payload.new;
  console.log(`New OP signal detected! Symbol: ${signal.symbol}`);

  try {
    const isBuy = signal.pattern_type === 'bullish_engulfing';
    const mode = isBuy ? 'BUY' : 'SELL';
    const modeEmoji = isBuy ? '🟢' : '🔴';

    let caption = '';

    let notesObj: any = {};
    try { notesObj = JSON.parse(signal.notes || '{}'); } catch (e) {}

    const isSkippedSignal = !!signal.skip_reason;

    const targetJid =
      notesObj.ticket_id === 'TFM_STATUS_CHANGE' ||
      notesObj.ticket_id === 'INFO_SYNC' ||
      (typeof notesObj.ticket_id === 'string' &&
        notesObj.ticket_id.startsWith('INFO_') &&
        notesObj.ticket_id !== 'INFO_ACTIVE')
        ? GROUP_JID
        : PRIVATE_JID;

    const finalTargetJid =
      notesObj.ticket_id === 'INFO_ACTIVE'
        ? SKIP_SIGNAL
        : isSkippedSignal
        ? SKIP_SIGNAL
        : targetJid;

    const tfmStatusLine = notesObj.tfm_status ? `📡 *TF Monitor:* ${notesObj.tfm_status}\n` : '';

    if (notesObj.ticket_id === 'TFM_STATUS_CHANGE') {
      const tfmStatus = notesObj.tfm_status || 'WAIT';
      const tfmBias = notesObj.tfm_bias || 'Wait';
      const tfmSnapshot = notesObj.tfm_snapshot || '';

      const statusEmojiMap: Record<string, string> = {
        'STRONG': '🟢🔥', 'VALID': '🟢', 'EARLY': '🟡',
        'LATE': '🔴', 'WAIT': '⏸️'
      };
      const statusEmoji = statusEmojiMap[tfmStatus] || '❓';
      const biasEmoji = tfmBias.includes('Buy') ? '📈' : tfmBias.includes('Sell') ? '📉' : '➡️';

      caption = 
          `📡 *TF MONITOR UPDATE* 📡\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `${statusEmoji} *Status:* ${tfmStatus}\n` +
          `${biasEmoji} *Bias:* ${tfmBias}\n\n` +
          `${tfmSnapshot}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `📌 *Pair:* ${signal.symbol}`;
    } else if (notesObj.ticket_id === 'INFO_SYNC') {
      let syncText = signal.timeframe;
      if (notesObj.sync_with) {
        syncText = syncText.replace('SYNC_', '').replace('_', ' & ');
      }

      caption = 
          `🔥 *SYNC SIGNAL DETECTED* 🔥\n` +
          `----------------------------------\n` +
          `📌 *Pair:* ${signal.symbol}\n` +
          `🔄 *Sync:* ${syncText}\n` +
          `📈 *Direction:* ${modeEmoji} ${mode}\n` +
          `----------------------------------\n` +
          `ℹ️ _Hanya informasi, tidak ada eksekusi otomatis._`;
    } else if (notesObj.ticket_id === 'INFO_ACTIVE') {
      const skipReasons: string[] = Array.isArray(notesObj.skip_reasons)
        ? notesObj.skip_reasons
        : notesObj.skip_reason
          ? [notesObj.skip_reason]
          : [];
      const reasonLines = skipReasons.length > 0
        ? skipReasons.map((r) => `• ${r}`).join('\n') + '\n'
        : '• Alasan skip tidak tersedia\n';

      const h1TriggerRaw = notesObj.h1_trigger_source || '-';
      const h1TriggerTime = notesObj.h1_trigger_time ? ` (${notesObj.h1_trigger_time})` : '';
      const m15TriggerRaw = notesObj.m15_trigger_source || '-';
      const m15TriggerTime = notesObj.m15_trigger_time ? ` (${notesObj.m15_trigger_time})` : '';
      const m5TriggerRaw = notesObj.m5_trigger_source || '-';
      const m5TriggerTime = notesObj.m5_trigger_time ? ` (${notesObj.m5_trigger_time})` : '';
      const activePositionInfo = notesObj.active_position_info || null;
      const activePositionLine = activePositionInfo
        ? `📌 *Posisi Aktif:* ${activePositionInfo}\n` : '';

      caption = 
          `⚠️ *SKIPPED (POSISI AKTIF)* ⚠️\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `📌 *Pair:* ${signal.symbol}\n` +
          `⏱️ *TF:* ${signal.timeframe}\n` +
          `📈 *Trigger:* ${modeEmoji} ${mode}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `🔎 *Alasan:*\n${reasonLines}` +
          `${activePositionLine}` +
          `━━━━━━━━━━━━━━━━━\n` +
          `🔥 *H1 Trigger:* ${h1TriggerRaw}${h1TriggerTime}\n` +
          `🔥 *M15 Trigger:* ${m15TriggerRaw}${m15TriggerTime}\n` +
          `🔥 *M5 Trigger:* ${m5TriggerRaw}${m5TriggerTime}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `_Sinyal baru masuk, tapi dieksekusi SKIP karena OP sebelumnya belum clear (belum kena TP/SL)._`;
    } else if (notesObj.ticket_id && typeof notesObj.ticket_id === 'string' && notesObj.ticket_id.startsWith('INFO_')) {
      const infoTf = notesObj.ticket_id.replace('INFO_', '');
      caption = 
          `ℹ️ *INFO SIGNAL [${infoTf}]* ℹ️\n` +
          `----------------------------------\n` +
          `📌 *Pair:* ${signal.symbol}\n` +
          `📈 *Direction:* ${modeEmoji} ${mode}\n` +
          `📊 *Pattern:* ${signal.pattern_type.replace('_', ' ')}\n` +
          `----------------------------------\n` +
          `ℹ️ _Hanya informasi, tidak ada eksekusi otomatis._`;
    } else {
      const opPrice = signal.curr_close.toFixed(2);
      const slPrice = isBuy ? signal.curr_low.toFixed(2) : signal.curr_high.toFixed(2);

      if (signal.notes) {
        try {
          const actionStr = notesObj.action_str || mode;
          const grade = notesObj.grade || '-';
          const ticketIdRaw = signal.ticket_id ?? notesObj.ticket_id;
          const ticketId = ticketIdRaw != null && ticketIdRaw !== '' && ticketIdRaw !== '-'
            && !String(ticketIdRaw).startsWith('INFO_')
            && ticketIdRaw !== 'TFM_STATUS_CHANGE'
            ? String(ticketIdRaw)
            : null;
          const ticketLine = ticketId ? `🎫 *Ticket:* ${ticketId}\n` : '';

          const opPriceStr = notesObj.op_price ? Number(notesObj.op_price).toFixed(2) : opPrice;
          const tpPriceStr = notesObj.tp_price ? Number(notesObj.tp_price).toFixed(2) : '-';
          const filterStrategy = process.env.ACTIVE_FILTER_STRATEGY ? `FILTER ${process.env.ACTIVE_FILTER_STRATEGY}` : 'FILTER B';
          const slPriceNotes = notesObj.sl_price || slPrice;

          const slSourceRaw = notesObj.sl_source || 'M5';
          const defaultSlPct = process.env.EXECUTION_SL_PCT_B || '50';
          const slPctVal = notesObj.sl_pct ? Math.round(notesObj.sl_pct * 100) : Number(defaultSlPct);
          const slSource = slSourceRaw === 'H1' ? `_(Dynamic H1 ${slPctVal}%)_` : `_(M5 Default)_`;

          const h1TriggerRaw = notesObj.h1_trigger_source;
          const h1TriggerTime = notesObj.h1_trigger_time;
          const h1TriggerLine = h1TriggerRaw
            ? `🔥 *Trigger H1:* ${h1TriggerRaw}${h1TriggerTime ? ` (${h1TriggerTime})` : ''}\n\n`
            : '';

          const m15TriggerRaw = notesObj.m15_trigger_source;
          const m15TriggerTime = notesObj.m15_trigger_time;
          const m15TriggerAge = typeof notesObj.m15_trigger_age === 'number' ? notesObj.m15_trigger_age : null;
          const m15TriggerAgeSuffix = m15TriggerAge === 0 ? ' (N)' : m15TriggerAge ? ` (${m15TriggerAge})` : '';
          const m15TriggerLine = m15TriggerRaw
            ? `🔥 *Trigger M15:* ${m15TriggerRaw}${m15TriggerTime ? ` (${m15TriggerTime})` : ''}${m15TriggerAgeSuffix}\n\n`
            : '';

          const m5TriggerRaw = notesObj.m5_trigger_source;
          const m5TriggerTime = notesObj.m5_trigger_time;
          const m5TriggerLine = m5TriggerRaw
            ? `🔥 *M5 Trigger:* ${m5TriggerRaw.replace(/^Multi:/, '').replace(/\+/g, ' / ')}${m5TriggerTime ? ` (${m5TriggerTime})` : ''}\n\n`
            : '';

          const defaultTpUsd = process.env.EXECUTION_TP_TARGET_USD_B || '70.0';
          const targetUsd = notesObj.target_usd ? notesObj.target_usd : Number(defaultTpUsd);

          const isLimit = process.env.EXECUTION_USE_LIMIT?.toLowerCase() === 'true';
          const orderType = isLimit ? 'LIMIT' : 'MARKET';

          const cleanSym = signal.symbol.replace(/ /g, '_').replace(/-/g, '_');
          let lotSize = process.env[`LOT_${cleanSym}`] || process.env[`LOT_${signal.symbol}`];
          if (!lotSize) {
              if (signal.symbol === 'BTC' || signal.symbol === 'BTCUSD') lotSize = process.env.LOT_Bitcoin;
              else if (signal.symbol === 'NASDAQ-100' || signal.symbol === 'US100' || signal.symbol === 'USTEC') lotSize = process.env.LOT_US_Tech_100_index || process.env.LOT_NASDAQ_100;
          }
          lotSize = lotSize || process.env.EXECUTION_LOT_SIZE || '0.01';

          if (isSkippedSignal) {
             const skipReasons: string[] = Array.isArray(notesObj.skip_reasons)
                ? notesObj.skip_reasons
                : signal.skip_reason
                  ? [signal.skip_reason]
                  : [];
             const reasonLines = skipReasons.length > 0
                ? skipReasons.map((r: string) => `• ${r}`).join('\n') + '\n'
                : '• Alasan skip tidak tersedia\n';

             caption =
                `🛑 *SIGNAL SKIPPED* 🛑\n` +
                `----------------------------------\n` +
                `📌 *Pair:* ${signal.symbol}\n` +
                `⏱️ *TF:* ${signal.timeframe}\n` +
                `📊 *Strategy:* ${filterStrategy}\n` +
                `🔎 *Alasan Skip:*\n${reasonLines}` +
                `----------------------------------\n` +
                (h1TriggerLine ? h1TriggerLine : `\n`) +
                (m15TriggerLine ? m15TriggerLine : '') +
                (m5TriggerLine ? m5TriggerLine : '') +
                (tfmStatusLine ? `${tfmStatusLine}\n` : '') +
                `📈 *Entry:* ${opPriceStr} (${isBuy ? 'BUY' : 'SELL'} ${orderType})\n` +
                `🛑 *SL:* ${slPriceNotes} ${slSource}\n` +
                `🎯 *TP:* ${tpPriceStr} (Target $${targetUsd})\n` +
                `⚖️ *Lot:* ${lotSize}\n\n` +
                `💡 *Sesi:* ${signal.trading_session || '-'}\n` +
                `----------------------------------\n` +
                (ticketLine ? `${ticketLine}` : '');
          } else {
             caption =
                `🌟 *SIGNAL ENGULFING [${mode}]* 🌟\n` +
                `----------------------------------\n` +
                `📌 *Pair:* ${signal.symbol}\n` +
                `⏱️ *TF:* ${signal.timeframe}\n` +
                `📊 *Strategy:* ${filterStrategy}\n` +
                (h1TriggerLine ? h1TriggerLine : `\n`) +
                (m15TriggerLine ? m15TriggerLine : '') +
                (m5TriggerLine ? m5TriggerLine : '') +
                (tfmStatusLine ? `${tfmStatusLine}\n` : '') +
                `📈 *Entry:* ${opPriceStr} (${isBuy ? 'BUY' : 'SELL'} ${orderType})\n` +
                `🛑 *SL:* ${slPriceNotes} ${slSource}\n` +
                `🎯 *TP:* ${tpPriceStr} (Target $${targetUsd})\n` +
                `⚖️ *Lot:* ${lotSize}\n\n` +
                `💡 *Sesi:* ${signal.trading_session || '-'}\n` +
                `----------------------------------\n` +
                (ticketLine ? `${ticketLine}` : '') +
                `⚠️ _Harap gunakan manajemen risiko yang baik_`;
          }

        } catch (e) {
          console.log('Notes is not JSON or failed to parse, falling back to basic format.');
          caption = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${mode} | ${opPrice} | Sesi: ${signal.trading_session || '-'}`;
        }
      } else {
        caption = `Engulfing | ${signal.symbol} | ${signal.timeframe} | ${mode} | ${opPrice} | Sesi: ${signal.trading_session || '-'}`;
      }
    }

    await enqueueWaMessage({
      sourceTable: 'engulfing_signals',
      sourceId: signal.id,
      ticketId: signal.ticket_id || null,
      eventType: 'TRADE_SIGNAL',
      groupJid: finalTargetJid,
      messageType: 'TEXT',
      message: caption,
      payload: signal,
    });
  } catch (error) {
    console.error('Error handling OP message:', error);
  }
}
