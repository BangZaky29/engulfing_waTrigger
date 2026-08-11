import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, GEMINI_MODEL } from '../config/env';

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

export async function handleAiQuery(userPrompt: string, supabase: any, needsDeepAnalysis: boolean = true): Promise<string> {
    try {
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

        let systemPrompt = "";

        if (needsDeepAnalysis) {
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

            // 3. System Prompt Engineering (DEEP ANALYSIS)
            systemPrompt = `Anda adalah "Asisten Hedging & Recovery AI" khusus untuk grup WhatsApp trader.
Anda membantu memberikan analisis dan saran untuk recovery posisi (seperti jika trader nyangkut di OP3 / freeze state).
Anda diberikan data real-time berikut dari sistem trading (format JSON):

=== DATA POSISI AKTIF ===
${activePositionsText}

=== DATA INDIKATOR TERBARU ===
${indicatorTriggersText}

Instruksi:
1. Jawab pertanyaan berdasarkan data di atas.
2. Jika nyangkut, periksa status freeze/hedge dan cari sinyal berlawanan di TF besar (H1/H4).
3. Gunakan bahasa gaul ala trader Indonesia (bro, cuy, OP, TP, SL).
4. Jangan terlalu panjang, ringkas dan solutif.

Pertanyaan User:
"${userPrompt}"`;
        } else {
            // SIMPLE CHAT PROMPT (HEMAT TOKEN)
            systemPrompt = `Anda adalah "Bro AI", asisten trader di grup WhatsApp. 
Jawab pertanyaan dengan singkat, santai, dan bahasa gaul trader Indonesia (bro, cuy).
Penting: Anda TIDAK memiliki data market atau posisi saat ini karena mode hemat token aktif. Jika user butuh analisa data, suruh mereka ketik "Ai analisa" atau "Ai cek posisi".

Pertanyaan User:
"${userPrompt}"`;
        }

        const result = await model.generateContent(systemPrompt);
        return result.response.text();
    } catch (error: any) {
        console.error("Gemini AI Error:", error);
        return "Sori bro, otak AI gue lagi nge-hang nih atau koneksi API-nya putus. Coba lagi nanti ya! 🤖💥";
    }
}
