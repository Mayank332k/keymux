/**
 * Unit tests for MultiProviderRouter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiProviderRouter } from './multiProviderRouter';
import { KeyRouterError, RateLimitError } from '../types';

describe('MultiProviderRouter', () => {
  let router: MultiProviderRouter;

  const testProviders = [
    {
      provider: 'nvidia',
      keys: ['nvapi-test-key-1', 'nvapi-test-key-2'],
      baseURL: 'https://integrate.api.nvidia.com/v1',
      models: ['nvidia/nemotron-3-ultra-550b-a55b'],
      rpmLimit: 5,
    },
    {
      provider: 'gemini',
      keys: ['AIza-test-key-1'],
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      models: ['gemini-2.5-flash'],
      rpmLimit: 5,
    },
    {
      provider: 'openrouter',
      keys: ['sk-or-test-key-1', 'sk-or-test-key-2'],
      baseURL: 'https://openrouter.ai/api/v1',
      models: ['deepseek/deepseek-chat:free'],
      rpmLimit: 5,
    },
  ];

  beforeEach(() => {
    router = new MultiProviderRouter(testProviders, {
      failureThreshold: 2,
      cooldownMs: 1000,
    });
  });

  afterEach(() => {
    router.destroy();
  });

  // ==================== Initialization ====================

  describe('Initialization', () => {
    it('should initialize with multiple providers', () => {
      const names = router.getProviderNames();
      expect(names).toContain('nvidia');
      expect(names).toContain('gemini');
      expect(names).toContain('openrouter');
      expect(names).toHaveLength(3);
    });

    it('should flatten keys across providers', () => {
      // 2 nvidia + 1 gemini + 2 openrouter = 5
      const ids = router.getAvailableEndpointIds();
      expect(ids).toHaveLength(5);
    });

    it('should throw on empty providers', () => {
      expect(() => new MultiProviderRouter([])).toThrow(KeyRouterError);
    });

    it('should throw on provider without baseURL and no preset', () => {
      expect(() => new MultiProviderRouter([
        { provider: 'unknown-custom', keys: ['key-1'] }
      ])).toThrow(KeyRouterError);
    });

    it('should auto-fill from PROVIDER_PRESETS for known providers', () => {
      const autoRouter = new MultiProviderRouter([
        { provider: 'nvidia', keys: ['nvapi-test'] },
      ]);

      const stats = autoRouter.getProviderStats('nvidia');
      expect(stats.totalKeys).toBe(1);
      expect(stats.totalRpmLimit).toBe(40); // from preset
      autoRouter.destroy();
    });
  });

  // ==================== Endpoint Selection ====================

  describe('getEndpoint', () => {
    it('should return a valid endpoint with all fields', async () => {
      const ep = await router.getEndpoint();

      expect(ep.key).toBeDefined();
      expect(ep.baseURL).toBeDefined();
      expect(ep.model).toBeDefined();
      expect(ep.provider).toBeDefined();
      expect(ep.endpointId).toBeDefined();
      expect(typeof ep.utilization).toBe('number');
    });

    it('should distribute across providers', async () => {
      const providers = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const ep = await router.getEndpoint();
        providers.add(ep.provider);
      }

      // Should use multiple providers (at least 2 out of 3)
      expect(providers.size).toBeGreaterThanOrEqual(2);
    });

    it('should return correct baseURL and model per provider', async () => {
      // Prefer nvidia to get a predictable result
      const ep = await router.getEndpoint({ preferProviders: ['nvidia'] });

      expect(ep.provider).toBe('nvidia');
      expect(ep.baseURL).toBe('https://integrate.api.nvidia.com/v1');
      expect(ep.model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
      expect(ep.key).toMatch(/^nvapi-test-key-/);
    });
  });

  // ==================== Provider Preferences ====================

  describe('preferProviders', () => {
    it('should prefer specified provider', async () => {
      const ep = await router.getEndpoint({ preferProviders: ['gemini'] });
      expect(ep.provider).toBe('gemini');
      expect(ep.model).toBe('gemini-2.5-flash');
    });

    it('should fallback when preferred provider is exhausted', async () => {
      // Exhaust gemini (1 key, 5 RPM limit)
      for (let i = 0; i < 5; i++) {
        await router.getEndpoint({ preferProviders: ['gemini'] });
      }

      // Next request should fallback to nvidia or openrouter
      const ep = await router.getEndpoint({ preferProviders: ['gemini'] });
      expect(ep.provider).not.toBe('gemini');
    });
  });

  describe('excludeProviders', () => {
    it('should never return excluded provider', async () => {
      for (let i = 0; i < 10; i++) {
        const ep = await router.getEndpoint({ excludeProviders: ['nvidia'] });
        expect(ep.provider).not.toBe('nvidia');
      }
    });

    it('should work with multiple exclusions', async () => {
      for (let i = 0; i < 5; i++) {
        const ep = await router.getEndpoint({
          excludeProviders: ['nvidia', 'openrouter'],
        });
        expect(ep.provider).toBe('gemini');
      }
    });

    it('should throw when all providers excluded or exhausted', async () => {
      await expect(
        router.getEndpoint({
          excludeProviders: ['nvidia', 'gemini', 'openrouter'],
        })
      ).rejects.toThrow(RateLimitError);
    });
  });

  describe('model filtering', () => {
    it('should select endpoint with matching model', async () => {
      const ep = await router.getEndpoint({ model: 'gemini-2.5-flash' });
      expect(ep.provider).toBe('gemini');
      expect(ep.model).toBe('gemini-2.5-flash');
    });

    it('should throw when model not found', async () => {
      await expect(
        router.getEndpoint({ model: 'nonexistent-model' })
      ).rejects.toThrow(RateLimitError);
    });
  });

  // ==================== Circuit Breaker & Failover ====================

  describe('Circuit Breaker & Failover', () => {
    it('should open circuit after failure threshold', async () => {
      const ep = await router.getEndpoint({ preferProviders: ['gemini'] });
      expect(ep.provider).toBe('gemini');

      // Report failures to trigger circuit breaker (threshold = 2)
      router.reportFailure(ep.endpointId, true);
      router.reportFailure(ep.endpointId, true);

      // gemini circuit should be open now
      expect(router.isEndpointHealthy(ep.endpointId)).toBe(false);
      expect(router.isProviderHealthy('gemini')).toBe(false);
    });

    it('should route to other providers after circuit opens', async () => {
      // Get gemini endpoint and break it
      const geminiEp = await router.getEndpoint({ preferProviders: ['gemini'] });
      router.reportFailure(geminiEp.endpointId, true);
      router.reportFailure(geminiEp.endpointId, true);

      // Next requests should go to nvidia or openrouter
      for (let i = 0; i < 5; i++) {
        const ep = await router.getEndpoint();
        expect(ep.provider).not.toBe('gemini');
      }
    });

    it('should recover after cooldown', async () => {
      // Create a router with higher RPM limits so RPM doesn't interfere with recovery
      const recoveryRouter = new MultiProviderRouter(
        [
          {
            provider: 'gemini',
            keys: ['AIza-recovery-key'],
            baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
            models: ['gemini-2.5-flash'],
            rpmLimit: 100,
          },
        ],
        { failureThreshold: 2, cooldownMs: 500 }
      );

      const ep = await recoveryRouter.getEndpoint();
      recoveryRouter.reportFailure(ep.endpointId, true);
      recoveryRouter.reportFailure(ep.endpointId, true);

      expect(recoveryRouter.isProviderHealthy('gemini')).toBe(false);

      // Wait for cooldown (500ms + buffer)
      await new Promise((r) => setTimeout(r, 700));

      // Trigger lazy recovery by requesting available keys
      expect(recoveryRouter.isProviderHealthy('gemini')).toBe(true);

      recoveryRouter.destroy();
    });

    it('should reset failures on success', async () => {
      const ep = await router.getEndpoint({ preferProviders: ['gemini'] });

      // 1 failure (below threshold of 2)
      router.reportFailure(ep.endpointId, true);
      expect(router.isEndpointHealthy(ep.endpointId)).toBe(true);

      // Success resets failures
      router.reportSuccess(ep.endpointId);

      // Another failure should not open circuit (only 1 cumulative)
      router.reportFailure(ep.endpointId, true);
      expect(router.isEndpointHealthy(ep.endpointId)).toBe(true);
    });
  });

  // ==================== RPM Tracking ====================

  describe('RPM Tracking', () => {
    it('should track RPM per endpoint', async () => {
      await router.getEndpoint({ preferProviders: ['gemini'] });
      await router.getEndpoint({ preferProviders: ['gemini'] });

      const stats = router.getProviderStats('gemini');
      expect(stats.totalRpm).toBe(2);
    });

    it('should throw when all endpoints exhausted', async () => {
      // Exhaust all 5 keys (5 RPM each = 25 total)
      for (let i = 0; i < 25; i++) {
        await router.getEndpoint();
      }

      await expect(router.getEndpoint()).rejects.toThrow(RateLimitError);
    });
  });

  // ==================== Stats & Monitoring ====================

  describe('Stats', () => {
    it('should return overall stats', async () => {
      await router.getEndpoint();
      await router.getEndpoint();
      await router.getEndpoint();

      const stats = router.getOverallStats();
      expect(stats.totalKeys).toBe(5);
      expect(stats.totalRpm).toBe(3);
      expect(stats.totalRpmLimit).toBe(25); // 5 keys * 5 RPM each
    });

    it('should return per-provider stats', () => {
      const nvidiaStats = router.getProviderStats('nvidia');
      expect(nvidiaStats.provider).toBe('nvidia');
      expect(nvidiaStats.totalKeys).toBe(2);
      expect(nvidiaStats.totalRpmLimit).toBe(10); // 2 keys * 5 RPM

      const geminiStats = router.getProviderStats('gemini');
      expect(geminiStats.totalKeys).toBe(1);
      expect(geminiStats.totalRpmLimit).toBe(5); // 1 key * 5 RPM
    });

    it('should return empty stats for unknown provider', () => {
      const stats = router.getProviderStats('unknown');
      expect(stats.totalKeys).toBe(0);
    });
  });

  // ==================== Dynamic Management ====================

  describe('Dynamic Management', () => {
    it('should add a new provider at runtime', async () => {
      router.addProvider({
        provider: 'deepseek',
        keys: ['ds-test-key-1'],
        baseURL: 'https://api.deepseek.com/v1',
        models: ['deepseek-chat'],
        rpmLimit: 5,
      });

      expect(router.getProviderNames()).toContain('deepseek');
      expect(router.getAvailableEndpointIds()).toHaveLength(6); // 5 + 1

      const ep = await router.getEndpoint({ preferProviders: ['deepseek'] });
      expect(ep.provider).toBe('deepseek');
      expect(ep.model).toBe('deepseek-chat');
    });

    it('should throw when adding provider with no keys', () => {
      expect(() =>
        router.addProvider({ provider: 'empty', keys: [] })
      ).toThrow(KeyRouterError);
    });

    it('should add a key to existing provider', () => {
      router.addKeyToProvider('gemini', 'AIza-new-key');

      const stats = router.getProviderStats('gemini');
      expect(stats.totalKeys).toBe(2); // was 1, now 2
    });

    it('should throw when adding key to unknown provider', () => {
      expect(() =>
        router.addKeyToProvider('unknown', 'key')
      ).toThrow(KeyRouterError);
    });

    it('should remove a provider', () => {
      const removed = router.removeProvider('openrouter');
      expect(removed).toBe(true);
      expect(router.getProviderNames()).not.toContain('openrouter');
      expect(router.getAvailableEndpointIds()).toHaveLength(3); // 5 - 2
    });

    it('should return false for removing unknown provider', () => {
      expect(router.removeProvider('unknown')).toBe(false);
    });

    it('should remove a specific key', () => {
      const removed = router.removeKey('nvidia', 'nvapi-test-key-1');
      expect(removed).toBe(true);

      const stats = router.getProviderStats('nvidia');
      expect(stats.totalKeys).toBe(1); // was 2, now 1
    });

    it('should remove provider when last key is removed', () => {
      router.removeKey('gemini', 'AIza-test-key-1');
      expect(router.getProviderNames()).not.toContain('gemini');
    });
  });

  // ==================== Strategy ====================

  describe('Strategy', () => {
    it('should allow changing strategy', async () => {
      router.setStrategy('round-robin');

      // Should work without errors
      const ep = await router.getEndpoint();
      expect(ep).toBeDefined();
    });
  });

  // ==================== Health Checks ====================

  describe('Health Checks', () => {
    it('should report endpoint health', async () => {
      const ep = await router.getEndpoint({ preferProviders: ['nvidia'] });
      expect(router.isEndpointHealthy(ep.endpointId)).toBe(true);
    });

    it('should report false for unknown endpoint', () => {
      expect(router.isEndpointHealthy('nonexistent')).toBe(false);
    });

    it('should report provider health', () => {
      expect(router.isProviderHealthy('nvidia')).toBe(true);
      expect(router.isProviderHealthy('unknown')).toBe(false);
    });
  });

  // ==================== Reset ====================

  describe('Reset', () => {
    it('should reset all tracking data', async () => {
      // Use some endpoints
      for (let i = 0; i < 10; i++) {
        await router.getEndpoint();
      }

      const statsBefore = router.getOverallStats();
      expect(statsBefore.totalRpm).toBe(10);

      router.reset();

      const statsAfter = router.getOverallStats();
      expect(statsAfter.totalRpm).toBe(0);
    });
  });
});
