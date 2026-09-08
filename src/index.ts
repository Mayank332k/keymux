/**
 * keymux - Smart API Key Multiplexer for LLM Providers
 * 
 * This library smartly manages your API keys providing:
 * - Weighted least-utilization selection (fair distribution)
 * - Circuit breaker pattern (fault tolerance)
 * - Sliding window RPM tracking (rate limiting)
 * - Automatic failover support (retry mechanism)
 * - OpenAI SDK / LangChain / Vercel AI SDK compatible
 * 
 * @packageDocumentation
 */

// Types (re-export)
// Re-exporting all types so consumers can directly import them
export type {
  KeyConfig,
  KeyRouterConfig,
  KeySelectionResult,
  KeyStats,
  RouterStats,
  SelectionOptions,
  ProviderPreset,
  DebugEvent,
  KeyState,
  ProviderPoolEntry,
  EndpointResult,
  EndpointOptions,
  MultiProviderConfig
} from './types';

export { CircuitState, KeyRouterError, RateLimitError } from './types';
import { KeyRouterError as _KeyRouterError } from './types';

export type { SelectionStrategy } from './strategies/selectionStrategies';

// Provider presets export - For NVIDIA, Mistral, OpenAI, etc.
import { PROVIDER_PRESETS } from './types';
export { PROVIDER_PRESETS };

// Core classes export
import { KeyRouter } from './core/keyRouter';
export { KeyRouter };

// Tracking classes export
import { KeyTracker } from './tracking/keyTracker';
export { KeyTracker };

// Strategies export - all selection strategies are available from here
import {
  WeightedLeastUtilizationStrategy,
  LeastRequestsStrategy,
  SmartRoutingStrategy,
  LeastLatencyStrategy,
  PreferredKeysStrategy,
  RandomStrategy,
  createStrategy,
  defaultStrategy
} from './strategies/selectionStrategies';
export {
  WeightedLeastUtilizationStrategy,
  LeastRequestsStrategy,
  SmartRoutingStrategy,
  LeastLatencyStrategy,
  PreferredKeysStrategy,
  RandomStrategy,
  createStrategy,
  defaultStrategy
};

// Utilities export - useful helper functions
import {
  isRateLimitError,
  isServerError,
  isRetryableError,
  calculateBackoff,
  maskKey,
  parseKeys,
  createKeyGetter,
  createFailoverKeyGetter,
  sleep,
  formatStats,
  createStatsLogger
} from './utils/helpers';
export {
  isRateLimitError,
  isServerError,
  isRetryableError,
  calculateBackoff,
  maskKey,
  parseKeys,
  createKeyGetter,
  createFailoverKeyGetter,
  sleep,
  formatStats,
  createStatsLogger
};

/**
 * Create a KeyRouter for NVIDIA keys - the most common use case
 * NVIDIA preset settings will be automatically applied
 * 
 * @example
 * ```typescript
 * import { createNvidiaRouter } from 'keymux';
 *
 * const router = createNvidiaRouter([
 *   'nvapi-key-1',
 *   'nvapi-key-2',
 *   'nvapi-key-3'
 * ]);
 *
 * // Use with OpenAI SDK
 * import OpenAI from 'openai';
 * const client = new OpenAI({
 *   apiKey: async () => await router.getKey(),
 *   baseURL: 'https://integrate.api.nvidia.com/v1'
 * });
 * ```
 */
export function createNvidiaRouter(
  keys: string[],
  options?: Partial<import('./types').KeyRouterConfig>
): KeyRouter {
  return KeyRouter.forNvidia(keys, options);
}

/**
 * Create a KeyRouter from a provider preset
 * Examples: mistral, openai, nvidia, etc.
 * 
 * @example
 * ```typescript
 * import { createRouter } from 'keymux';
 *
 * const router = createRouter('mistral', [
 *   'mistral-key-1',
 *   'mistral-key-2'
 * ]);
 * ```
 */
export function createRouter(
  provider: keyof typeof import('./types').PROVIDER_PRESETS,
  keys: string[],
  options?: Partial<import('./types').KeyRouterConfig>
): KeyRouter {
  return KeyRouter.fromProvider(provider, keys, options);
}

/**
 * Create a KeyRouter from an environment variable
 * Read keys from .env file or system env - comma separated
 * 
 * @example
 * ```typescript
 * import { createRouterFromEnv } from 'keymux';
 *
 * // Set NVIDIA_KEYS="key1,key2,key3" in .env
 * const router = createRouterFromEnv('NVIDIA_KEYS');
 * ```
 */
export function createRouterFromEnv(
  envVar: string,
  options?: Partial<import('./types').KeyRouterConfig>
): KeyRouter {
  return KeyRouter.fromEnv(envVar, options);
}

// ====================================================================
// Multi-Provider exports
// ====================================================================

import { MultiProviderRouter } from './core/multiProviderRouter';
export { MultiProviderRouter };
export type { ProviderStats } from './core/multiProviderRouter';

/**
 * Create a MultiProviderRouter from provider configs
 * Routes requests across multiple AI providers with automatic failover
 *
 * @example
 * ```typescript
 * import { createMultiProviderRouter } from 'keymux';
 *
 * const router = createMultiProviderRouter([
 *   { provider: 'gemini', keys: ['AIza-key1'] },
 *   { provider: 'nvidia', keys: ['nvapi-key1', 'nvapi-key2'] },
 *   { provider: 'openrouter', keys: ['sk-or-key1'] }
 * ]);
 *
 * const ep = await router.getEndpoint();
 * // ep = { key, baseURL, model, provider, endpointId, utilization }
 * ```
 */
export function createMultiProviderRouter(
  providers: import('./types').ProviderPoolEntry[],
  config?: import('./types').MultiProviderConfig
): MultiProviderRouter {
  return new MultiProviderRouter(providers, config);
}

/**
 * Create a MultiProviderRouter from environment variables
 * Each provider's keys are read from a comma-separated env var
 *
 * @example
 * ```typescript
 * import { createMultiProviderRouterFromEnv } from 'keymux';
 *
 * // process.env.NVIDIA_KEYS = "nvapi-key1,nvapi-key2"
 * // process.env.GEMINI_KEYS = "AIza-key1"
 * const router = createMultiProviderRouterFromEnv({
 *   nvidia: 'NVIDIA_KEYS',
 *   gemini: 'GEMINI_KEYS',
 * });
 * ```
 */
export function createMultiProviderRouterFromEnv(
  envMap: Record<string, string>,
  overrides?: Record<string, Partial<import('./types').ProviderPoolEntry>>,
  config?: import('./types').MultiProviderConfig
): MultiProviderRouter {
  const providers: import('./types').ProviderPoolEntry[] = [];

  for (const [provider, envVar] of Object.entries(envMap)) {
    const keys = process.env[envVar]
      ?.split(',')
      .map((k) => k.trim())
      .filter(Boolean) ?? [];

    if (keys.length === 0) {
      continue; // Skip providers with no keys in env
    }

    providers.push({
      provider,
      keys,
      ...overrides?.[provider],
    });
  }

  if (providers.length === 0) {
    throw new _KeyRouterError(
      'No provider keys found in environment variables.',
      'NO_KEYS_CONFIGURED'
    );
  }

  return new MultiProviderRouter(providers, config);
}

import { fetchWithFailover } from './core/fetcher';
export { fetchWithFailover };

/**
 * Default export for convenience
 */
export default {
  KeyRouter,
  KeyTracker,
  MultiProviderRouter,
  createNvidiaRouter,
  createRouter,
  createRouterFromEnv,
  createMultiProviderRouter,
  createMultiProviderRouterFromEnv,
  WeightedLeastUtilizationStrategy,
  LeastRequestsStrategy,
  SmartRoutingStrategy,
  LeastLatencyStrategy,
  PreferredKeysStrategy,
  RandomStrategy,
  createStrategy,
  defaultStrategy,
  isRateLimitError,
  isServerError,
  isRetryableError,
  calculateBackoff,
  maskKey,
  parseKeys,
  createKeyGetter,
  createFailoverKeyGetter,
  sleep,
  formatStats,
  createStatsLogger,
  PROVIDER_PRESETS,
  fetchWithFailover
};export * from './core/usageTracker';

// Proxy server exports
export { startProxyServer, stopProxyServer } from './proxy/server';
export { translateAnthropicToOpenAI } from './proxy/translators/requestTranslator';
export { translateOpenAIToAnthropic } from './proxy/translators/responseTranslator';
export { OpenRouterStreamTranslator, NvidiaStreamTranslator } from './proxy/translators/streamTranslator';
