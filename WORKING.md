# How keymux Works — Simple Explanation

This doc explains how keymux works in plain English. No technical jargon, just the concept. 🤓

---

## The Problem We're Solving

You have **multiple API keys** (like 5 NVIDIA keys) and you want to:
1. Use all of them so no single key gets overloaded
2. Automatically skip keys that are failing or rate-limited
3. Distribute traffic fairly based on each key's limits

---

## The Core Idea

Think of keymux as a **smart traffic controller** for your API keys:

```
                    ┌─────────────────────────────────────┐
                    │           Your Application            │
                    │              (LLM calls)              │
                    └──────────────────┬──────────────────┘
                                       │ "Give me a key"
                                       ▼
                          ┌─────────────────────────┐
                          │        KeyRouter         │
                          │   (Smart Traffic Cop)    │
                          └───────────┬─────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                  │
                    ▼                 ▼                  ▼
              ┌──────────┐     ┌──────────┐      ┌──────────┐
              │  Key A   │     │  Key B   │      │  Key C   │
              │ (60% ok) │     │ (20% ok) │      │ (10% ok) │
              └──────────┘     └──────────┘      └──────────┘
```

---

## Step-by-Step Flow

### 1. Setup (One Time)

```typescript
const router = new KeyRouter({
  keys: [
    { id: 'key-a', key: 'nvapi-xxx', rpmLimit: 40 },  // Can do 40 req/min
    { id: 'key-b', key: 'nvapi-yyy', rpmLimit: 40 },
    { id: 'key-c', key: 'nvapi-zzz', rpmLimit: 20 }   // Slower key
  ]
});
```

### 2. Getting a Key

When you need to make an API call:

```typescript
// Your code
const key = await router.getKey();

// keymux internally:
// 1. Checks which keys are "healthy" (not broken, under limit)
// 2. Picks the one that's being used the least
// 3. Returns it to you
```

### 3. Reporting Success

```typescript
// After successful API call
router.reportSuccess(key);

// keymux records:
// - This key was used
// - Increment its request count for this minute
// - Reset failure count (good job key!)
```

### 4. Reporting Failure

```typescript
// If API returned 429 (rate limit) or 5xx (error)
router.reportFailure(key, true);  // true = it's a rate limit

// keymux records:
// - Increment failure count
// - If failures get too high → "circuit opens" (key is paused)
// - After cooldown → key comes back healthy
```

---

## Key Concepts Explained

### RPM (Requests Per Minute)

Every key has a limit (default 40 RPM). keymux tracks how many requests each key has handled in the last 60 seconds using a **sliding window**.

```
Time: 0s ────────────────────────────────▶ 60s

At t=0s: Request sent to Key A
At t=30s: Request sent to Key A  ──┐
At t=45s: Request sent to Key A  ──┼── Window
At t=55s: Request sent to Key A  ──┘

At t=61s: Old request (t=0s) falls out of window
```

### Circuit Breaker (The Protector)

When a key starts failing too much, keymux "opens the circuit" — it stops using that key for a while.

```
Normal State:
  Key A: ✅ HEALTHY (few failures)
  Key B: ⚠️ DEGRADED (some failures)  
  Key C: 🔴 OPEN (too many failures, cooling down)

After 30 seconds:
  Key C: ✅ HEALTHY (cooldown finished)
```

Why? So a failing key can "rest" and the provider's systems recover.

### Weighted Distribution

If you have keys with different capabilities, you can set weights:

```typescript
{ id: 'fast-key', key: '...', rpmLimit: 60, weight: 2 }   // Gets 2x traffic
{ id: 'slow-key', key: '...', rpmLimit: 30, weight: 1 }  // Gets 1x traffic
```

The formula is basically: `(requests_used / rpm_limit) / weight`

Lower ratio = less utilized = gets picked next.

---

## What Happens in Different Scenarios

### Scenario 1: All Keys Healthy

```
Request 1 → Key A (20% used) ← picked (least utilized)
Request 2 → Key B (15% used) ← picked
Request 3 → Key C (25% used) ← picked
```

### Scenario 2: One Key Rate Limited

```
Key A: 100% used (limit reached)
Key B: 20% used ✅ ← picked
Key C: 30% used ✅ ← picked
```

Key A is temporarily skipped until its window clears.

### Scenario 3: One Key Failing

```
Key A: Circuit OPEN (3 failures in a row)
Key B: 40% used ✅ ← picked
Key C: 30% used ✅ ← picked

After 30 seconds cooldown:
Key A: Tries again, if healthy → back in rotation
```

### Scenario 4: All Keys Failing

```
Key A: OPEN
Key B: OPEN  
Key C: OPEN

router.getKey() → throws RateLimitError ❌

Solution: Wait for cooldown, or add more keys
```

---

## Putting It Together (Full Example)

```typescript
import { KeyRouter } from 'keymux';

const router = new KeyRouter({
  keys: [
    { id: 'key-a', key: 'nvapi-xxx', rpmLimit: 40 },
    { id: 'key-b', key: 'nvapi-yyy', rpmLimit: 40 },
    { id: 'key-c', key: 'nvapi-zzz', rpmLimit: 40 }
  ]
});

// Your AI call function
async function chat(message) {
  const key = await router.getKey();
  
  try {
    const response = await fetch('/v1/chat/completions', {
      headers: { 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ messages })
    });
    
    if (response.ok) {
      router.reportSuccess(key);  // ✅ Great, key is healthy
      return response.json();
    }
    
    if (response.status === 429) {
      router.reportFailure(key, true);  // Rate limited, try again
      return chat(message);  // Recursive retry with different key
    }
    
    router.reportFailure(key, false);  // Server error
    throw new Error('API failed');
    
  } catch (error) {
    router.reportFailure(key, false);
    throw error;
  }
}
```

---

## Quick Reference

| What You Want | What To Call |
|--------------|--------------|
| Get a key for your API call | `router.getKey()` |
| Tell keymux the call succeeded | `router.reportSuccess(key)` |
| Tell keymux the call failed | `router.reportFailure(key, isRateLimit?)` |
| Check key health | `router.getStats()` |
| Add a new key at runtime | `router.addKey({ id, key })` |
| Remove a broken key | `router.removeKey('key-id')` |

---

## That's It! 🎉

keymux is essentially:
1. A smart key picker (selects least-used key)
2. A rate limiter (tracks RPM per key)
3. A circuit breaker (pauses failing keys)

No magic, just good engineering for handling multiple API keys reliably.
