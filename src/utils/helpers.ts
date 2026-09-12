/**
 * Utility helpers for keymux
 */

/**
 * Check if an error is a rate limit error (429)
 */
export function isRateLimitError(error: unknown, seen = new WeakSet<object>()): boolean {
  if (!error) return false;

  // OpenAI SDK error structure
  if (error instanceof Error || (typeof error === 'object' && error !== null)) {
    if (seen.has(error as object)) return false; // Prevent infinite recursion
    seen.add(error as object);
    
    if (error instanceof Error) {
      // Check error message
      const message = error.message.toLowerCase();
      if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
        return true;
      }
    }

    // Check for status code on error object
    const errWithStatus = error as { status?: number; statusCode?: number; code?: string; cause?: any };
    if (errWithStatus.status === 429 || errWithStatus.statusCode === 429 || errWithStatus.code === '429') {
      return true;
    }

    // Check cause chain
    if (errWithStatus.cause) {
      return isRateLimitError(errWithStatus.cause, seen);
    }
  }

  return false;
}

/**
 * Check if an error is a server error (5xx)
 */
export function isServerError(error: unknown, seen = new WeakSet<object>()): boolean {
  if (!error) return false;

  if (error instanceof Error || (typeof error === 'object' && error !== null)) {
    if (seen.has(error as object)) return false; // Prevent infinite recursion
    seen.add(error as object);
    
    const errWithStatus = error as { status?: number; statusCode?: number; cause?: any };
    const status = errWithStatus.status ?? errWithStatus.statusCode;
    if (status && status >= 500 && status < 600) {
      return true;
    }

    if (errWithStatus.cause) {
      return isServerError(errWithStatus.cause, seen);
    }
  }

  return false;
}

/**
 * Check if an error is retryable (rate limit or server error)
 */
export function isRetryableError(error: unknown): boolean {
  return isRateLimitError(error) || isServerError(error);
}

/**
 * Calculate exponential backoff delay with jitter
 */
export function calculateBackoff(attempt: number, baseMs: number = 1000, maxMs: number = 30000): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.min(Math.max(0, Math.round(delay + jitter)), maxMs);
}

/**
 * Mask API key for logging (show only first 4 and last 4 chars)
 * Example: sk-abcdef1234567890 -> sk-ab****7890
 */
export function maskKey(key: string): string {
  if (!key || key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/**
 * Parse comma-separated keys from string
 * Reads keys from environment variables - splits by comma to create an array
 * Filters out empty strings
 */
export function parseKeys(keysString: string): string[] {
  return keysString
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
}

/**
 * Create a simple async key getter for OpenAI SDK / LangChain
 * Usage: new ChatOpenAI({ apiKey: createKeyGetter(router) })
 * This function returns an async getter that calls router.getKey()
 */
export function createKeyGetter(router: { getKey(): Promise<string> }) {
  return async (): Promise<string> => {
    return router.getKey();
  };
}

/**
 * Create a key getter with automatic failover
 * Usage: new ChatOpenAI({ apiKey: createFailoverKeyGetter(router, 3) })
 */
export function createFailoverKeyGetter(
  router: {
    getKey(): Promise<string>;
    reportFailure(key: string, isRateLimit?: boolean): void;
    reportSuccess(key: string): void;
  },
  maxRetries: number = 3
) {
  return async (): Promise<string> => {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const key = await router.getKey();
        return key;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // If it's a rate limit error from our router (all keys exhausted), don't retry
        if (error instanceof Error && error.name === 'RateLimitError') {
          throw error;
        }

        // Wait before retry
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, calculateBackoff(attempt)));
        }
      }
    }

    throw lastError;
  };
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format router stats for pretty logging
 */
export function formatStats(stats: ReturnType<import('../core/keyRouter').KeyRouter['getOverallStats']>): string {
  const { totalKeys, healthyKeys, totalRpm, totalRpmLimit, overallUtilization, keys } = stats;

  const lines = [
    `📊 KeyRouter Stats: ${healthyKeys}/${totalKeys} healthy | ${totalRpm}/${totalRpmLimit} RPM (${(overallUtilization * 100).toFixed(1)}%)`,
    ''
  ];

  for (const key of keys) {
    const status = key.isHealthy ? '✅' : '❌';
    const circuit = key.circuitState === 'open' ? ' 🔴' : key.circuitState === 'degraded' ? ' 🟡' : '';
    lines.push(
      `  ${status} ${key.id}: ${key.rpm}/${key.rpmLimit} RPM (${(key.utilization * 100).toFixed(1)}%)${circuit} | ` +
      `Latency: ${key.avgLatencyMs}ms | Req: ${key.totalRequests} | Err: ${key.totalErrors}`
    );
  }

  return lines.join('\n');
}

/**
 * Create a periodic stats logger
 */
export function createStatsLogger(
  router: { getOverallStats(): ReturnType<import('../core/keyRouter').KeyRouter['getOverallStats']> },
  intervalMs: number = 60_000
): NodeJS.Timeout {
  return setInterval(() => {
    console.log(formatStats(router.getOverallStats()));
  }, intervalMs);
}