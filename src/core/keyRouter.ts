/**
 * KeyRouter - Main entry point of the keymux library
 * Manages keys, tracks state, and distributes requests
 * Uses a selection strategy to pick the best key
 */

import type {
  KeyConfig,
  KeyRouterConfig,
  KeySelectionResult,
  KeyStats,
  RouterStats,
  SelectionOptions,
  KeyRouterError,
  RateLimitError,
  ProviderPreset,
  DebugEvent
} from '../types';
import { KeyRouterError as KeyRouterErrorClass, RateLimitError as RateLimitErrorClass, PROVIDER_PRESETS, CircuitState } from '../types';
import { KeyTracker } from '../tracking/keyTracker';
import type { SelectionStrategy } from '../strategies/selectionStrategies';
import { WeightedLeastUtilizationStrategy, createStrategy } from '../strategies/selectionStrategies';

export class KeyRouter {
  private tracker: KeyTracker;
  private strategy: SelectionStrategy;
  private config: Required<KeyRouterConfig>;
  private initialized = false;

  constructor(config: KeyRouterConfig) {
    this.config = {
      keys: config.keys ? config.keys.map(k => ({ ...k })) : [],
      defaultRpmLimit: config.defaultRpmLimit ?? 40,
      defaultWeight: config.defaultWeight ?? 1,
      failureThreshold: config.failureThreshold ?? 3,
      cooldownMs: config.cooldownMs ?? 30_000,
      windowMs: config.windowMs ?? 60_000,
      trackLatency: config.trackLatency ?? true,
      onStateChange: config.onStateChange ?? (() => {}),
      onDebug: config.onDebug ?? (() => {})
    };

    if (this.config.defaultRpmLimit <= 0) throw new KeyRouterErrorClass('Invalid config: defaultRpmLimit must be > 0', 'INVALID_CONFIG');
    if (this.config.defaultWeight <= 0) throw new KeyRouterErrorClass('Invalid config: defaultWeight must be > 0', 'INVALID_CONFIG');
    if (this.config.failureThreshold <= 0) throw new KeyRouterErrorClass('Invalid config: failureThreshold must be > 0', 'INVALID_CONFIG');
    if (this.config.cooldownMs <= 0) throw new KeyRouterErrorClass('Invalid config: cooldownMs must be > 0', 'INVALID_CONFIG');
    if (this.config.windowMs <= 0) throw new KeyRouterErrorClass('Invalid config: windowMs must be > 0', 'INVALID_CONFIG');

    for (const key of this.config.keys) {
      if (key.rpmLimit !== undefined && key.rpmLimit <= 0) {
        throw new KeyRouterErrorClass('Invalid config: rpmLimit must be > 0', 'INVALID_CONFIG');
      }
      if (key.weight !== undefined && key.weight <= 0) {
        throw new KeyRouterErrorClass('Invalid config: weight must be > 0', 'INVALID_CONFIG');
      }
    }

    this.tracker = new KeyTracker({
      defaultRpmLimit: this.config.defaultRpmLimit,
      defaultWeight: this.config.defaultWeight,
      failureThreshold: this.config.failureThreshold,
      cooldownMs: this.config.cooldownMs,
      windowMs: this.config.windowMs,
      trackLatency: this.config.trackLatency,
      onStateChange: this.config.onStateChange,
      onDebug: this.config.onDebug
    });

    this.strategy = new WeightedLeastUtilizationStrategy();
  }

  /**
   * Initialize the router with keys
   * Must be called before using getKey()
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

    if (!this.config.keys.length) {
      throw new KeyRouterErrorClass(
        'No keys configured. At least one key must be provided.',
        'NO_KEYS_CONFIGURED'
      );
    }

    for (const keyConfig of this.config.keys) {
      if (!keyConfig.key || !keyConfig.id) {
        throw new KeyRouterErrorClass(
          `Invalid key config: each key must have 'id' and 'key' properties`,
          'NO_KEYS_CONFIGURED'
        );
      }
    }

    this.tracker.initialize(this.config.keys);
    this.initialized = true;

    this.config.onDebug?.({
      type: 'key_selected',
      timestamp: Date.now(),
      details: { initialized: true, keyCount: this.config.keys.length }
    });
  }

  /**
   * Get the next available API key
   * Returns key string ready to use with OpenAI/LangChain SDKs
   */
  async getKey(options?: SelectionOptions): Promise<string> {
    this.ensureInitialized();

    const availableKeys = this.tracker.getAvailableKeys();

    if (availableKeys.length === 0) {
      this.config.onDebug?.({
        type: 'all_exhausted',
        timestamp: Date.now(),
        details: { totalKeys: this.config.keys.length }
      });

      throw new RateLimitErrorClass('all');
    }

    // Apply preferred keys strategy if specified
    let strategy = this.strategy;
    if (options?.preferredKeys?.length) {
      strategy = createStrategy('preferred-keys', this.strategy);
    } else if (options?.strategy) {
      strategy = createStrategy(options.strategy, this.strategy);
    }

    const selected = strategy.select(availableKeys, options);

    if (!selected) {
      throw new RateLimitErrorClass('all');
    }

    // Record the selection attempt (reserves RPM)
    this.tracker.recordAttempt(selected.config.id);

    return selected.config.key;
  }

  /**
   * Get key with full metadata (for debugging/logging)
   */
  async getKeyWithMeta(options?: SelectionOptions): Promise<KeySelectionResult> {
    this.ensureInitialized();

    const availableKeys = this.tracker.getAvailableKeys();

    if (availableKeys.length === 0) {
      throw new RateLimitErrorClass('all');
    }

    const strategy = options?.strategy
      ? createStrategy(options.strategy, this.strategy)
      : this.strategy;

    const selected = strategy.select(availableKeys, options);

    if (!selected) {
      throw new RateLimitErrorClass('all');
    }

    const limit = selected.config.rpmLimit ?? this.config.defaultRpmLimit;
    return {
      key: selected.config.key,
      config: selected.config,
      keyId: selected.config.id,
      utilization: limit > 0 ? selected.rpm / limit : 0
    };
  }

  /**
   * Report a failed request for a specific key or key ID
   * Call this when you catch a 429/5xx error from the API
   */
  reportFailure(keyOrId: string, isRateLimit: boolean = false): void {
    const state = this.findKeyOrId(keyOrId);
    if (state) {
      this.tracker.recordFailure(state.config.id, isRateLimit, false);
    }
  }

  /**
   * Report a successful request for a specific key or key ID
   * Optional: call this if you want to track latency manually
   */
  reportSuccess(keyOrId: string, latencyMs?: number): void {
    const state = this.findKeyOrId(keyOrId);
    if (state) {
      this.tracker.recordSuccess(state.config.id, latencyMs, false);
    }
  }

  /**
   * Manually mark a key as recovered
   */
  reportRecovery(keyOrId: string): void {
    const state = this.findKeyOrId(keyOrId);
    if (state) {
      this.tracker.reportRecovery(state.config.id);
    }
  }

  /**
   * Get statistics for all keys
   */
  getStats(): KeyStats[] {
    return this.tracker.getStats();
  }

  /**
   * Get overall router statistics
   */
  getOverallStats() {
    return this.tracker.getOverallStats();
  }

  /**
   * Get a specific key's stats by ID
   */
  getKeyStats(keyId: string): KeyStats | undefined {
    const state = this.tracker.getState(keyId);
    if (!state) return undefined;

    const stats = this.tracker.getStats();
    return stats.find(s => s.id === keyId);
  }

  /**
   * Check if a specific key is healthy
   */
  isKeyHealthy(keyId: string): boolean {
    const state = this.tracker.getState(keyId);
    if (!state) return false;
    const limit = state.config.rpmLimit ?? this.config.defaultRpmLimit;
    if (state.circuitState === CircuitState.OPEN) {
      if (Date.now() >= state.cooldownUntil) {
        return state.rpm < limit;
      }
      return false;
    }
    return state.rpm < limit;
  }

  /**
   * Get all available (healthy + under limit) key IDs
   */
  getAvailableKeyIds(): string[] {
    return this.tracker.getAvailableKeys().map(s => s.config.id);
  }

  /**
   * Set custom selection strategy
   */
  setStrategy(strategy: SelectionStrategy | string): void {
    if (typeof strategy === 'string') {
      this.strategy = createStrategy(strategy, this.strategy);
    } else {
      this.strategy = strategy;
    }
  }

  /**
   * Add a new key at runtime
   */
  addKey(keyConfig: KeyConfig): void {
    this.ensureInitialized();
    this.tracker.initialize([...this.config.keys, keyConfig]);
    this.config.keys.push(keyConfig);
  }

  /**
   * Remove a key at runtime
   */
  removeKey(keyId: string): boolean {
    const index = this.config.keys.findIndex(k => k.id === keyId);
    if (index === -1) return false;

    this.config.keys.splice(index, 1);
    this.tracker.initialize(this.config.keys);
    return true;
  }

  /**
   * Update key configuration at runtime
   */
  updateKey(keyId: string, updates: Partial<KeyConfig>): boolean {
    const key = this.config.keys.find(k => k.id === keyId);
    if (!key) return false;

    Object.assign(key, updates);
    this.tracker.initialize(this.config.keys);
    return true;
  }

  /**
   * Reset all tracking (useful for testing)
   */
  reset(): void {
    this.tracker.reset();
  }

  /**
   * Shutdown and cleanup
   */
  destroy(): void {
    this.tracker.destroy();
    this.initialized = false;
  }

  // ==================== Provider Preset Helpers ====================

  /**
   * Create a router from a provider preset
   */
  static fromProvider(
    provider: keyof typeof PROVIDER_PRESETS,
    keys: string[],
    options?: Partial<KeyRouterConfig>
  ): KeyRouter {
    const preset = PROVIDER_PRESETS[provider];
    if (!preset) {
      throw new KeyRouterErrorClass(
        `Unknown provider: ${provider}. Available: ${Object.keys(PROVIDER_PRESETS).join(', ')}`,
        'NO_KEYS_CONFIGURED'
      );
    }

    const keyConfigs: KeyConfig[] = keys.map((key, index) => ({
      id: `${provider}-${index + 1}`,
      key,
      rpmLimit: preset.defaultRpmLimit,
      baseURL: preset.baseURL
    }));

    return new KeyRouter({
      keys: keyConfigs,
      ...options
    });
  }

  /**
   * Create a router for NVIDIA specifically (most common use case)
   */
  static forNvidia(keys: string[], options?: Partial<KeyRouterConfig>): KeyRouter {
    return KeyRouter.fromProvider('nvidia', keys, options);
  }

  /**
   * Create router from environment variable (comma-separated keys)
   */
  static fromEnv(
    envVar: string,
    options?: Partial<KeyRouterConfig>
  ): KeyRouter {
    const keys = process.env[envVar]?.split(',').map(k => k.trim()).filter(Boolean) ?? [];
    if (!keys.length) {
      throw new KeyRouterErrorClass(
        `Environment variable ${envVar} not set or empty`,
        'NO_KEYS_CONFIGURED'
      );
    }
    return new KeyRouter({
      keys: keys.map((key, i) => ({ id: `env-${i + 1}`, key })),
      ...options
    });
  }

  // ==================== Private Helpers ====================

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize();
    }
  }

  private findKeyOrId(keyOrId: string): ReturnType<typeof this.tracker.getState> {
    for (const state of this.tracker.getAllStates()) {
      if (state.config.id === keyOrId || state.config.key === keyOrId) {
        return state;
      }
    }
    return undefined;
  }
}

// Re-export types and errors for convenience
export type {
  KeyConfig,
  KeyRouterConfig,
  KeySelectionResult,
  KeyStats,
  RouterStats,
  SelectionOptions,
  CircuitState,
  ProviderPreset
} from '../types';

export { KeyRouterError, RateLimitError } from '../types';
export { PROVIDER_PRESETS } from '../types';