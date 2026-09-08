/**
 * Unit tests for KeyRouter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KeyRouter } from './keyRouter';
import { KeyRouterError, RateLimitError, CircuitState } from '../types';
import { isRateLimitError, isServerError, isRetryableError, calculateBackoff, maskKey } from '../utils/helpers';

describe('KeyRouter', () => {
  let router: KeyRouter;
  let testKeys: typeof testKeysInternal;
  const testKeysInternal = [
    { id: 'key-1', key: 'nvapi-test-key-1', rpmLimit: 10 },
    { id: 'key-2', key: 'nvapi-test-key-2', rpmLimit: 10 },
    { id: 'key-3', key: 'nvapi-test-key-3', rpmLimit: 10 }
  ];

  beforeEach(() => {
    testKeys = testKeysInternal.map(k => ({ ...k }));
    router = new KeyRouter({
      keys: testKeys,
      defaultRpmLimit: 10,
      failureThreshold: 2,
      cooldownMs: 1000, // 1 second for testing
      windowMs: 60_000
    });
  });

  afterEach(() => {
    router.destroy();
  });

  describe('Initialization', () => {
    it('should initialize with valid keys', () => {
      router.initialize();
      expect(router.getAvailableKeyIds()).toHaveLength(3);
    });

    it('should throw on empty keys', () => {
      const emptyRouter = new KeyRouter({ keys: [] });
      try {
        emptyRouter.initialize();
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(KeyRouterError);
        expect(error.code).toBe('NO_KEYS_CONFIGURED');
      }
    });

    it('should throw on invalid key config', () => {
      const badRouter = new KeyRouter({ keys: [{ id: 'test', key: '' }] });
      expect(() => badRouter.initialize()).toThrow(KeyRouterError);
    });

    it('should auto-initialize on first getKey()', async () => {
      const key = await router.getKey();
      expect(key).toBeDefined();
      expect(typeof key).toBe('string');
    });
  });

  describe('Key Selection', () => {
    it('should return a valid key', async () => {
      const key = await router.getKey();
      expect(key).toMatch(/^nvapi-test-key-\d+$/);
    });

    it('should distribute across keys (least utilization)', async () => {
      // Use all keys once
      const keys = await Promise.all([
        router.getKey(),
        router.getKey(),
        router.getKey()
      ]);

      // All three keys should be used
      expect(new Set(keys).size).toBe(3);
    });

    it('should prefer key with lower utilization', async () => {
      // Use key-1 twice
      await router.getKey(); // key-1
      await router.getKey(); // key-1 again (round 2)

      // Use key-2 once
      await router.getKey(); // key-2

      // Next should prefer key-3 (0 usage) or key-2 (1 usage) over key-1 (2 usage)
      const stats = router.getStats();
      const key1 = stats.find(s => s.id === 'key-1');
      const key3 = stats.find(s => s.id === 'key-3');

      expect(key3!.rpm).toBeLessThanOrEqual(key1!.rpm);
    });

    it('should respect maxUtilization option', async () => {
      // Fill key-1 to 80%
      for (let i = 0; i < 8; i++) {
        await router.getKey({ preferredKeys: ['key-1'] });
      }

      // Now request with maxUtilization 0.5 - should skip key-1
      const key = await router.getKey({ maxUtilization: 0.5 });
      expect(key).not.toBe('nvapi-test-key-1');
    });
  });

  describe('RPM Tracking', () => {
    it('should track RPM per key', async () => {
      await router.getKey({ preferredKeys: ['key-1'] });
      await router.getKey({ preferredKeys: ['key-1'] });

      const stats = router.getStats();
      const key1 = stats.find(s => s.id === 'key-1');
      expect(key1!.rpm).toBe(2);
    });

    it('should track overall stats', async () => {
      await router.getKey();
      await router.getKey();
      await router.getKey();

      const overall = router.getOverallStats();
      expect(overall.totalRpm).toBe(3);
      expect(overall.totalKeys).toBe(3);
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after failure threshold', async () => {
      const key = await router.getKey({ preferredKeys: ['key-1'] });

      // Report failures
      router.reportFailure(key, true);
      router.reportFailure(key, true); // 2nd failure = threshold

      // Key should now be unavailable
      const available = router.getAvailableKeyIds();
      expect(available).not.toContain('key-1');
    });

    it('should recover after cooldown', async () => {
      const key = await router.getKey({ preferredKeys: ['key-1'] });
      router.reportFailure(key, true);
      router.reportFailure(key, true);

      // Wait for cooldown
      await new Promise(r => setTimeout(r, 1100));

      // Should be available again
      const available = router.getAvailableKeyIds();
      expect(available).toContain('key-1');
    });

    it('should reset failures on success', async () => {
      const key = await router.getKey({ preferredKeys: ['key-1'] });
      router.reportFailure(key, true); // 1 failure

      // Success should reset
      router.reportSuccess(key);

      // Another failure should not open circuit (only 1 failure)
      router.reportFailure(key, true);
      const available = router.getAvailableKeyIds();
      expect(available).toContain('key-1');
    });
  });

  describe('Error Handling', () => {
    it('should throw RateLimitError when all keys exhausted', async () => {
      // Exhaust all keys
      for (const keyConfig of testKeys) {
        for (let i = 0; i < 10; i++) {
          await router.getKey({ preferredKeys: [keyConfig.id] });
        }
      }

      // Next request should throw
      await expect(router.getKey()).rejects.toThrow(RateLimitError);
    });

    it('should report failure by partial key match', async () => {
      const key = await router.getKey({ preferredKeys: ['key-1'] });
      router.reportFailure(key, true);

      const stats = router.getStats();
      const key1 = stats.find(s => s.id === 'key-1');
      expect(key1!.failures).toBe(1);
    });
  });

  describe('Dynamic Key Management', () => {
    it('should add key at runtime', () => {
      router.addKey({ id: 'key-4', key: 'nvapi-new-key', rpmLimit: 10 });
      expect(router.getAvailableKeyIds()).toContain('key-4');
    });

    it('should remove key at runtime', () => {
      const removed = router.removeKey('key-1');
      expect(removed).toBe(true);
      expect(router.getAvailableKeyIds()).not.toContain('key-1');
    });

    it('should update key config at runtime', () => {
      router.updateKey('key-1', { rpmLimit: 20, weight: 2 });
      const stats = router.getStats();
      const key1 = stats.find(s => s.id === 'key-1');
      expect(key1!.rpmLimit).toBe(20);
    });
  });

  describe('Factory Methods', () => {
    it('should create NVIDIA router', () => {
      const nvidiaRouter = KeyRouter.forNvidia(['key1', 'key2']);
      expect(nvidiaRouter).toBeInstanceOf(KeyRouter);
      nvidiaRouter.destroy();
    });

    it('should create router from provider preset', () => {
      const mistralRouter = KeyRouter.fromProvider('mistral', ['key1', 'key2']);
      expect(mistralRouter).toBeInstanceOf(KeyRouter);
      mistralRouter.destroy();
    });
  });

  describe('Strategy Selection', () => {
    it('should use weighted least utilization by default', () => {
      expect(router['strategy'].name).toBe('weighted-least-utilization');
    });

    it('should allow changing strategy', () => {
      router.setStrategy('round-robin');
      expect(router['strategy'].name).toBe('round-robin');
    });
  });
});

describe('Helper Functions', () => {

  it('should detect rate limit errors', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
    expect(isRateLimitError(new Error('network error'))).toBe(false);
  });

  it('should detect server errors', () => {
    expect(isServerError({ status: 500 })).toBe(true);
    expect(isServerError({ status: 503 })).toBe(true);
    expect(isServerError({ status: 400 })).toBe(false);
  });

  it('should calculate backoff with jitter', () => {
    const delays = Array.from({ length: 100 }, (_, i) => calculateBackoff(i, 1000, 10000));
    expect(delays[0]).toBeGreaterThanOrEqual(750); // 1000 * 0.75
    expect(delays[0]).toBeLessThanOrEqual(1250);   // 1000 * 1.25
    expect(delays[99]).toBeLessThanOrEqual(10000); // capped at max
  });

  it('should mask keys correctly', () => {
    expect(maskKey('nvapi-abcdefgh1234')).toBe('nvap****1234');
    expect(maskKey('short')).toBe('****');
    expect(maskKey('')).toBe('****');
  });
});