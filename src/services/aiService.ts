import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, GEMINI_MODEL } from '../config/env';

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

export async function handleAiQuery(userPrompt: string, supabase: any): Promise<string> {
    try {
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

        // 1. Fetch Context: Active Positions
        let activePositionsText = "Tidak ada data posisi aktif.";
        try {
            const { data: positions } = await supabase
                .from('position_tracker_positions')
                .select('*');
            if (positions && positions.length > 0) {
                activePositionsText = JSON.stringify(positions, null, 2);
            }
        } catch (e) {
            console.error("Gagal mengambil active positions untuk AI context:", e);
        }

        // 2. Fetch Context: Recent Indicator Triggers (Last 24 hours)
        let indicatorTriggersText = "Tidak ada data indikator terbaru.";
        try {
            const yesterday = new Date();
            yesterday.setHours(yesterday.getHours() - 24);
            
            const { data: triggers } = await supabase
                .from('indicator_triggers')
                .select('*')
                .gte('trigger_time', yesterday.toISOString())
                .order('trigger_time', { ascending: false })
                .limit(20);
                
            if (triggers && triggers.length > 0) {
                indicatorTriggersText = JSON.stringify(triggers, null, 2);
            }
        } catch (e) {
            console.error("Gagal mengambil indicator triggers untuk AI context:", e);
        }

        // 3. System Prompt Engineering
        const systemPrompt = `
Anda adalah "Asisten Hedging & Recovery AI" khusus untuk grup WhatsApp trader.
Anda membantu memberikan analisis dan saran untuk recovery posisi (seperti jika trader nyangkut di OP3 / freeze state).
Anda diberikan data real-time berikut dari sistem trading (format JSON):

=== DATA POSISI AKTIF (Supabase: position_tracker_positions) ===
${activePositionsText}

=== DATA INDIKATOR TERBARU DARI MULTI-PATTERN SCANNER (M5 s.d D1) ===
${indicatorTriggersText}

Instruksi:
1. Jawab pertanyaan user berdasarkan data di atas.
2. Jika user bertanya tentang posisi nyangkut, periksa apakah ada posisi dengan status freeze/hedge.
3. Cari apakah ada sinyal berlawanan (dari data indikator terbaru) di timeframe besar (H1/H4) yang bisa dipakai sebagai pijakan recovery.
4. Gunakan bahasa gaul ala trader Indonesia (bro, cuy, OP, TP, SL, Floating, nyangkut).
5. Jangan berikan jawaban terlalu panjang, usahakan ringkas, tajam, dan solutif.

Pertanyaan User:
"${userPrompt}"
        `;

        const result = await model.generateContent(systemPrompt);
        return result.response.text();
    } catch (error: any) {
        console.error("Gemini AI Error:", error);
        return "Sori bro, otak AI gue lagi nge-hang nih atau koneksi API-nya putus. Coba lagi nanti ya! 🤖💥";
    }
}
