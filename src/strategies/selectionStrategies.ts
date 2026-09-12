/**
 * Key Selection Strategies
 * Pure functions that select the best key from the available keys
 */

import type { KeyState, KeyStats, SelectionOptions } from '../types';

/**
 * Strategy interface
 */
export interface SelectionStrategy {
  name: string;
  select(keys: KeyState[], options?: SelectionOptions): KeyState | null;
}

/**
 * Weighted Least Utilization Strategy (RECOMMENDED)
 * Picks key with lowest (rpm / rpmLimit) ratio, weighted by key weight
 * Handles different RPM limits per key fairly
 */
export class WeightedLeastUtilizationStrategy implements SelectionStrategy {
  name = 'weighted-least-utilization';

  select(keys: KeyState[], options?: SelectionOptions): KeyState | null {
    if (keys.length === 0) return null;

    // Filter by max utilization if specified
    let candidates = keys;
    if (options?.maxUtilization != null) {
      candidates = keys.filter((k: KeyState) => {
        const limit = k.config.rpmLimit ?? 40;
        return k.rpm / limit <= options.maxUtilization!!;
      });
      if (candidates.length === 0) return null;
    }

    // Sort by utilization (rpm / limit / weight) ascending
    candidates.sort((a, b) => {
      const limitA = a.config.rpmLimit ?? 40;
      const limitB = b.config.rpmLimit ?? 40;
      const weightA = a.config.weight ?? 1;
      const weightB = b.config.weight ?? 1;

      const utilA = (a.rpm / limitA) / weightA;
      const utilB = (b.rpm / limitB) / weightB;

      return utilA - utilB;
    });

    return candidates[0] ?? null;
  }
}

/**
 * Least Requests Strategy
 * Picks key with absolute lowest RPM count
 * Good when all keys have same limits
 */
export class LeastRequestsStrategy implements SelectionStrategy {
  name = 'least-requests';

  select(keys: KeyState[], options?: SelectionOptions): KeyState | null {
    if (keys.length === 0) return null;

    let candidates = keys;
    if (options?.maxUtilization != null) {
      candidates = keys.filter(k => {
        const limit = k.config.rpmLimit ?? 40;
        return k.rpm / limit <= options.maxUtilization!!;
      });
      if (candidates.length === 0) return null;
    }

    // Sort by absolute RPM count
    candidates.sort((a, b) => a.rpm - b.rpm);
    return candidates[0] ?? null;
  }
}

/**
 * Smart Routing Strategy
 * 1. Filters out keys exceeding max utilization.
 * 2. Forms a "fast pool" of keys within 100ms of the fastest key. Always includes keys with no latency data (e.g., avgLatencyMs === 0) so they don't get starved.
 * 3. Sorts the pool by RPM (ascending) and then totalRequests (ascending) to balance load (Least Used).
 */
export class SmartRoutingStrategy implements SelectionStrategy {
  name = 'smart';

  select(keys: KeyState[], options?: SelectionOptions): KeyState | null {
    if (!keys || keys.length === 0) return null;

    let candidates = keys;
    
    // 1. Max Utilization Filter
    if (options?.maxUtilization != null) {
      candidates = keys.filter(k => {
        const limit = k.config.rpmLimit ?? 40;
        return (k.rpm / limit) <= options.maxUtilization!;
      });
      if (candidates.length === 0) return null;
    }

    // 2. Give untested keys a chance first (cold start)
    const untestedKeys = candidates.filter(k => (k.latencyHistory?.length ?? 0) === 0);
    if (untestedKeys.length > 0) {
      // Pick the least used untested key
      untestedKeys.sort((a, b) => (a.totalRequests ?? 0) - (b.totalRequests ?? 0));
      return untestedKeys[0] ?? null;
    }

    // 3. Fast Pool: keys within +100ms of the best avg TTFT
    const keysWithLatency = candidates.filter(
      (k: KeyState) => typeof k.avgLatencyMs === 'number' && !isNaN(k.avgLatencyMs) && k.avgLatencyMs > 0
    );
    
    let pool = candidates;
    if (keysWithLatency.length > 0) {
      const fastest = Math.min(...keysWithLatency.map((k: KeyState) => k.avgLatencyMs));
      pool = keysWithLatency.filter((k: KeyState) => k.avgLatencyMs <= fastest + 100);
    }

    if (pool.length === 0) {
      pool = candidates;
    }

    // 4. Within the fast pool, pick the key with lowest avg TTFT.
    //    Tie-breaker: lowest utilization (rpm / limit).
    pool.sort((a: KeyState, b: KeyState) => {
      if (a.avgLatencyMs !== b.avgLatencyMs) return a.avgLatencyMs - b.avgLatencyMs;
      
      const limitA = a.config.rpmLimit ?? 40;
      const limitB = b.config.rpmLimit ?? 40;
      return (a.rpm / limitA) - (b.rpm / limitB);
    });

    return pool[0] ?? null;
  }
}

/**
 * Least Latency Strategy
 * Picks key with lowest average latency
 * Requires latency tracking to be enabled
 * Falls back to LeastRequestsStrategy if no latency data is available
 */
export class LeastLatencyStrategy implements SelectionStrategy {
  name = 'least-latency';

  select(keys: KeyState[], options?: SelectionOptions): KeyState | null {
    if (keys.length === 0) return null;

    let candidates = keys;
    if (options?.maxUtilization != null) {
      candidates = keys.filter(k => {
        const limit = k.config.rpmLimit ?? 40;
        return k.rpm / limit <= options.maxUtilization!!;
      });
      if (candidates.length === 0) return null;
    }

    // Filter to keys with latency data
    candidates = candidates.filter(k => k.avgLatencyMs > 0);
    if (candidates.length === 0) {
      // Fallback to least requests if no latency data
      return new LeastRequestsStrategy().select(keys, options);
    }

    candidates.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);
    return candidates[0] ?? null;
  }
}

/**
 * Preferred Keys Strategy
 * Tries preferred keys first, falls back to another strategy
 */
export class PreferredKeysStrategy implements SelectionStrategy {
  name = 'preferred-keys';

  constructor(private fallbackStrategy: SelectionStrategy) {}

  select(keys: KeyState[], options?: SelectionOptions): KeyState | null {
    if (!options?.preferredKeys?.length) {
      return this.fallbackStrategy.select(keys, options);
    }

    // Filter available keys that match preferred IDs
    const preferredKeysSet = new Set(options.preferredKeys);
    const preferredCandidates = keys.filter(k => preferredKeysSet.has(k.config.id));

    if (preferredCandidates.length > 0) {
      const selected = this.fallbackStrategy.select(preferredCandidates, options);
      if (selected) return selected;
    }

    // Fall back to default strategy across all keys
    return this.fallbackStrategy.select(keys, options);
  }
}

/**
 * Random Strategy
 * Selects a key randomly - good for distributing load evenly over time
 * Applies utilization filter so overloaded keys are not selected
 */
export class RandomStrategy implements SelectionStrategy {
  name = 'random';

  select(keys: KeyState[], options?: SelectionOptions): KeyState | null {
    if (keys.length === 0) return null;

    let candidates = keys;
    if (options?.maxUtilization != null) {
      candidates = keys.filter(k => {
        const limit = k.config.rpmLimit ?? 40;
        return k.rpm / limit <= options.maxUtilization!!;
      });
      if (candidates.length === 0) return null;
    }

    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? null;
  }
}

/**
 * Round Robin Strategy
 * Selects keys in sequential order (using oldest lastUsed timestamp).
 */
export class RoundRobinStrategy implements SelectionStrategy {
  name = 'round-robin';
  private index = 0;

  select(keys: KeyState[], options?: SelectionOptions): KeyState | null {
    if (keys.length === 0) return null;

    let candidates = keys;
    if (options?.maxUtilization != null) {
      candidates = keys.filter(k => {
        const limit = k.config.rpmLimit ?? 40;
        return limit > 0 ? (k.rpm / limit <= options.maxUtilization!!) : true;
      });
      if (candidates.length === 0) return null;
    }

    const selected = candidates[this.index % candidates.length];
    this.index++;
    return selected || null;
  }
}

/**
 * Strategy Factory - creates strategy by name
 */
export function createStrategy(name: string, fallback?: SelectionStrategy): SelectionStrategy {
  switch (name) {
    case 'weighted-least-utilization':
      return new WeightedLeastUtilizationStrategy();
    case 'least-requests':
      return new LeastRequestsStrategy();
    case 'round-robin':
      return new RoundRobinStrategy();
    case 'smart':
      return new SmartRoutingStrategy();
    case 'least-latency':
      return new LeastLatencyStrategy();
    case 'random':
      return new RandomStrategy();
    case 'preferred-keys':
      return new PreferredKeysStrategy(fallback ?? new WeightedLeastUtilizationStrategy());
    default:
      return new WeightedLeastUtilizationStrategy();
  }
}

/**
 * Default strategy instance (singleton)
 */
export const defaultStrategy = new WeightedLeastUtilizationStrategy();