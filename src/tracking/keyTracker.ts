/**
 * KeyTracker - Tracks per-key state: RPM, circuit breaker, latency
 * Single responsibility: tracks and updates key metrics
 */

import type { KeyConfig, KeyState, KeyStats, DebugEvent } from '../types';
import { CircuitState } from '../types';

export interface KeyTrackerOptions {
  defaultRpmLimit: number;
  defaultWeight: number;
  failureThreshold: number;
  cooldownMs: number;
  windowMs: number;
  trackLatency: boolean;
  onDebug?: (event: DebugEvent) => void;
}

export class KeyTracker {
  private keys: Map<string, KeyState> = new Map();
  private options: KeyTrackerOptions;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(options: KeyTrackerOptions) {
    this.options = options;
    this.startCleanupLoop();
  }

  initialize(keyConfigs: KeyConfig[]): void {
    const oldKeys = new Map(this.keys);
    this.keys.clear();
    for (const config of keyConfigs) {
      const existing = oldKeys.get(config.id);
      if (existing) {
        existing.config = {
          ...config,
          rpmLimit: config.rpmLimit ?? this.options.defaultRpmLimit,
          weight: config.weight ?? this.options.defaultWeight
        };
        this.keys.set(config.id, existing);
      } else {
        const state: KeyState = {
          config: {
            ...config,
            rpmLimit: config.rpmLimit ?? this.options.defaultRpmLimit,
            weight: config.weight ?? this.options.defaultWeight
          },
          rpm: 0,
          lastUsed: 0,
          circuitState: CircuitState.HEALTHY,
          failures: 0,
          cooldownUntil: 0,
          avgLatencyMs: 0,
          totalRequests: 0,
          totalErrors: 0,
          requestTimestamps: []
        };
        this.keys.set(config.id, state);
      }
    }
  }

  /**
   * Get all key states - for debugging or stats
   */
  getAllStates(): KeyState[] {
    return Array.from(this.keys.values());
  }

  /**
   * Get state of a specific key
   */
  getState(keyId: string): KeyState | undefined {
    return this.keys.get(keyId);
  }

  /**
   * Get only healthy and available keys
   * Checks circuit breaker state and RPM limits
   */
  getAvailableKeys(): KeyState[] {
    const now = Date.now();
    return Array.from(this.keys.values()).filter(state => {
      if (state.circuitState === CircuitState.OPEN) {
        if (now >= state.cooldownUntil) {
          return state.rpm < state.config.rpmLimit!;
        }
        return false;
      }
      return state.rpm < state.config.rpmLimit!;
    });
  }

  /**
   * Record a successful request
   * Increments RPM count (if requested), updates latency, resets failures
   */
  recordSuccess(keyId: string, latencyMs?: number, incrementRpm: boolean = true): void {
    const state = this.keys.get(keyId);
    if (!state) return;

    if (incrementRpm) {
      state.requestTimestamps.push(Date.now());
      state.rpm = state.requestTimestamps.length;
      state.lastUsed = Date.now();
      state.totalRequests++;
    }
    
    state.failures = 0;

    if (this.options.trackLatency && latencyMs != null) {
      state.avgLatencyMs = state.avgLatencyMs === 0
        ? latencyMs
        : Math.round(state.avgLatencyMs * 0.9 + latencyMs * 0.1);
    }

    // Recover if it was in degraded or open state
    if (state.circuitState === CircuitState.DEGRADED || state.circuitState === CircuitState.OPEN) {
      this.transitionToHealthy(state);
    }

    this.emitDebug({
      type: 'key_selected',
      keyId,
      timestamp: Date.now(),
      details: { rpm: state.rpm, latencyMs }
    });
  }

  /**
   * Record a failed request (rate limit, server error, etc.)
   * Triggers circuit breaker logic
   */
  recordFailure(keyId: string, isRateLimit: boolean = false, incrementRpm: boolean = true): void {
    const state = this.keys.get(keyId);
    if (!state) return;

    state.failures++;
    state.totalErrors++;
    
    if (incrementRpm) {
      state.requestTimestamps.push(Date.now());
      state.rpm = state.requestTimestamps.length;
    }

    this.emitDebug({
      type: 'key_failed',
      keyId,
      timestamp: Date.now(),
      details: { failures: state.failures, isRateLimit }
    });

    if (state.failures >= this.options.failureThreshold) {
      this.openCircuit(state);
    } else if (state.failures >= Math.ceil(this.options.failureThreshold / 2)) {
      if (state.circuitState === CircuitState.HEALTHY) {
        state.circuitState = CircuitState.DEGRADED;
        this.emitDebug({
          type: 'key_failed',
          keyId,
          timestamp: Date.now(),
          details: { circuitState: CircuitState.DEGRADED }
        });
      }
    }
  }

  /**
   * Manually report a key as recovered (for external health checks)
   */
  reportRecovery(keyId: string): void {
    const state = this.keys.get(keyId);
    if (!state) return;

    this.transitionToHealthy(state);
    this.emitDebug({
      type: 'key_recovered',
      keyId,
      timestamp: Date.now()
    });
  }

  /**
   * Get statistics for all keys
   */
  getStats(): KeyStats[] {
    return Array.from(this.keys.values()).map(state => this.toStats(state));
  }

  /**
   * Get overall router statistics
   */
  getOverallStats() {
    const stats = this.getStats();
    const totalRpm = stats.reduce((sum, s) => sum + s.rpm, 0);
    const totalRpmLimit = stats.reduce((sum, s) => sum + s.rpmLimit, 0);

    return {
      totalKeys: stats.length,
      healthyKeys: stats.filter(s => s.isHealthy).length,
      totalRpm,
      totalRpmLimit,
      overallUtilization: totalRpmLimit > 0 ? totalRpm / totalRpmLimit : 0,
      keys: stats
    };
  }

  /**
   * Reset all tracking (useful for testing)
   */
  reset(): void {
    for (const state of this.keys.values()) {
      state.rpm = 0;
      state.lastUsed = 0;
      state.circuitState = CircuitState.HEALTHY;
      state.failures = 0;
      state.cooldownUntil = 0;
      state.totalRequests = 0;
      state.totalErrors = 0;
      state.requestTimestamps = [];
    }
  }

  /**
   * Shutdown cleanup
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  // ==================== Private Methods ====================

  private transitionToHealthy(state: KeyState): void {
    const wasUnhealthy = state.circuitState !== CircuitState.HEALTHY;
    state.circuitState = CircuitState.HEALTHY;
    state.failures = 0;
    state.cooldownUntil = 0;

    if (wasUnhealthy) {
      this.emitDebug({
        type: 'key_recovered',
        keyId: state.config.id,
        timestamp: Date.now()
      });
    }
  }

  private openCircuit(state: KeyState): void {
    if (state.circuitState === CircuitState.OPEN) return;

    state.circuitState = CircuitState.OPEN;
    state.cooldownUntil = Date.now() + this.options.cooldownMs;

    this.emitDebug({
      type: 'circuit_opened',
      keyId: state.config.id,
      timestamp: Date.now(),
      details: { cooldownUntil: state.cooldownUntil, failures: state.failures }
    });
  }

  private toStats(state: KeyState): KeyStats {
    const rpmLimit = state.config.rpmLimit ?? this.options.defaultRpmLimit;
    const now = Date.now();
    const cooldownRemainingMs = state.cooldownUntil > now ? state.cooldownUntil - now : 0;
    return {
      id: state.config.id,
      key: this.maskKey(state.config.key),
      rpm: state.rpm,
      rpmLimit,
      utilization: rpmLimit > 0 ? state.rpm / rpmLimit : 0,
      circuitState: state.circuitState,
      failures: state.failures,
      avgLatencyMs: state.avgLatencyMs,
      totalRequests: state.totalRequests,
      totalErrors: state.totalErrors,
      isHealthy: (state.circuitState !== CircuitState.OPEN || cooldownRemainingMs === 0) && state.rpm < rpmLimit,
      cooldownRemainingMs
    };
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }

  private emitDebug(event: DebugEvent): void {
    if (this.options.onDebug) {
      this.options.onDebug(event);
    }
  }

  private startCleanupLoop(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredWindows();
      this.checkCircuitRecovery();
    }, Math.min(this.options.windowMs / 10, 10000)); // At least every 10s
  }

  private cleanupExpiredWindows(): void {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;

    for (const state of this.keys.values()) {
      state.requestTimestamps = state.requestTimestamps.filter(ts => ts >= windowStart);
      state.rpm = state.requestTimestamps.length;
    }
  }

  private checkCircuitRecovery(): void {
    const now = Date.now();
    for (const state of this.keys.values()) {
      if (state.circuitState === CircuitState.OPEN && now >= state.cooldownUntil) {
        this.transitionToHealthy(state);
      }
    }
  }
}