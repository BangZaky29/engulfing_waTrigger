// =====================================================
// src/services/forexFactoryService.ts
// Service untuk mengunduh, mem-parsing, menyimpan, dan
// mengambil data kalender ekonomi Forex Factory dari FairEconomy Media CDN.
// =====================================================

import crypto from 'crypto';
import { supabase } from './supabaseClient';
import { fetchWithTimeout } from '../utils/helpers';

export interface ForexFactoryEvent {
  id: string;
  title: string;
  country: string;
  impact: 'High' | 'Medium' | 'Low' | 'Holiday' | string;
  event_date: string; // ISO 8601 string UTC
  forecast: string;
  previous: string;
  actual?: string;
  currency_pair?: string;
  is_gold_relevant?: boolean;
  alert_sent?: boolean;
}

const FAIR_ECONOMY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// In-memory cache jika database belum ready atau untuk akses instan
let cachedWeeklyEvents: ForexFactoryEvent[] = [];
let lastSyncTimestamp: number = 0;

/**
 * Buat deterministic hash ID untuk setiap event berdasarkan title, country, dan date
 */
export function generateEventId(title: string, country: string, dateStr: string): string {
  return crypto
    .createHash('md5')
    .update(`${title.trim()}_${country.trim().toUpperCase()}_${dateStr.trim()}`)
    .digest('hex');
}

/**
 * Format tanggal ISO ke waktu Indonesia Barat (WIB / GMT+7)
 * Contoh output: "19:30 WIB" atau "Senin, 14 Sep 2026 19:30 WIB"
 */
export function formatToWIB(isoDateStr: string, includeDate: boolean = false): string {
  try {
    const d = new Date(isoDateStr);
    const options: Intl.DateTimeFormatOptions = {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    };

    if (includeDate) {
      options.weekday = 'short';
      options.day = '2-digit';
      options.month = 'short';
    }

    const formatted = new Intl.DateTimeFormat('id-ID', options).format(d);
    return `${formatted} WIB`;
  } catch (err) {
    return isoDateStr;
  }
}

/**
 * Sync calendar data dari FairEconomy Media ke Supabase
 * Dilengkapi proteksi rate-limit (hanya sync jika interval > 15 menit)
 */
export async function syncForexFactoryCalendar(force: boolean = false): Promise<{ success: boolean; count: number; error?: string }> {
  const now = Date.now();
  // Cegah spamming request ke CDN FairEconomy (minimal jeda 15 menit kecuali force)
  if (!force && now - lastSyncTimestamp < 15 * 60 * 1000 && cachedWeeklyEvents.length > 0) {
    console.log('[FF_SERVICE] ⏳ Skip fetch FairEconomy (masih dalam jendela cache 15 menit)');
    return { success: true, count: cachedWeeklyEvents.length };
  }

  console.log('[FF_SERVICE] 🔄 Mengunduh update kalender dari FairEconomy Media CDN...');

  try {
    const res = await fetchWithTimeout(FAIR_ECONOMY_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (res.status === 429) {
      console.warn('[FF_SERVICE] ⚠️ HTTP 429: Too Many Requests dari CDN FairEconomy. Menggunakan cache.');
      return { success: false, count: cachedWeeklyEvents.length, error: 'Rate limited (429)' };
    }

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
    }

    const rawData = (await res.json()) as any[];
    if (!Array.isArray(rawData)) {
      throw new Error('Format respon FairEconomy bukan array JSON');
    }

    console.log(`[FF_SERVICE] ✅ Berhasil parse ${rawData.length} events dari FairEconomy`);

    // Transformasi data
    const events: ForexFactoryEvent[] = rawData.map(item => {
      const dateIso = new Date(item.date).toISOString();
      const id = generateEventId(item.title, item.country, dateIso);
      const isUsd = (item.country || '').toUpperCase() === 'USD';

      return {
        id,
        title: item.title || 'Untitled Event',
        country: (item.country || 'USD').toUpperCase(),
        impact: item.impact || 'Low',
        event_date: dateIso,
        forecast: item.forecast || '',
        previous: item.previous || '',
        currency_pair: isUsd ? 'USD' : item.country,
        is_gold_relevant: isUsd, // USD memiliki korelasi langsung tertinggi terhadap XAU/USD
      };
    });

    cachedWeeklyEvents = events;
    lastSyncTimestamp = now;

    // Simpan / Upsert ke Supabase
    try {
      const { error } = await supabase
        .from('forex_factory_calendar')
        .upsert(
          events.map(e => ({
            id: e.id,
            title: e.title,
            country: e.country,
            impact: e.impact,
            event_date: e.event_date,
            forecast: e.forecast,
            previous: e.previous,
            currency_pair: e.currency_pair,
            is_gold_relevant: e.is_gold_relevant,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: 'id', ignoreDuplicates: false }
        );

      if (error) {
        console.warn('[FF_SERVICE] ⚠️ Peringatan simpan Supabase (Tabel mungkin belum dibuat):', error.message);
      } else {
        console.log(`[FF_SERVICE] 💾 Sukses upsert ${events.length} event ke Supabase forex_factory_calendar`);
      }
    } catch (dbErr: any) {
      console.warn('[FF_SERVICE] ⚠️ Gagal simpan ke Supabase, tetap berjalan dengan in-memory cache:', dbErr?.message);
    }

    return { success: true, count: events.length };
  } catch (err: any) {
    console.error('[FF_SERVICE] ❌ Error sync Forex Factory:', err?.message || err);
    return { success: false, count: cachedWeeklyEvents.length, error: err?.message };
  }
}

/**
 * Mengambil event untuk hari tertentu (WIB) dengan filter impact
 */
export async function getDayEvents(
  targetDate: Date = new Date(),
  impactFilter: string[] = ['High', 'Medium'],
  goldOnly: boolean = true
): Promise<ForexFactoryEvent[]> {
  // Hitung range 00:00:00 s/d 23:59:59 di zona waktu WIB (UTC+7)
  const tzOffsetMs = 7 * 60 * 60 * 1000;
  const targetWibTime = targetDate.getTime() + tzOffsetMs;
  const wibDate = new Date(targetWibTime);

  const startOfDayWib = new Date(Date.UTC(wibDate.getUTCFullYear(), wibDate.getUTCMonth(), wibDate.getUTCDate(), 0, 0, 0) - tzOffsetMs);
  const endOfDayWib = new Date(Date.UTC(wibDate.getUTCFullYear(), wibDate.getUTCMonth(), wibDate.getUTCDate(), 23, 59, 59, 999) - tzOffsetMs);

  const startIso = startOfDayWib.toISOString();
  const endIso = endOfDayWib.toISOString();

  // 1. Coba query Supabase
  try {
    let query = supabase
      .from('forex_factory_calendar')
      .select('*')
      .gte('event_date', startIso)
      .lte('event_date', endIso)
      .order('event_date', { ascending: true });

    if (impactFilter.length > 0) {
      query = query.in('impact', impactFilter);
    }

    if (goldOnly) {
      query = query.eq('is_gold_relevant', true);
    }

    const { data, error } = await query;
    if (!error && data && data.length > 0) {
      return data as ForexFactoryEvent[];
    }
  } catch (err) {
    // Fallback ke cache memory jika Supabase query gagal
  }

  // 2. Fallback in-memory cache jika Supabase kosong atau belum termigrasi
  if (cachedWeeklyEvents.length === 0) {
    await syncForexFactoryCalendar();
  }

  return cachedWeeklyEvents.filter(e => {
    const eTime = new Date(e.event_date).getTime();
    const inDay = eTime >= startOfDayWib.getTime() && eTime <= endOfDayWib.getTime();
    const matchImpact = impactFilter.length === 0 || impactFilter.includes(e.impact);
    const matchGold = !goldOnly || e.is_gold_relevant;
    return inDay && matchImpact && matchGold;
  }).sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime());
}

/**
 * Mencari event High Impact USD yang akan rilis dalam kurun waktu `windowMinutes` menit ke depan
 * dan belum dikirimi alert (alert_sent = false)
 */
export async function getUpcomingHighImpactEvents(windowMinutes: number = 25): Promise<ForexFactoryEvent[]> {
  const now = new Date();
  const futureWindow = new Date(now.getTime() + windowMinutes * 60 * 1000);

  const nowIso = now.toISOString();
  const futureIso = futureWindow.toISOString();

  // 1. Coba kueri Supabase
  try {
    const { data, error } = await supabase
      .from('forex_factory_calendar')
      .select('*')
      .eq('impact', 'High')
      .eq('country', 'USD')
      .eq('alert_sent', false)
      .gte('event_date', nowIso)
      .lte('event_date', futureIso)
      .order('event_date', { ascending: true });

    if (!error && data && data.length > 0) {
      return data as ForexFactoryEvent[];
    }
  } catch (err) {
    // Fallback
  }

  // 2. Fallback memory cache
  return cachedWeeklyEvents.filter(e => {
    if (e.impact !== 'High' || e.country !== 'USD' || e.alert_sent) return false;
    const t = new Date(e.event_date).getTime();
    return t >= now.getTime() && t <= futureWindow.getTime();
  });
}

/**
 * Tandai event sudah dikirimkan alert agar tidak terulang
 */
export async function markEventAlertSent(eventId: string) {
  // Update in-memory
  const found = cachedWeeklyEvents.find(e => e.id === eventId);
  if (found) {
    found.alert_sent = true;
  }

  // Update Supabase
  try {
    await supabase
      .from('forex_factory_calendar')
      .update({ alert_sent: true, updated_at: new Date().toISOString() })
      .eq('id', eventId);
  } catch (e) {
    // Ignore error
  }
}

/**
 * Ambil seluruh event dalam 1 bulan kalender (WIB)
 */
export async function getMonthEvents(year: number, month: number): Promise<ForexFactoryEvent[]> {
  // month: 1-12
  const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  try {
    const { data, error } = await supabase
      .from('forex_factory_calendar')
      .select('*')
      .gte('event_date', startOfMonth.toISOString())
      .lte('event_date', endOfMonth.toISOString())
      .in('impact', ['High', 'Medium'])
      .order('event_date', { ascending: true });

    if (!error && data && data.length > 0) {
      return data as ForexFactoryEvent[];
    }
  } catch (err) {
    // fallback
  }

  return cachedWeeklyEvents.filter(e => {
    const d = new Date(e.event_date);
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && ['High', 'Medium'].includes(e.impact);
  });
}
