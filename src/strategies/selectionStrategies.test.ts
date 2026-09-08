/**
 * Unit tests for Selection Strategies
 */

import { describe, it, expect } from 'vitest';
import {
  WeightedLeastUtilizationStrategy,
  LeastRequestsStrategy,
  RoundRobinStrategy,
  LeastLatencyStrategy,
  PreferredKeysStrategy,
  RandomStrategy,
  createStrategy
} from './selectionStrategies';
import type { KeyState, SelectionOptions } from '../types';
import { CircuitState } from '../types';

function createMockKey(id: string, rpm: number, rpmLimit: number = 10, weight: number = 1, avgLatencyMs: number = 0): KeyState {
  return {
    config: { id, key: `key-${id}`, rpmLimit, weight },
    rpm,
    lastUsed: Date.now(),
    circuitState: CircuitState.HEALTHY,
    failures: 0,
    cooldownUntil: 0,
    avgLatencyMs,
    totalRequests: rpm,
    totalErrors: 0
  };
}

describe('WeightedLeastUtilizationStrategy', () => {
  const strategy = new WeightedLeastUtilizationStrategy();

  it('should pick key with lowest utilization', () => {
    const keys = [
      createMockKey('key-1', 5, 10),  // 50% util
      createMockKey('key-2', 2, 10),  // 20% util
      createMockKey('key-3', 8, 10)   // 80% util
    ];

    const selected = strategy.select(keys);
    expect(selected?.config.id).toBe('key-2');
  });

  it('should weight by key weight', () => {
    const keys = [
      createMockKey('key-1', 4, 10, 2),  // 40% util / 2 = 20% effective
      createMockKey('key-2', 2, 10, 1)   // 20% util / 1 = 20% effective
    ];

    const selected = strategy.select(keys);
    // Both have same effective utilization, should pick first (stable sort)
    expect(selected?.config.id).toBe('key-1');
  });

  it('should handle different RPM limits', () => {
    const keys = [
      createMockKey('key-1', 8, 20),  // 40% util
      createMockKey('key-2', 3, 10)   // 30% util
    ];

    const selected = strategy.select(keys);
    expect(selected?.config.id).toBe('key-2');
  });

  it('should respect maxUtilization filter', () => {
    const keys = [
      createMockKey('key-1', 8, 10),  // 80% util
      createMockKey('key-2', 5, 10)   // 50% util
    ];

    const options: SelectionOptions = { maxUtilization: 0.6 };
    const selected = strategy.select(keys, options);
    expect(selected?.config.id).toBe('key-2');
  });

  it('should return null when all keys exceed maxUtilization', () => {
    const keys = [
      createMockKey('key-1', 8, 10),
      createMockKey('key-2', 9, 10)
    ];

    const options: SelectionOptions = { maxUtilization: 0.5 };
    const selected = strategy.select(keys, options);
    expect(selected).toBeNull();
  });

  it('should return null for empty array', () => {
    const selected = strategy.select([]);
    expect(selected).toBeNull();
  });
});

describe('LeastRequestsStrategy', () => {
  const strategy = new LeastRequestsStrategy();

  it('should pick key with lowest absolute RPM', () => {
    const keys = [
      createMockKey('key-1', 5, 10),
      createMockKey('key-2', 2, 10),
      createMockKey('key-3', 8, 10)
    ];

    const selected = strategy.select(keys);
    expect(selected?.config.id).toBe('key-2');
  });

  it('should ignore RPM limits (uses absolute count)', () => {
    const keys = [
      createMockKey('key-1', 8, 20),  // 40% but 8 absolute
      createMockKey('key-2', 3, 10)   // 30% but 3 absolute
    ];

    const selected = strategy.select(keys);
    expect(selected?.config.id).toBe('key-2');
  });
});

describe('RoundRobinStrategy', () => {
  it('should rotate through keys', () => {
    const strategy = new RoundRobinStrategy();
    const keys = [
      createMockKey('key-1', 0, 10),
      createMockKey('key-2', 0, 10),
      createMockKey('key-3', 0, 10)
    ];

    const results = [];
    for (let i = 0; i < 6; i++) {
      const selected = strategy.select(keys);
      results.push(selected?.config.id);
    }

    expect(results).toEqual(['key-1', 'key-2', 'key-3', 'key-1', 'key-2', 'key-3']);
  });

  it('should skip keys exceeding maxUtilization', () => {
    const strategy = new RoundRobinStrategy();
    const keys = [
      createMockKey('key-1', 8, 10),  // 80%
      createMockKey('key-2', 2, 10),  // 20%
      createMockKey('key-3', 3, 10)   // 30%
    ];

    const options: SelectionOptions = { maxUtilization: 0.5 };
    const selected = strategy.select(keys, options);
    // Should pick key-2 or key-3 (both under 50%)
    expect(['key-2', 'key-3']).toContain(selected?.config.id);
  });
});

describe('LeastLatencyStrategy', () => {
  const strategy = new LeastLatencyStrategy();

  it('should pick key with lowest latency', () => {
    const keys = [
      createMockKey('key-1', 2, 10, 1, 500),
      createMockKey('key-2', 2, 10, 1, 200),
      createMockKey('key-3', 2, 10, 1, 800)
    ];

    const selected = strategy.select(keys);
    expect(selected?.config.id).toBe('key-2');
  });

  it('should fallback to least-requests when no latency data', () => {
    const keys = [
      createMockKey('key-1', 5, 10, 1, 0),
      createMockKey('key-2', 2, 10, 1, 0)
    ];

    const selected = strategy.select(keys);
    expect(selected?.config.id).toBe('key-2');
  });
});

describe('PreferredKeysStrategy', () => {
  const fallback = new WeightedLeastUtilizationStrategy();
  const strategy = new PreferredKeysStrategy(fallback);

  it('should pick preferred key if available and healthy', () => {
    const keys = [
      createMockKey('key-1', 5, 10),
      createMockKey('key-2', 2, 10)
    ];

    const options: SelectionOptions = { preferredKeys: ['key-2'] };
    const selected = strategy.select(keys, options);
    expect(selected?.config.id).toBe('key-2');
  });

  it('should skip preferred key if over maxUtilization', () => {
    const keys = [
      createMockKey('key-1', 2, 10),
      createMockKey('key-2', 8, 10)
    ];

    const options: SelectionOptions = { preferredKeys: ['key-2'], maxUtilization: 0.5 };
    const selected = strategy.select(keys, options);
    expect(selected?.config.id).toBe('key-1');
  });

  it('should fallback when preferred key not in pool', () => {
    const keys = [
      createMockKey('key-1', 2, 10),
      createMockKey('key-2', 5, 10)
    ];

    const options: SelectionOptions = { preferredKeys: ['key-999'] };
    const selected = strategy.select(keys, options);
    expect(selected?.config.id).toBe('key-1'); // fallback to least util
  });
});

describe('RandomStrategy', () => {
  const strategy = new RandomStrategy();

  it('should return a key from available pool', () => {
    const keys = [
      createMockKey('key-1', 2, 10),
      createMockKey('key-2', 5, 10)
    ];

    const selected = strategy.select(keys);
    expect(selected).not.toBeNull();
    expect(['key-1', 'key-2']).toContain(selected?.config.id);
  });

  it('should respect maxUtilization', () => {
    const keys = [
      createMockKey('key-1', 8, 10),
      createMockKey('key-2', 2, 10)
    ];

    const options: SelectionOptions = { maxUtilization: 0.5 };
    const selected = strategy.select(keys, options);
    expect(selected?.config.id).toBe('key-2');
  });
});

describe('createStrategy factory', () => {
  it('should create weighted-least-utilization by default', () => {
    const strategy = createStrategy('unknown');
    expect(strategy.name).toBe('weighted-least-utilization');
  });

  it('should create all known strategies', () => {
    expect(createStrategy('weighted-least-utilization').name).toBe('weighted-least-utilization');
    expect(createStrategy('least-requests').name).toBe('least-requests');
    expect(createStrategy('round-robin').name).toBe('round-robin');
    expect(createStrategy('least-latency').name).toBe('least-latency');
    expect(createStrategy('random').name).toBe('random');
  });

  it('should create preferred-keys with fallback', () => {
    const strategy = createStrategy('preferred-keys');
    expect(strategy.name).toBe('preferred-keys');
  });
});