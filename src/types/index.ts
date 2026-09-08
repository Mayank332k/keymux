/**
 * Core type definitions for keymux
 * Public API types exported for consumers
 */

/**
 * Configuration for a single API key in the pool
 */
export interface KeyConfig {
  /** Unique identifier - each key has its own ID */
  id: string;
  /** Actual API key string */
  key: string;
  /** RPM limit - how many requests can run in one minute (default: 40) */
  rpmLimit?: number;
  /** Weight - increase weight for more important keys (default: 1) */
  weight?: number;
  /** Base URL - custom URL if you don't want to use the provider's default URL */
  baseURL?: string;
  /** Custom metadata - for storing extra info */
  metadata?: Record<string, unknown>;
}

/**
 * Internal state tracking for a key
 */
export interface KeyState {
  config: KeyConfig;
  /** Current RPM - how many requests have been made in the current minute */
  rpm: number;
  /** Last request timestamp */
  lastUsed: number;
  /** Circuit breaker state - HEALTHY, DEGRADED or OPEN */
  circuitState: CircuitState;
  /** Continuous failures - circuit opens if this gets too high */
  failures: number;
  /** Cooldown until - how long to wait before retrying */
  cooldownUntil: number;
  /** Average latency - how fast requests are completing in milliseconds */
  avgLatencyMs: number;
  /** Total requests - how many requests processed so far */
  totalRequests: number;
  /** Total errors - how many errors encountered so far */
  totalErrors: number;
  /** Timestamps of requests in the current window */
  requestTimestamps: number[];
}

/**
 * Circuit breaker states
 * HEALTHY -> DEGRADED -> OPEN (recovers after cooldown)
 */
export enum CircuitState {
  HEALTHY = 'healthy',      // Everything is fine, can be used
  DEGRADED = 'degraded',    // Some issues, use carefully
  OPEN = 'open'             // Too many failures - do not use, wait for cooldown
}

/**
 * Configuration for the key router
 */
export interface KeyRouterConfig {
  /** All API keys to manage */
  keys: KeyConfig[];
  /** Default RPM limit - used if key-specific limit is not provided (default: 40) */
  defaultRpmLimit?: number;
  /** Default weight - equal importance for all keys? Or some more important? (default: 1) */
  defaultWeight?: number;
  /** Circuit breaker - block key after this many failures (default: 3) */
  failureThreshold?: number;
  /** Circuit breaker - recovery time in milliseconds after being blocked (default: 30000 = 30sec) */
  cooldownMs?: number;
  /** Sliding window - RPM is counted within a 1 minute (60000ms) window */
  windowMs?: number;
  /** Latency tracking - track how fast requests complete? (default: true) */
  trackLatency?: boolean;
  /** Callback - called when a key's state changes (e.g. healthy to degraded) */
  onStateChange?: (keyId: string, state: CircuitState) => void;
  /** Debug callback - for understanding what is happening in development */
  onDebug?: (event: DebugEvent) => void;
}

/**
 * Debug events - for logging and monitoring
 * What event occurred (selected, failed, recovered), which key, when, and extra details
 */
export interface DebugEvent {
  type: 'key_selected' | 'key_failed' | 'key_recovered' | 'circuit_opened' | 'all_exhausted';
  // key_selected: a key was selected
  // key_failed: a request failed
  // key_recovered: a failed key recovered
  // circuit_opened: circuit breaker opened
  // all_exhausted: all keys exhausted
  
  keyId?: string;
  keyIndex?: number;
  timestamp: number;
  details?: Record<string, unknown>;
}

/**
 * Result of key selection
 */
export interface KeySelectionResult {
  /** The selected API key */
  key: string;
  /** Key configuration */
  config: KeyConfig;
  /** Internal key ID */
  keyId: string;
  /** Current utilization (0-1) */
  utilization: number;
}

/**
 * Statistics for a single key
 */
export interface KeyStats {
  id: string;
  key: string; // masked (last 4 chars)
  rpm: number;
  rpmLimit: number;
  utilization: number;
  circuitState: CircuitState;
  failures: number;
  avgLatencyMs: number;
  totalRequests: number;
  totalErrors: number;
  isHealthy: boolean;
  cooldownRemainingMs?: number;
}

/**
 * Overall router statistics
 */
export interface RouterStats {
  totalKeys: number;
  healthyKeys: number;
  totalRpm: number;
  totalRpmLimit: number;
  overallUtilization: number;
  keys: KeyStats[];
}

/**
 * Options for key selection
 */
export interface SelectionOptions {
  /** Preferred key IDs (will try these first if healthy) */
  preferredKeys?: string[];
  /** Minimum utilization threshold (0-1) - skip keys above this */
  maxUtilization?: number;
  /** Custom selection strategy name */
  strategy?: string;
}

/**
 * Error types for better error handling
 */
export class KeyRouterError extends Error {
  constructor(
    message: string,
    public readonly code: 'ALL_KEYS_EXHAUSTED' | 'NO_KEYS_CONFIGURED' | 'KEY_NOT_FOUND' | 'CIRCUIT_OPEN',
    public readonly keyId?: string
  ) {
    super(message);
    this.name = 'KeyRouterError';
  }
}

export class RateLimitError extends KeyRouterError {
  constructor(keyId: string) {
    super(`Rate limit exceeded for key ${keyId}`, 'ALL_KEYS_EXHAUSTED', keyId);
    this.name = 'RateLimitError';
  }
}

/**
 * Provider preset configurations
 */
export interface ProviderPreset {
  name: string;
  baseURL: string;
  defaultRpmLimit: number;
  models: string[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  mistral: {
    name: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    defaultRpmLimit: 30,
    models: [
      'codestral-latest',
      'mistral-large-latest',
      'open-mistral-nemo'
    ]
  },
  nvidia: {
    name: 'NVIDIA',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultRpmLimit: 40,
    models: [
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3-super-120b-a12b',
      'stepfun-ai/step-3.7-flash'
    ]
  },
  gemini: {
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultRpmLimit: 15,
    models: [
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-thinking',
      'gemini-3.5-flash'
    ]
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultRpmLimit: 20,
    models: [
      'deepseek/deepseek-chat:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'qwen/qwen3-235b-a22b:free'
    ]
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    defaultRpmLimit: 60,
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  together: {
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    defaultRpmLimit: 60,
    models: [
      'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo'
    ]
  },
  sambanova: {
    name: 'SambaNova',
    baseURL: 'https://api.sambanova.ai/v1',
    defaultRpmLimit: 30,
    models: ['Meta-Llama-3.1-405B-Instruct', 'Meta-Llama-3.1-70B-Instruct']
  },

  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultRpmLimit: 500,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']
  },
  groq: {
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultRpmLimit: 30,
    models: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']
  }
};

// ====================================================================
// Multi-Provider Types
// ====================================================================

/**
 * Configuration for one provider in a multi-provider pool
 * Each provider can have multiple API keys
 */
export interface ProviderPoolEntry {
  /** Provider name - use preset name ('nvidia', 'gemini', etc.) or any custom string */
  provider: string;
  /** API keys for this provider (multiple keys = more RPM capacity) */
  keys: string[];
  /** Base URL - auto-filled from PROVIDER_PRESETS for known providers */
  baseURL?: string;
  /** Models this provider serves - first model is the default */
  models?: string[];
  /** Per-key RPM limit - auto-filled from PROVIDER_PRESETS for known providers */
  rpmLimit?: number;
  /** Provider priority weight - higher weight = more requests routed here (default: 1) */
  weight?: number;
  /** Custom metadata - for storing extra info per provider */
  metadata?: Record<string, unknown>;
}

/**
 * Result of getEndpoint() — everything needed to make an API call
 * Unlike getKey() which returns just a string, this returns the full endpoint info
 */
export interface EndpointResult {
  /** The API key to use */
  key: string;
  /** Provider's base URL for API calls */
  baseURL: string;
  /** Model to use for this request */
  model: string;
  /** Provider name (e.g. 'nvidia', 'gemini', 'openrouter') */
  provider: string;
  /** Unique endpoint ID for reporting success/failure */
  endpointId: string;
  /** Current utilization of this endpoint (0-1) */
  utilization: number;
}

/**
 * Options for getEndpoint() - filter and control which endpoint is selected
 */
export interface EndpointOptions {
  /** Try these providers first if healthy (e.g. ['gemini', 'nvidia']) */
  preferProviders?: string[];
  /** Never use these providers for this request */
  excludeProviders?: string[];
  /** Request a specific model - router picks the provider that has it */
  model?: string;
  /** Skip endpoints above this utilization (0-1) */
  maxUtilization?: number;
  /** Override selection strategy for this request */
  strategy?: string;
}

/**
 * Configuration options for MultiProviderRouter
 */
export interface MultiProviderConfig {
  /** Circuit breaker - block key after this many failures (default: 3) */
  failureThreshold?: number;
  /** Circuit breaker - recovery time in ms after being blocked (default: 30000) */
  cooldownMs?: number;
  /** Sliding window for RPM counting in ms (default: 60000) */
  windowMs?: number;
  /** Track latency per endpoint? (default: true) */
  trackLatency?: boolean;
  /** Default selection strategy (default: 'weighted-least-utilization') */
  strategy?: string;
  /** Callback when an endpoint's state changes */
  onStateChange?: (endpointId: string, state: CircuitState) => void;
  /** Debug callback for monitoring */
  onDebug?: (event: DebugEvent) => void;
}