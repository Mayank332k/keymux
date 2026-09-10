/**
 * MultiProviderRouter - Routes requests across multiple AI providers
 *
 * Internally uses KeyTracker + SelectionStrategy directly (same engine as KeyRouter)
 * but adds provider-awareness: baseURL, model, and provider-level filtering.
 *
 * Architecture:
 *   - Flattens all providers' keys into a single pool of KeyConfig entries
 *   - Each entry gets a unique ID: `${provider}-${keyIndex}` (e.g. 'nvidia-0', 'gemini-1')
 *   - An endpointMap stores the metadata (baseURL, model, provider) for each key ID
 *   - A providerGroups map tracks which key IDs belong to which provider
 *   - Selection uses existing KeyTracker (circuit breakers, RPM) + SelectionStrategy
 */

import type {
  KeyConfig,
  KeyStats,
  ProviderPoolEntry,
  EndpointResult,
  EndpointOptions,
  MultiProviderConfig,
  DebugEvent,
} from '../types';
import {
  CircuitState,
  KeyRouterError,
  RateLimitError,
  PROVIDER_PRESETS,
} from '../types';
import { KeyTracker } from '../tracking/keyTracker';
import type { SelectionStrategy } from '../strategies/selectionStrategies';
import {
  WeightedLeastUtilizationStrategy,
  PreferredKeysStrategy,
  createStrategy,
} from '../strategies/selectionStrategies';

/**
 * Internal metadata stored per endpoint (per key ID)
 */
interface EndpointMeta {
  baseURL: string;
  model: string;
  provider: string;
}

/**
 * Per-provider statistics
 */
export interface ProviderStats {
  provider: string;
  totalKeys: number;
  healthyKeys: number;
  totalRpm: number;
  totalRpmLimit: number;
  utilization: number;
  keys: KeyStats[];
}

export class MultiProviderRouter {
  private tracker: KeyTracker;
  private strategy: SelectionStrategy;
  private endpointMap: Map<string, EndpointMeta> = new Map();
  private providerGroups: Map<string, string[]> = new Map();
  public lastRoute: { provider: string, model: string, key: string, time: number } | null = null;
  private keyConfigs: KeyConfig[] = [];
  private providers: ProviderPoolEntry[];
  private config: Required<MultiProviderConfig>;

  constructor(providers: ProviderPoolEntry[], config?: MultiProviderConfig) {
    if (!providers.length) {
      throw new KeyRouterError(
        'At least one provider must be configured.',
        'NO_KEYS_CONFIGURED'
      );
    }

    // Deep clone to prevent mutation of the caller's array
    this.providers = providers.map((p) => ({
      ...p,
      keys: [...p.keys],
      models: p.models ? [...p.models] : undefined,
    }));

    this.config = {
      failureThreshold: config?.failureThreshold ?? 3,
      cooldownMs: config?.cooldownMs ?? 30_000,
      windowMs: config?.windowMs ?? 60_000,
      trackLatency: config?.trackLatency ?? true,
      strategy: config?.strategy ?? 'weighted-least-utilization',
      onStateChange: config?.onStateChange ?? (() => {}),
      onDebug: config?.onDebug ?? (() => {}),
    };

    if (this.config.failureThreshold <= 0) throw new KeyRouterError('Invalid config: failureThreshold must be > 0', 'INVALID_CONFIG');
    if (this.config.cooldownMs <= 0) throw new KeyRouterError('Invalid config: cooldownMs must be > 0', 'INVALID_CONFIG');
    if (this.config.windowMs <= 0) throw new KeyRouterError('Invalid config: windowMs must be > 0', 'INVALID_CONFIG');

    for (const provider of this.providers) {
      if (provider.rpmLimit !== undefined && provider.rpmLimit <= 0) {
        throw new KeyRouterError('Invalid config: rpmLimit must be > 0', 'INVALID_CONFIG');
      }
      if (provider.weight !== undefined && provider.weight <= 0) {
        throw new KeyRouterError('Invalid config: weight must be > 0', 'INVALID_CONFIG');
      }
    }

    // Create the tracker (same engine KeyRouter uses internally)
    this.tracker = new KeyTracker({
      defaultRpmLimit: 40,
      defaultWeight: 1,
      failureThreshold: this.config.failureThreshold,
      cooldownMs: this.config.cooldownMs,
      windowMs: this.config.windowMs,
      trackLatency: this.config.trackLatency,
      onStateChange: this.config.onStateChange,
      onDebug: this.config.onDebug,
    });

    // Create the selection strategy
    this.strategy = createStrategy(this.config.strategy);

    // Flatten all providers into a single key pool
    this.buildPool(providers);
  }

  // ==================== Core Methods ====================

  /**
   * Get the next best endpoint for making an API call
   * Returns key + baseURL + model + provider — everything needed for a request
   *
   * Supports filtering:
   * - preferProviders: try these first
   * - excludeProviders: skip these entirely
   * - model: pick a provider that has this model
   * - maxUtilization: skip overloaded endpoints
   */
  async getEndpoint(options?: EndpointOptions): Promise<EndpointResult> {
    let availableKeys = this.tracker.getAvailableKeys();

    // Filter by excludeProviders
    if (options?.excludeProviders?.length) {
      availableKeys = availableKeys.filter((k) => {
        const meta = this.endpointMap.get(k.config.id);
        return meta ? !options.excludeProviders!.includes(meta.provider) : true;
      });
    }

    // Filter by specific model
    if (options?.model) {
      availableKeys = availableKeys.filter((k) => {
        const meta = this.endpointMap.get(k.config.id);
        return meta ? meta.model === options.model : false;
      });
    }

    // Filter by maxUtilization
    if (options?.maxUtilization != null) {
      availableKeys = availableKeys.filter((k) => {
        const limit = k.config.rpmLimit ?? 40;
        return k.rpm / limit <= options.maxUtilization!;
      });
    }

    if (availableKeys.length === 0) {
      this.config.onDebug({
        type: 'all_exhausted',
        timestamp: Date.now(),
        details: { totalEndpoints: this.endpointMap.size },
      });
      throw new RateLimitError('all');
    }

    // Build selection options
    const preferredKeys = options?.preferProviders?.length
      ? options.preferProviders.flatMap(
          (p) => this.providerGroups.get(p) ?? []
        )
      : undefined;

    // Pick the strategy (per-request override or default)
    let activeStrategy = options?.strategy
      ? createStrategy(options.strategy, this.strategy)
      : this.strategy;

    // Wrap with PreferredKeysStrategy when provider preferences are specified
    if (preferredKeys?.length) {
      activeStrategy = new PreferredKeysStrategy(activeStrategy);
    }

    const selected = activeStrategy.select(availableKeys, { preferredKeys });

    if (!selected) {
      throw new RateLimitError('all');
    }

    // Record the selection attempt (reserves RPM)
    this.tracker.recordAttempt(selected.config.id);
    const m = this.endpointMap.get(selected.config.id);
    if (m) {
      this.lastRoute = {
        provider: m.provider,
        model: m.model,
        key: selected.config.key,
        time: Date.now()
      };
    }

    const meta = this.endpointMap.get(selected.config.id);
    if (!meta) {
      throw new KeyRouterError(
        `Endpoint metadata not found for ${selected.config.id}`,
        'KEY_NOT_FOUND',
        selected.config.id
      );
    }

    const limit = selected.config.rpmLimit ?? 40;

    return {
      key: selected.config.key,
      baseURL: meta.baseURL,
      model: meta.model,
      provider: meta.provider,
      endpointId: selected.config.id,
      utilization: limit > 0 ? selected.rpm / limit : 0,
    };
  }

  /**
   * Report a successful request for an endpoint
   * Resets failure count, updates latency (EMA), recovers degraded state
   */
  reportSuccess(endpointId: string, latencyMs?: number): void {
    this.tracker.recordSuccess(endpointId, latencyMs);
  }

  /**
   * Report a failed request for an endpoint
   * Increments failure count, may open circuit breaker
   * Next getEndpoint() call will automatically route to a different provider
   */
  reportFailure(endpointId: string, isRateLimit: boolean = false): void {
    this.tracker.recordFailure(endpointId, isRateLimit);
  }

  /**
   * Manually recover an endpoint (e.g. after external health check)
   */
  reportRecovery(endpointId: string): void {
    this.tracker.reportRecovery(endpointId);
  }

  // ==================== Stats & Monitoring ====================

  /**
   * Get overall stats across all providers (same familiar format as KeyRouter)
   */
  getOverallStats() {
    return this.tracker.getOverallStats();
  }

  /**
   * Get stats for all endpoints
   */
  getStats(): KeyStats[] {
    return this.tracker.getStats();
  }

  /**
   * Get stats for a specific provider
   */
  getProviderStats(provider: string): ProviderStats {
    const keyIds = this.providerGroups.get(provider) ?? [];
    const allStats = this.tracker.getStats();
    const providerKeyStats = allStats.filter((s) => keyIds.includes(s.id));

    const totalRpm = providerKeyStats.reduce((sum, s) => sum + s.rpm, 0);
    const totalRpmLimit = providerKeyStats.reduce(
      (sum, s) => sum + s.rpmLimit,
      0
    );

    return {
      provider,
      totalKeys: providerKeyStats.length,
      healthyKeys: providerKeyStats.filter((s) => s.isHealthy).length,
      totalRpm,
      totalRpmLimit,
      utilization: totalRpmLimit > 0 ? totalRpm / totalRpmLimit : 0,
      keys: providerKeyStats,
    };
  }

  /**
   * Get list of all configured provider names
   */
  getProviderNames(): string[] {
    return Array.from(this.providerGroups.keys());
  }

  /**
   * Get all available (healthy + under limit) endpoint IDs
   */
  getLastRoute() { return this.lastRoute; }
  
  getAvailableEndpointIds(): string[] {
    return this.tracker.getAvailableKeys().map((s) => s.config.id);
  }

  /**
   * Check if a specific endpoint is healthy
   */
  isEndpointHealthy(endpointId: string): boolean {
    const state = this.tracker.getState(endpointId);
    if (!state) return false;
    const limit = state.config.rpmLimit ?? 40;

    // Check if circuit has recovered from cooldown (lazy recovery)
    if (state.circuitState === CircuitState.OPEN) {
      if (Date.now() >= state.cooldownUntil) {
        return state.rpm < limit;
      }
      return false;
    }

    return state.rpm < limit;
  }

  /**
   * Check if a provider has any healthy endpoints
   */
  isProviderHealthy(provider: string): boolean {
    const keyIds = this.providerGroups.get(provider) ?? [];
    return keyIds.some((id) => this.isEndpointHealthy(id));
  }

  // ==================== Dynamic Management ====================

  /**
   * Add a new provider at runtime
   */
  addProvider(entry: ProviderPoolEntry): void {
    if (!entry.keys.length) {
      throw new KeyRouterError(
        `Provider '${entry.provider}' must have at least one key.`,
        'NO_KEYS_CONFIGURED'
      );
    }

    const clonedEntry = JSON.parse(JSON.stringify(entry));
    this.providers.push(clonedEntry);
    this.rebuildPool();
  }

  /**
   * Add a key to an existing provider at runtime
   */
  addKeyToProvider(provider: string, key: string): void {
    const entry = this.providers.find((p) => p.provider === provider);
    if (!entry) {
      throw new KeyRouterError(
        `Provider '${provider}' not found. Use addProvider() to add a new provider.`,
        'KEY_NOT_FOUND'
      );
    }

    const clonedKey = JSON.parse(JSON.stringify(key));
    entry.keys.push(clonedKey);
    this.rebuildPool();
  }

  /**
   * Remove a provider entirely at runtime
   */
  removeProvider(provider: string): boolean {
    const index = this.providers.findIndex((p) => p.provider === provider);
    if (index === -1) return false;

    this.providers.splice(index, 1);
    this.rebuildPool();
    return true;
  }

  /**
   * Remove a specific key from a provider at runtime
   */
  removeKey(provider: string, key: string): boolean {
    const entry = this.providers.find((p) => p.provider === provider);
    if (!entry) return false;

    const keyIndex = entry.keys.indexOf(key);
    if (keyIndex === -1) return false;

    entry.keys.splice(keyIndex, 1);

    // If provider has no keys left, remove it entirely
    if (entry.keys.length === 0) {
      return this.removeProvider(provider);
    }

    this.rebuildPool();
    return true;
  }

  // ==================== Strategy ====================

  /**
   * Set the selection strategy
   */
  setStrategy(strategy: SelectionStrategy | string): void {
    if (typeof strategy === 'string') {
      this.strategy = createStrategy(strategy, this.strategy);
    } else {
      this.strategy = strategy;
    }
  }

  // ==================== Lifecycle ====================

  /**
   * Reset all tracking data (useful for testing)
   */
  reset(): void {
    this.tracker.reset();
  }

  /**
   * Shutdown and cleanup (stops background cleanup timer)
   */
  destroy(): void {
    this.tracker.destroy();
  }

  // ==================== Private Helpers ====================

  /**
   * Flatten all providers into a single key pool
   * Each key gets a unique ID: `${provider}-${keyIndex}`
   * Provider metadata (baseURL, model) is stored in endpointMap
   */
  private buildPool(providers: ProviderPoolEntry[]): void {
    this.keyConfigs = [];
    this.endpointMap.clear();
    this.providerGroups.clear();

    for (const entry of providers) {
      const preset = PROVIDER_PRESETS[entry.provider];
      const baseURL =
        entry.baseURL ?? preset?.baseURL ?? '';
      const rpmLimit =
        entry.rpmLimit ?? preset?.defaultRpmLimit ?? 40;
      const models =
        entry.models ?? preset?.models ?? [];
      const defaultModel = models[0] ?? '';
      const weight = entry.weight ?? 1;

      if (!baseURL) {
        throw new KeyRouterError(
          `Provider '${entry.provider}' has no baseURL. Provide one or use a known provider preset.`,
          'NO_KEYS_CONFIGURED'
        );
      }

      const groupIds: string[] = [];

      for (let i = 0; i < entry.keys.length; i++) {
        const key = entry.keys[i]!;
        const id = `${entry.provider}-${i}`;

        // KeyConfig for the tracker
        this.keyConfigs.push({
          id,
          key,
          rpmLimit,
          weight,
          baseURL,
          metadata: {
            provider: entry.provider,
            model: defaultModel,
            ...entry.metadata,
          },
        });

        // Endpoint metadata
        this.endpointMap.set(id, {
          baseURL,
          model: defaultModel,
          provider: entry.provider,
        });

        groupIds.push(id);
      }

      this.providerGroups.set(entry.provider, groupIds);
    }

    // Initialize the tracker with the flat key pool
    this.tracker.initialize(this.keyConfigs);
  }

  /**
   * Rebuild the pool from current providers (used after dynamic changes)
   */
  private rebuildPool(): void {
    this.buildPool(this.providers);
  }
}
