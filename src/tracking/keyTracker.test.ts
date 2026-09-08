/**
 * Unit tests for KeyTracker
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KeyTracker } from './keyTracker';
import { CircuitState } from '../types';

describe('KeyTracker', () => {
  let tracker: KeyTracker;
  const testKeys = [
    { id: 'key-1', key: 'nvapi-test-key-1', rpmLimit: 10 },
    { id: 'key-2', key: 'nvapi-test-key-2', rpmLimit: 10 },
    { id: 'key-3', key: 'nvapi-test-key-3', rpmLimit: 10 }
  ];

  beforeEach(() => {
    tracker = new KeyTracker({
      defaultRpmLimit: 10,
      defaultWeight: 1,
      failureThreshold: 3,
      cooldownMs: 1000,
      windowMs: 60_000,
      trackLatency: true
    });
    tracker.initialize(testKeys);
  });

  afterEach(() => {
    tracker.destroy();
  });

  describe('Initialization', () => {
    it('should initialize all keys with correct defaults', () => {
      const states = tracker.getAllStates();
      expect(states).toHaveLength(3);

      for (const state of states) {
        expect(state.rpm).toBe(0);
        expect(state.circuitState).toBe(CircuitState.HEALTHY);
        expect(state.failures).toBe(0);
        expect(state.config.rpmLimit).toBe(10);
      }
    });
  });

  describe('Availability', () => {
    it('should return all keys as available initially', () => {
      const available = tracker.getAvailableKeys();
      expect(available).toHaveLength(3);
    });

    it('should exclude keys at RPM limit', () => {
      const state = tracker.getState('key-1')!;
      state.rpm = 10;

      const available = tracker.getAvailableKeys();
      expect(available).toHaveLength(2);
      expect(available.find(s => s.config.id === 'key-1')).toBeUndefined();
    });

    it('should exclude keys with open circuit', () => {
      const state = tracker.getState('key-1')!;
      state.circuitState = CircuitState.OPEN;
      state.cooldownUntil = Date.now() + 10000;

      const available = tracker.getAvailableKeys();
      expect(available).toHaveLength(2);
    });

    it('should auto-recover expired cooldown', () => {
      const state = tracker.getState('key-1')!;
      state.circuitState = CircuitState.OPEN;
      state.cooldownUntil = Date.now() - 1000;

      const available = tracker.getAvailableKeys();
      expect(available).toHaveLength(3);
      expect(state.circuitState).toBe(CircuitState.HEALTHY);
    });
  });

  describe('Success Recording', () => {
    it('should increment RPM and reset failures', () => {
      const state = tracker.getState('key-1')!;
      state.failures = 2;
      state.rpm = 5;

      tracker.recordSuccess('key-1', 100);

      expect(state.rpm).toBe(6);
      expect(state.failures).toBe(0);
      expect(state.totalRequests).toBe(1);
    });

    it('should track latency with EMA', () => {
      tracker.recordSuccess('key-1', 100);
      tracker.recordSuccess('key-1', 200);

      const state = tracker.getState('key-1')!;
      expect(state.avgLatencyMs).toBe(110);
    });

    it('should recover degraded key on success', () => {
      const state = tracker.getState('key-1')!;
      state.circuitState = CircuitState.DEGRADED;

      tracker.recordSuccess('key-1');

      expect(state.circuitState).toBe(CircuitState.HEALTHY);
    });
  });

  describe('Failure Recording', () => {
    it('should increment failures and RPM', () => {
      tracker.recordFailure('key-1', true);

      const state = tracker.getState('key-1')!;
      expect(state.failures).toBe(1);
      expect(state.rpm).toBe(1);
      expect(state.totalErrors).toBe(1);
    });

    it('should open circuit at threshold', () => {
      tracker.recordFailure('key-1', true);
      tracker.recordFailure('key-1', true);
      tracker.recordFailure('key-1', true);

      const state = tracker.getState('key-1')!;
      expect(state.circuitState).toBe(CircuitState.OPEN);
      expect(state.cooldownUntil).toBeGreaterThan(Date.now());
    });

    it('should set degraded at half threshold', () => {
      tracker.recordFailure('key-1', true);
      tracker.recordFailure('key-1', true);

      const state = tracker.getState('key-1')!;
      expect(state.circuitState).toBe(CircuitState.DEGRADED);
    });
  });

  describe('Manual Recovery', () => {
    it('should recover key on reportRecovery', () => {
      const state = tracker.getState('key-1')!;
      state.circuitState = CircuitState.OPEN;
      state.cooldownUntil = Date.now() + 10000;
      state.failures = 3;

      tracker.reportRecovery('key-1');

      expect(state.circuitState).toBe(CircuitState.HEALTHY);
      expect(state.failures).toBe(0);
      expect(state.cooldownUntil).toBe(0);
    });
  });

  describe('Statistics', () => {
    it('should return correct stats', () => {
      tracker.recordSuccess('key-1', 100);
      tracker.recordSuccess('key-1', 200);
      tracker.recordFailure('key-2', true);

      const stats = tracker.getStats();
      expect(stats).toHaveLength(3);

      const key1 = stats.find(s => s.id === 'key-1')!;
      expect(key1.rpm).toBe(2);
      expect(key1.totalRequests).toBe(2);
      expect(key1.avgLatencyMs).toBe(110);

      const key2 = stats.find(s => s.id === 'key-2')!;
      expect(key2.totalErrors).toBe(1);
      expect(key2.failures).toBe(1);
    });

    it('should return overall stats', () => {
      tracker.recordSuccess('key-1');
      tracker.recordSuccess('key-1');
      tracker.recordSuccess('key-2');

      const overall = tracker.getOverallStats();
      expect(overall.totalKeys).toBe(3);
      expect(overall.totalRpm).toBe(3);
      expect(overall.totalRpmLimit).toBe(30);
      expect(overall.overallUtilization).toBeCloseTo(0.1);
    });
  });

  describe('Sliding Window Cleanup', () => {
    it('should reset RPM for keys outside window', () => {
      const state = tracker.getState('key-1')!;
      state.rpm = 10;
      state.lastUsed = Date.now() - 70_000;

      (tracker as any).cleanupExpiredWindows();

      expect(state.rpm).toBe(0);
    });

    it('should not reset RPM for keys within window', () => {
      const state = tracker.getState('key-1')!;
      state.rpm = 10;
      state.lastUsed = Date.now() - 10_000;

      (tracker as any).cleanupExpiredWindows();

      expect(state.rpm).toBe(10);
    });
  });

  describe('Reset', () => {
    it('should reset all tracking data', () => {
      tracker.recordSuccess('key-1');
      tracker.recordFailure('key-2', true);
      tracker.recordFailure('key-2', true);
      tracker.recordFailure('key-2', true);

      tracker.reset();

      const states = tracker.getAllStates();
      for (const state of states) {
        expect(state.rpm).toBe(0);
        expect(state.failures).toBe(0);
        expect(state.circuitState).toBe(CircuitState.HEALTHY);
        expect(state.totalRequests).toBe(0);
        expect(state.totalErrors).toBe(0);
      }
    });
  });
});