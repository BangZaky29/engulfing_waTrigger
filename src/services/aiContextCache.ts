import { SupabaseClient } from '@supabase/supabase-js';

// =====================================================
// services/aiContextCache.ts
// Singleton RAM cache + Supabase persistence for Bro AI
// =====================================================

const CACHE_ID = 'main_ai_cache';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 menit
const MAX_CONVERSATION_HISTORY = 10;

interface ConversationEntry {
    role: 'user' | 'ai';
    content: string;
    timestamp: string;
}

interface MarketDataCache {
    positionsSnapshot: any[];
    triggersSnapshot: any[];
    fetchedAt: number; // epoch ms
}

class AiContextCache {
    private static instance: AiContextCache;
    
    // RAM Cache
    private marketData: MarketDataCache = {
        positionsSnapshot: [],
        triggersSnapshot: [],
        fetchedAt: 0,
    };
    private conversationHistory: ConversationEntry[] = [];
    private aiMemorySummary: string = '';
    private cacheTtlMs: number = DEFAULT_TTL_MS;
    private sessionStartedAt: string = new Date().toISOString();

    private constructor() {}

    static getInstance(): AiContextCache {
        if (!AiContextCache.instance) {
            AiContextCache.instance = new AiContextCache();
        }
        return AiContextCache.instance;
    }

    // =========================================================
    // STARTUP: Load cache dari Supabase
    // =========================================================
    async loadFromSupabase(supabase: SupabaseClient): Promise<void> {
        try {
            const { data, error } = await supabase
                .from('ai_context_cache')
                .select('*')
                .eq('id', CACHE_ID)
                .single();

            if (error || !data) {
                console.log('[AI_CACHE] Tidak ada cache sebelumnya di Supabase. Mulai fresh.');
                // Insert row kosong untuk pertama kali
                await supabase.from('ai_context_cache').upsert({
                    id: CACHE_ID,
                    positions_snapshot: [],
                    triggers_snapshot: [],
                    conversation_history: [],
                    ai_memory_summary: '',
                    session_started_at: this.sessionStartedAt,
                }, { onConflict: 'id' });
                return;
            }

            // Restore dari Supabase
            this.marketData.positionsSnapshot = data.positions_snapshot || [];
            this.marketData.triggersSnapshot = data.triggers_snapshot || [];
            this.marketData.fetchedAt = data.market_data_fetched_at 
                ? new Date(data.market_data_fetched_at).getTime() 
                : 0;
            this.conversationHistory = data.conversation_history || [];
            this.aiMemorySummary = data.ai_memory_summary || '';

            const historyCount = this.conversationHistory.length;
            const dataAge = this.marketData.fetchedAt > 0 
                ? Math.round((Date.now() - this.marketData.fetchedAt) / 1000) 
                : -1;

            console.log(`[AI_CACHE] ✅ Loaded cache dari Supabase (${historyCount} conversations, market data age: ${dataAge > 0 ? dataAge + 's' : 'none'})`);
        } catch (e: any) {
            console.error('[AI_CACHE] ⚠️ Gagal load cache dari Supabase:', e?.message || e);
        }
    }

    // =========================================================
    // SHUTDOWN: Flush cache ke Supabase
    // =========================================================
    async flushToSupabase(supabase: SupabaseClient): Promise<void> {
        try {
            await supabase.from('ai_context_cache').upsert({
                id: CACHE_ID,
                positions_snapshot: this.marketData.positionsSnapshot,
                triggers_snapshot: this.marketData.triggersSnapshot,
                market_data_fetched_at: this.marketData.fetchedAt > 0 
                    ? new Date(this.marketData.fetchedAt).toISOString() 
                    : null,
                conversation_history: this.conversationHistory,
                ai_memory_summary: this.aiMemorySummary,
                updated_at: new Date().toISOString(),
                session_started_at: this.sessionStartedAt,
            }, { onConflict: 'id' });

            console.log(`[AI_CACHE] ✅ Flushed ke Supabase (${this.conversationHistory.length} conversations saved).`);
        } catch (e: any) {
            console.error('[AI_CACHE] ⚠️ Gagal flush cache ke Supabase:', e?.message || e);
        }
    }

    // =========================================================
    // RUNTIME: Refresh market data jika stale
    // =========================================================
    isMarketDataStale(): boolean {
        return (Date.now() - this.marketData.fetchedAt) > this.cacheTtlMs;
    }

    async refreshMarketData(supabase: SupabaseClient, force: boolean = false): Promise<void> {
        if (!force && !this.isMarketDataStale()) {
            const ageS = Math.round((Date.now() - this.marketData.fetchedAt) / 1000);
            console.log(`[AI_CACHE] Using cached market data (age: ${ageS}s)`);
            return;
        }

        console.log(`[AI_CACHE] ${force ? 'Force refreshing' : 'Cache expired, refreshing'} market data...`);

        // 1. Fetch positions
        try {
            const { data: positions } = await supabase
                .from('position_tracker_positions')
                .select('*');
            this.marketData.positionsSnapshot = positions || [];
        } catch (e: any) {
            console.error('[AI_CACHE] Gagal fetch positions:', e?.message);
        }

        // 2. Fetch indicator triggers (last 24h)
        try {
            const yesterday = new Date();
            yesterday.setHours(yesterday.getHours() - 24);
            
            const { data: triggers } = await supabase
                .from('indicator_triggers')
                .select('*')
                .gte('trigger_time', yesterday.toISOString())
                .order('trigger_time', { ascending: false })
                .limit(30);
            this.marketData.triggersSnapshot = triggers || [];
        } catch (e: any) {
            console.error('[AI_CACHE] Gagal fetch triggers:', e?.message);
        }

        this.marketData.fetchedAt = Date.now();
        console.log(`[AI_CACHE] ✅ Market data refreshed (${this.marketData.positionsSnapshot.length} positions, ${this.marketData.triggersSnapshot.length} triggers)`);
    }

    // =========================================================
    // CONVERSATION HISTORY
    // =========================================================
    addConversation(question: string, answer: string): void {
        const now = new Date().toISOString();
        this.conversationHistory.push(
            { role: 'user', content: question, timestamp: now },
            { role: 'ai', content: answer, timestamp: now }
        );

        // Keep max entries (pairs * 2)
        while (this.conversationHistory.length > MAX_CONVERSATION_HISTORY * 2) {
            this.conversationHistory.shift();
        }
    }

    setAiMemorySummary(summary: string): void {
        this.aiMemorySummary = summary;
    }

    // =========================================================
    // BUILD CONTEXT FOR GEMINI PROMPT
    // =========================================================
    getContextForPrompt(needsDeep: boolean): string {
        if (!needsDeep) {
            // Mode hemat: hanya conversation history ringkas
            const historyStr = this._formatConversationHistory(3); // Hanya 3 pasang terakhir
            return `Anda adalah "Bro AI", asisten trader di grup WhatsApp.
Jawab dengan singkat, santai, bahasa gaul trader Indonesia (bro, cuy).
Anda TIDAK memiliki data market saat ini (mode hemat token aktif).
Jika user butuh analisa data, suruh mereka ketik "Ai analisa" atau "Ai cek posisi".
${historyStr ? `\n=== RIWAYAT CHAT TERAKHIR ===\n${historyStr}` : ''}
${this.aiMemorySummary ? `\n=== INGATAN AI ===\n${this.aiMemorySummary}` : ''}`;
        }

        // Mode deep analysis: inject cached market data + history
        const positionsText = this.marketData.positionsSnapshot.length > 0
            ? JSON.stringify(this.marketData.positionsSnapshot, null, 2)
            : 'Tidak ada data posisi aktif.';

        // Ringkaskan triggers (hanya symbol, tf, pattern, direction, trigger_time)
        let triggersText = 'Tidak ada data indikator terbaru.';
        if (this.marketData.triggersSnapshot.length > 0) {
            const summary = this.marketData.triggersSnapshot.map((t: any) => 
                `${t.symbol} ${t.timeframe} ${t.pattern_name} ${t.direction} (${t.trigger_time})`
            );
            triggersText = summary.join('\n');
        }

        const historyStr = this._formatConversationHistory(5);
        const cacheAgeS = Math.round((Date.now() - this.marketData.fetchedAt) / 1000);

        return `Anda adalah "Asisten Hedging & Recovery AI" khusus untuk grup WhatsApp trader.
Anda membantu memberikan analisis dan saran untuk recovery posisi.
Data market terakhir di-update ${cacheAgeS} detik yang lalu.

=== DATA POSISI AKTIF ===
${positionsText}

=== SINYAL SCANNER TERBARU ===
${triggersText}

${historyStr ? `=== RIWAYAT CHAT TERAKHIR ===\n${historyStr}\n` : ''}${this.aiMemorySummary ? `=== INGATAN AI ===\n${this.aiMemorySummary}\n` : ''}
Instruksi:
1. Jawab berdasarkan data di atas.
2. Jika nyangkut, periksa status freeze/hedge dan cari sinyal berlawanan di TF besar (H1/H4).
3. Gunakan bahasa gaul ala trader Indonesia (bro, cuy, OP, TP, SL).
4. Jangan terlalu panjang, ringkas dan solutif.
5. PENTING: Anda TIDAK bisa menjalankan/memodifikasi trade di MT5. Anda hanya memberikan analisa & saran.`;
    }

    private _formatConversationHistory(maxPairs: number): string {
        if (this.conversationHistory.length === 0) return '';
        
        // Ambil N pasang terakhir
        const entries = this.conversationHistory.slice(-(maxPairs * 2));
        return entries.map(e => {
            const prefix = e.role === 'user' ? 'User' : 'AI';
            // Potong jawaban AI yang terlalu panjang untuk hemat token
            const content = e.content.length > 200 ? e.content.substring(0, 200) + '...' : e.content;
            return `${prefix}: "${content}"`;
        }).join('\n');
    }

    // =========================================================
    // GETTERS
    // =========================================================
    getConversationCount(): number {
        return Math.floor(this.conversationHistory.length / 2);
    }

    getMarketDataAge(): number {
        return this.marketData.fetchedAt > 0 
            ? Math.round((Date.now() - this.marketData.fetchedAt) / 1000) 
            : -1;
    }
}

export { AiContextCache };
