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
        let isContextError = false;
        try {
          const clone = response.clone();
          let text = "";
          if (clone.body) {
            const reader = clone.body.getReader();
            const { value } = await reader.read();
            if (value) {
              text = new TextDecoder().decode(value).slice(0, 2048);
            }
            reader.cancel().catch(() => {});
          } else {
            text = (await clone.text()).slice(0, 2048);
          }
          const lower = text.toLowerCase();
          isContextError = lower.includes("context length exceeded") || lower.includes("maximum context length");
        } catch(e) {}
        
        if (response.status === 402 || isContextError) {
          if (!dynamicExcludeProviders.includes(ep.provider)) {
            dynamicExcludeProviders.push(ep.provider);
          }
        }

        if (response.status === 400 && !isContextError) {
          return response;
        }

        const isRateLimit = response.status === 429;
        router.reportFailure(ep.endpointId, isRateLimit);
        
        if (response.status === 429 || response.status >= 500) {
          await sleep(Math.min(1000 * Math.pow(2, attempts - 1), 10000));
        }
        
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
