/**
 * keymux ka basic usage example
 * Yeh dikhata hai ke kaise API keys ko smart tarike se manage karte hain
 * Run with: npx tsx examples/basic-usage.ts
 */

import { createNvidiaRouter, createKeyGetter, createFailoverKeyGetter, formatStats, createStatsLogger } from '../src/index';

// ============================================
// 1. apne NVIDIA keys ke saath router banaye
// Yeh sab keys ko manage karega, unki tracking karega,
// aur best key select karega jab request karni ho
// ============================================
const router = createNvidiaRouter([
  'nvapi-key-1-from-env',
  'nvapi-key-2-from-env',
  'nvapi-key-3-from-env',
  'nvapi-key-4-from-env',
  'nvapi-key-5-from-env',
  'nvapi-key-6-from-env'
], {
  defaultRpmLimit: 40,
  failureThreshold: 3,
  cooldownMs: 30_000,
  onDebug: (event) => {
    if (event.type === 'circuit_opened') {
      console.log(`Circuit opened for ${event.keyId}`);
    } else if (event.type === 'key_recovered') {
      console.log(`Key recovered: ${event.keyId}`);
    }
  }
});

router.initialize();

console.log('keymux initialized with 6 NVIDIA keys');
console.log(`Total capacity: ${router.getOverallStats().totalRpmLimit} RPM`);
console.log('(Yeh total requests per minute hai jo sab keys milkar handle kar sakte hain)\n');

// ============================================
// 2. FETCH ke saath use karein (koi external library nahi chahiye)
// Yeh dikhata hai ke kaise manually API call karte hain
// aur failures ko handle karte hain
// ============================================
async function exampleWithFetch() {
  console.log('Making request via fetch...\n');

  for (let i = 0; i < 5; i++) {
    try {
      const key = await router.getKey();
      console.log(`   Using key: ${key.slice(0, 8)}****`);
      // Yeh automatically best available key return karta hai router se
      // Jab aap getKey() call karte ho toh:
      // 1. Sab available keys dekhta hai (jinka circuit breaker open nahi)
      // 2. Unki current utilization check karta hai (RPM / limit)
      // 3. Sabse kam utilization wala key return karta hai
      // 4. Is key ka RPM count increase karta hai
      // 5. Last update time update karta hai

      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nvidia/nemotron-3-ultra-550b-a55b',
          messages: [{ role: 'user', content: `Request ${i + 1}: Say hello briefly` }],
          max_tokens: 50,
          stream: false
        })
      });

      if (response.status === 429) {
        console.log(`   Rate limited! Reporting failure...`);
        // Yeh batata hai ke request fail hui due to rate limit
        // Router ko batate hain taaki:
        // 1. Is key ki failure count increase kare
        // 2. Agar failures threshold se zyada ho gayi toh circuit breaker open kare
        // 3. Is key ko temporary block kare (cooldown period ke liye)
        router.reportFailure(key, true);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`   Success: ${data.choices[0]?.message?.content?.slice(0, 50)}...`);
      // Yeh batata hai ke request successful thi
      // Router ko batate hain taaki:
      // 1. Is key ki failure count reset kare (success hua toh)
      // 2. Agar latency tracking on hai toh average latency update kare
      // 3. Key ko degraded state se recover kare agar woh tha
      router.reportSuccess(key);

    } catch (error) {
      console.log(`   Error: ${error}`);
    }
  }
}

// ============================================
// 3. MANUAL FAILOVER PATTERN
// ============================================
async function exampleWithManualFailover() {
  console.log('\nManual failover example...\n');

  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const key = await router.getKey();
      console.log(`   Attempt ${attempt + 1}: Using ${key.slice(0, 8)}****`);

      const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'nvidia/nemotron-3-ultra-550b-a55b',
          messages: [{ role: 'user', content: 'Test with failover' }],
          stream: false
        })
      });

      if (response.status === 429) {
        console.log(`   Rate limited, trying next key...`);
        router.reportFailure(key, true);
        continue;
      }

      router.reportSuccess(key);
      const data = await response.json();
      console.log(`   Success on attempt ${attempt + 1}`);
      return data;

    } catch (error) {
      console.log(`   Error: ${error}`);
    }
  }

  throw new Error('All keys exhausted after retries');
}

// ============================================
// 4. MONITORING & STATS
// ============================================
function exampleMonitoring() {
  console.log('\nCurrent Stats:');
  console.log(formatStats(router.getOverallStats()));
}

// ============================================
// RUN EXAMPLES
// ============================================
async function main() {
  console.log('='.repeat(50));
  console.log('keymux - Basic Usage Examples');
  console.log('='.repeat(50));

  await exampleWithFetch();
  await exampleWithManualFailover();
  exampleMonitoring();

  console.log('\nExamples completed!');
  router.destroy();
}

main().catch(console.error);