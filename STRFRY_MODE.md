# STRFRY MODE - Zero Network Calls in Hot Path

## The Real Problem

Your relay is dying because **every message requires 2-4 Redis network calls**:

```typescript
// Message arrives
await redis.lPush("nostr:relay:queue", msg);        // Network call 1
await redis.brPop("nostr:relay:queue", 1);          // Network call 2
await redis.rPush("nostr:responses:${connId}", response); // Network call 3
await redis.lPopCount(responseQueue, 100);          // Network call 4
```

**Each network call = 1-5ms latency**

At 10,000 messages/sec:
- 40,000 Redis calls/sec
- 40-200ms total latency per message
- Redis becomes the bottleneck
- Queue backs up
- Relay dies

## How strfry Does It

strfry has **ZERO network calls** in the hot path:

```cpp
// Message arrives on WebSocket
auto newMsgs = thr.inbox.pop_all();  // In-memory queue (0ms)

// Process in same thread
for (auto &msg : newMsgs) {
    validateEvent(msg);               // In-memory (0ms)
    writeToLMDB(msg);                 // Memory-mapped file (0ms)
    broadcastToSubs(msg);             // In-memory (0ms)
}
```

**Total latency: < 1ms**

## The Solution

We need to be like strfry but use OpenSearch for storage:

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│              SINGLE PROCESS (Like strfry)                │
│                                                          │
│  WebSocket Handler                                       │
│       │                                                  │
│       ▼                                                  │
│  In-Memory Queue (lock-free)                            │
│       │                                                  │
│       ▼                                                  │
│  Worker Threads (shared memory)                         │
│       │                                                  │
│       ├──▶ Validate (native secp256k1)                  │
│       │                                                  │
│       ├──▶ Store in memory buffer                       │
│       │                                                  │
│       └──▶ Broadcast to subscriptions (in-memory)       │
│                                                          │
│  Background Thread                                       │
│       │                                                  │
│       └──▶ Flush buffer to OpenSearch every 1s          │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Key Changes

1. **Eliminate Redis from hot path**
   - Use SharedArrayBuffer for inter-thread communication
   - Use Web Workers for parallel processing
   - Use in-memory Map for subscriptions

2. **Batch OpenSearch writes**
   - Buffer events in memory
   - Flush every 1 second or 1000 events
   - Only 1 network call per second (vs 40,000)

3. **Native validation**
   - Use Deno FFI to call libsecp256k1 directly
   - No WASM overhead
   - 10x faster signature verification

4. **In-memory subscriptions**
   - Store all subscriptions in Map<connId, Map<subId, filters>>
   - Match events in-memory (no Redis lookups)
   - Broadcast directly to WebSocket

## Implementation Plan

### Phase 1: Single-Process Architecture

Replace the entire worker pool with a single process:

```typescript
// main.ts
import { Server } from "./server-strfry-mode.ts";

const server = new Server({
  opensearchUrl: "http://localhost:9200",
  port: 8000,
  workerThreads: 16, // CPU cores
});

await server.start();
```

### Phase 2: In-Memory Queues

Use lock-free ring buffers instead of Redis:

```typescript
// Ring buffer with atomic operations
class RingBuffer<T> {
  private buffer: SharedArrayBuffer;
  private head: Atomics;
  private tail: Atomics;
  
  push(item: T): boolean {
    // Lock-free push using Atomics.compareExchange
  }
  
  pop(): T | null {
    // Lock-free pop using Atomics.compareExchange
  }
}
```

### Phase 3: Worker Threads

Use Web Workers with shared memory:

```typescript
// worker.ts
const sharedQueue = new RingBuffer(Deno.SharedArrayBuffer);

while (true) {
  const msg = sharedQueue.pop();
  if (msg) {
    const event = JSON.parse(msg);
    const valid = verifyEvent(event); // Native FFI
    if (valid) {
      eventBuffer.push(event);
      broadcastToSubscriptions(event);
    }
  }
}
```

### Phase 4: Batch OpenSearch

Buffer events and flush periodically:

```typescript
const eventBuffer: NostrEvent[] = [];

setInterval(async () => {
  if (eventBuffer.length > 0) {
    const batch = eventBuffer.splice(0, 1000);
    await opensearch.bulk({ body: batch }); // ONE network call
  }
}, 1000);
```

## Expected Performance

### Current (Redis-based)

```
Messages/sec:     1,000
Network calls:    40,000/sec
Latency:          40-200ms
Bottleneck:       Redis
```

### Strfry Mode (In-memory)

```
Messages/sec:     100,000+
Network calls:    1/sec (OpenSearch flush)
Latency:          < 1ms
Bottleneck:       CPU (validation)
```

**100x improvement!**

## File Structure

```
lib/
  ring-buffer.ts       # Lock-free ring buffer
  native-secp256k1.ts  # FFI to libsecp256k1
  subscription-index.ts # In-memory subscription matching
  event-buffer.ts      # Batched OpenSearch writer

services/
  server-strfry.ts     # Single-process server
  validation-worker.ts # Web Worker for validation
  
scripts/
  start-strfry.ts      # Start in strfry mode
```

## Next Steps

1. Implement lock-free ring buffer with SharedArrayBuffer
2. Create Web Workers for parallel validation
3. Add in-memory subscription index
4. Implement batched OpenSearch writer
5. Benchmark against strfry

## The Goal

**Be as fast as strfry for everything EXCEPT storage**

- Validation: Same speed (native secp256k1)
- Message routing: Same speed (in-memory)
- Subscriptions: Same speed (in-memory indexes)
- Storage: Use OpenSearch (for full-text search, trends, etc.)

**Result: strfry performance + OpenSearch features**
