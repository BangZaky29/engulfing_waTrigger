// Helper: delay
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: fetchWithTimeout
export function fetchWithTimeout(url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const TIMEOUT_MS = 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.warn(`[FETCH] ⏱️ Request timeout setelah ${TIMEOUT_MS}ms: ${url.toString().substring(0, 80)}...`);
  }, TIMEOUT_MS);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}
