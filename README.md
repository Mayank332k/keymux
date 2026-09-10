# keymux

**Enterprise-grade API Key Multiplexer & Translation Proxy for LLM Providers**

Distribute requests across multiple API keys with intelligent Time-To-First-Token (TTFT) routing, zero-downtime failover, and resilient format translation. Compatible with OpenAI SDK, LangChain, Vercel AI SDK, and any OpenAI-compatible client.

> ⚠️ **Single Instance Only** — This library manages keys in-memory. For multi-instance deployments, see [Production Deployment](#production-deployment) below.

## Enterprise Features 🚀

- ⚡ **Smart Routing & TTFT Tracking** — Supports multiple strategies including Smart TTFT Routing (finds fastest API key by tracking live "Time To First Token" latency), Weighted Least Utilization, and RoundRobin.
- 🛡 **Zero-Downtime Failover** — Intercepts pre-response rate limits (429s) and 5xx errors using exponential backoff. It translates the model name to fit a fallback provider on the fly and retries automatically (note: it does not resume a stream that breaks midway).
- 🔄 **Full Translation Layer** — Maps Anthropic Claude prompts and tool calls to OpenAI/OpenRouter format for models like Groq, Nvidia, Gemini, and Mistral. Safely intercepts binary/Base64 files preventing JSON parsing crashes.
- 🔒 **Privacy-Safe Local Logging** — Keeps your data secure by ensuring all prompts and sensitive payloads are redacted in local logs.
- 🖥️ **Interactive CLI Dashboard** — A hacker-friendly interface featuring a cyberpunk ASCII logo, grouped tree view for easy monitoring, and live tracking of utilization and TTFT latencies.

## Installation

```bash
# Clone the repo
git clone https://github.com/your-username/keymux.git
cd keymux

# Build from source
npm run build
# or
npx tsc
```

## Quick Start

### With Multi-Provider Support (Groq, Nvidia, Gemini, etc.)

```typescript
import { createRouter } from 'keymux';
import OpenAI from 'openai';

// Create router with multiple Groq API keys for LPU speed
const router = createRouter('groq', [
  'gsk-key-1',
  'gsk-key-2',
  'gsk-key-3'
]);

// Use with OpenAI SDK (drop-in replacement)
const client = new OpenAI({
  apiKey: async () => await router.getKey(),
  baseURL: 'https://api.groq.com/openai/v1'
});

// Normal usage — streaming works perfectly with TTFT routing
const stream = await client.chat.completions.create({
  model: 'llama3-70b-8192',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### With LangChain

```typescript
import { createRouter } from 'keymux';
import { ChatOpenAI } from '@langchain/openai';

const router = createRouter('mistral', [
  'mistral-key-1', 'mistral-key-2', 'mistral-key-3'
]);

const llm = new ChatOpenAI({
  model: 'mistral-large-latest',
  baseURL: 'https://api.mistral.ai/v1',
  apiKey: async () => await router.getKey(),
  temperature: 0.7,
  streaming: true
});

// Works with LangGraph agents, chains, etc.
const response = await llm.invoke('Hello!');
```

### Zero-Downtime Failover in Action

```typescript
import { KeyRouter, createFailoverKeyGetter } from 'keymux';

const router = new KeyRouter({
  keys: [
    { id: 'primary-groq', key: 'gsk-xxx', provider: 'groq' },
    { id: 'backup-gemini', key: 'ai-zaSy...', provider: 'gemini' }
  ],
  trackLatency: true,
  // Keymux intercepts 429s from groq and auto-translates request for gemini
  enableAutoTranslation: true 
});

// Automatically retries on pre-response rate limit/server errors across providers using exponential backoff
const apiKey = createFailoverKeyGetter(router, 3);
```

## Dashboard & CLI

Launch the CLI proxy to enjoy the new Hacker Dashboard:
```bash
npx keymux start
```
You'll see:
- A cyberpunk ASCII logo
- Grouped Tree View of all configured providers and keys
- Real-time TTFT (Time to First Token) latencies
- Live utilization tracking

## Advanced Usage

### Custom Configuration

```typescript
import { KeyRouter } from 'keymux';

const router = new KeyRouter({
  keys: [
    { id: 'primary-1', key: 'nvapi-xxx', rpmLimit: 40, weight: 2 },  // Higher weight = more traffic
    { id: 'primary-2', key: 'nvapi-yyy', rpmLimit: 40, weight: 1 },
    { id: 'backup', key: 'nvapi-zzz', rpmLimit: 20, weight: 0.5 }   // Lower weight = less traffic
  ],
  defaultRpmLimit: 40,
  failureThreshold: 3,        // Open circuit after 3 failures
  cooldownMs: 30_000,         // 30 second cooldown
  windowMs: 60_000,           // 1-minute sliding window
  trackLatency: true,
  onDebug: (event) => console.log('[keymux]', event)
});

// Initialize (optional - auto-initializes on first getKey())
router.initialize();
```

### Monitoring & Stats

```typescript
// Get real-time stats
const stats = router.getOverallStats();
console.log(stats);
/*
{
  totalKeys: 6,
  healthyKeys: 5,
  overallUtilization: 0.75,
  fastestBandTTFT: '142ms',
  keys: [
    { id: 'primary-1', key: 'nvap****xxx', rpm: 35, ttft: '135ms', ... },
    ...
  ]
}
*/
```

## Selection Strategies

| Strategy | Description | Best For |
|----------|-------------|----------|
| `smart-ttft` | Fastest TTFT within +100ms tolerance band, then least utilized | **Default** — Max performance & fair distribution |
| `weighted-least-utilization` | Lowest (RPM/limit)/weight ratio | Mixed limits, fair distribution |
| `least-requests` | Lowest absolute RPM | Same limits, simple |
| `round-robin` | Rotates through keys | Predictable ordering |
| `least-latency` | Lowest avg latency without bands | Pure performance |
| `random` | Random from available | Even distribution over time |

## Error Handling

Keymux intercepts formats like Base64 PDFs from tools like Claude Code to prevent JSON parsing crashes, isolating failures at the payload translation layer.

## How It Works

```
┌────────────────────────────────────────────────────────────────────────┐
│                              KeyRouter                                 │
│  ┌─────────────┐    ┌────────────────────┐    ┌────────────────────┐   │
│  │ KeyTracker  │───▶│   TTFT Strategy    │───▶│  Selected Key      │   │
│  │ - TTFT ping │    │ - +100ms Band      │    │  - recordSuccess() │   │
│  │ - RPM count │    │ - Least utilized   │    │  - recordFailure() │   │
│  └─────────────┘    └────────────────────┘    └────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Request comes in** → `router.getKey()`
2. **Tracker filters** healthy keys (circuit closed + under RPM limit)
3. **Strategy identifies** the fastest keys (TTFT) and builds a `+100ms` tolerance band.
4. **Tie-breaker** picks the least utilized key in that fast band.
5. **Failover** dynamically translates payloads across providers if a 429 or 5xx error is hit pre-response.

## Production Deployment

**For single-instance servers** (e.g., Next.js, single Express server, cron jobs): this library works as-is!

**For multi-instance production deployments** (multiple containers/pods behind a load balancer): each instance maintains its own in-memory state, which causes load distribution to become inconsistent.

To fix this, you should run keymux as a separate microservice that acts as a central key manager:

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────┐
│ Instance 1  │──────▶│                  │──────▶│   Groq     │
├─────────────┤      │  KeyMux Service  │      └─────────────┘
│ Instance 2  │──────▶│  (manages keys,  │──────▶│   Mistral  │
├─────────────┤      │   tracks state,  │      └─────────────┘
│ Instance 3  │──────▶│   routes traffic)│──────▶│   Gemini   │
└─────────────┘      └──────────────────┘      └─────────────┘
```

This approach adds latency (extra network hop) but provides complete state isolation.

---

## License

MIT