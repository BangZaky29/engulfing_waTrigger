import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY, GEMINI_MODEL } from '../config/env';
import { AiContextCache } from './aiContextCache';

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

export async function handleAiQuery(
    userPrompt: string, 
    supabase: any, 
    needsDeepAnalysis: boolean = true,
    forceRefresh: boolean = false
): Promise<string> {
    try {
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
        const cache = AiContextCache.getInstance();

        // Refresh market data jika perlu (hanya saat deep analysis)
        if (needsDeepAnalysis) {
            await cache.refreshMarketData(supabase, forceRefresh);
        }

        // Build prompt dari cache (bukan query DB langsung)
        const systemPrompt = cache.getContextForPrompt(needsDeepAnalysis);

        const fullPrompt = `${systemPrompt}\n\nPertanyaan User:\n"${userPrompt}"`;

        const result = await model.generateContent(fullPrompt);
        const aiResponse = result.response.text();

        // Simpan ke conversation history (di RAM)
        cache.addConversation(userPrompt, aiResponse);

        return aiResponse;
    } catch (error: any) {
        console.error("Gemini AI Error:", error);
        return "Sori bro, otak AI gue lagi nge-hang nih atau koneksi API-nya putus. Coba lagi nanti ya! 🤖💥";
    }
}
