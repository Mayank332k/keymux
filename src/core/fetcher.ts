import { MultiProviderRouter } from './multiProviderRouter';
import type { EndpointResult, EndpointOptions } from '../types';

export interface FetchConfig {
  router: MultiProviderRouter;
  maxRetries?: number;
  preferProviders?: string[];
  excludeProviders?: string[];
  model?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithFailover(
  urlBuilder: (ep: EndpointResult) => string | URL,
  fetchOptionsBuilder: (ep: EndpointResult) => RequestInit,
  config: FetchConfig
): Promise<Response> {
  const router = config.router;
  const maxRetries = config.maxRetries ?? 3;
  let attempts = 0;
  let lastResponse: Response | null = null;
  let lastError: Error | null = null;
  const dynamicExcludeProviders = [...(config.excludeProviders || [])];

  while (attempts < maxRetries) {
    attempts++;
    
    let ep: EndpointResult;
    try {
      ep = await router.getEndpoint({
        preferProviders: config.preferProviders,
        excludeProviders: dynamicExcludeProviders,
        model: config.model
      });
    } catch (error: any) {
      if (attempts >= maxRetries) continue;
      
      if (lastResponse) {
        return lastResponse;
      }
      throw error;
    }

    const url = urlBuilder(ep);
    const options = fetchOptionsBuilder(ep);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 mins timeout
      
      const response = await fetch(url, { ...options, signal: controller.signal as any });
      clearTimeout(timeoutId);
      lastResponse = response;

      if (!response.ok) {
        let errorText = '';
        try {
          const clone = response.clone();
          if (clone.body) {
            const reader = clone.body.getReader();
            const { value } = await reader.read();
            if (value) {
              errorText = new TextDecoder().decode(value).slice(0, 2048);
            }
            reader.cancel().catch(() => {});
          } else {
            errorText = (await clone.text()).slice(0, 2048);
          }
        } catch(e) {}

        const lower = errorText.toLowerCase();
        const isContextError = lower.includes("context length exceeded") || lower.includes("maximum context length");
        const isModelError = lower.includes("decommissioned") || lower.includes("not a valid model") || lower.includes("model not found") || lower.includes("does not exist") || lower.includes("not supported");
        const isAuthError = response.status === 401 || response.status === 403;
        const isRateLimit = response.status === 429;

        // Report failure to circuit breaker
        router.reportFailure(ep.endpointId, isRateLimit);

        // Exclude the ENTIRE provider if the error is provider-specific
        // (retrying the same provider with a different key won't fix model/auth issues)
        if (isContextError || isModelError || isAuthError || response.status === 402 || response.status === 404) {
          if (!dynamicExcludeProviders.includes(ep.provider)) {
            dynamicExcludeProviders.push(ep.provider);
          }
        }

        // Backoff on rate limits and server errors
        if (isRateLimit || response.status >= 500) {
          await sleep(Math.min(1000 * Math.pow(2, attempts - 1), 10000));
        }
        
        // NEVER return early — always try the next provider/key
        continue;
      }

      return response;

    } catch (error: any) {
      lastError = error;
      router.reportFailure(ep.endpointId, false);
    }
  }

  if (lastResponse) {
    return lastResponse;
  }
  
  if (lastError && lastError.name === 'AbortError') {
    throw new Error("timeout");
  }
  
  throw new Error(`fetchWithFailover exhausted all retries. Last error: ${lastError?.message}`);
}
