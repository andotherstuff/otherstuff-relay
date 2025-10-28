# Duplicate Handling in otherstuff-relay

## Overview

The system has **NO automatic duplicate prevention** at the database level. ClickHouse allows duplicate event IDs to be inserted. Duplicate handling is **optional** and must be explicitly enabled in the import script or handled at the application level.

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS nostr_events (
  id String,
  pubkey String,
  created_at UInt32,
  kind UInt32,
  tags Array(Array(String)),
  content String,
  sig String,
  event_date Date MATERIALIZED toDate(toDateTime(created_at)),
  INDEX idx_pubkey pubkey TYPE bloom_filter GRANULARITY 1,
  INDEX idx_kind kind TYPE minmax GRANULARITY 1,
  INDEX idx_created_at created_at TYPE minmax GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (kind, created_at, id)
```

### Key Points:
- ❌ **NO UNIQUE constraint** on the `id` field
- ❌ **NO PRIMARY KEY** constraint
- ✅ Events are ordered by `(kind, created_at, id)` but duplicates are allowed
- ⚠️ Multiple events with the same `id` can coexist in the database

## Import Script Duplicate Handling

The import script (`src/import.ts`) has **two levels** of duplicate detection:

### 1. In-Memory Deduplication (Always Active)

```typescript
// Check for duplicates in current session
if (this.seenIds.has(event.id)) {
  this.stats.duplicateEvents++;
  continue;
}
this.seenIds.add(event.id);
```

**What it does:**
- Tracks event IDs seen during the current import session
- Prevents importing the same event twice in a single import run
- Uses a `Set<string>` in memory

**Limitations:**
- Only prevents duplicates within a single import run
- Does NOT check against existing database data (unless `--skip-duplicates` is used)
- Memory usage grows with file size (stores all event IDs)

### 2. Database Deduplication (Optional - `--skip-duplicates` flag)

```typescript
private async filterDuplicates(events: NostrEvent[]): Promise<NostrEvent[]> {
  const ids = events.map((e) => e.id);

  const query = `
    SELECT id
    FROM nostr_events
    WHERE id IN {ids:Array(String)}
  `;

  const resultSet = await this.clickhouse.query({
    query,
    query_params: { ids },
    format: "JSONEachRow",
  });

  const existingIds = new Set(
    (await resultSet.json<{ id: string }>()).map((row) => row.id)
  );

  const duplicateCount = existingIds.size;
  this.stats.duplicateEvents += duplicateCount;

  return events.filter((event) => !existingIds.has(event.id));
}
```

**What it does:**
- Queries ClickHouse for each batch to check if events already exist
- Filters out events that are already in the database
- Only runs when `--skip-duplicates` flag is used

**Performance impact:**
- ⚠️ Adds a SELECT query for every batch (default 5000 events)
- ⚠️ Slower import speed due to database lookups
- ✅ Prevents duplicate data in the database

**Usage:**
```bash
# Safe import with duplicate checking
deno task import events.jsonl --skip-duplicates

# Fast import without duplicate checking (default)
deno task import events.jsonl
```

## Live Relay Duplicate Handling

The live relay system (`src/relay-worker.ts` + `src/storage-worker.ts`) has **NO duplicate detection**:

### Relay Worker Flow:
```typescript
async function handleEvent(connId: string, event: NostrEvent): Promise<void> {
  // 1. Validate event signature
  if (!await verifyNostrEvent(event)) {
    await sendResponse(connId, ["OK", event.id, false, "invalid: event validation failed"]);
    return;
  }

  // 2. Check size limit
  if (JSON.stringify(event).length > 500000) {
    await sendResponse(connId, ["OK", event.id, false, "rejected: event too large"]);
    return;
  }

  // 3. Queue event for storage (NO duplicate check)
  await redis.lPush("nostr:events:queue", JSON.stringify(event));
  await sendResponse(connId, ["OK", event.id, true, ""]);

  // 4. Broadcast to subscribers
  await broadcastEvent(event);
}
```

### Storage Worker Flow:
```typescript
async function insertBatch(events: NostrEvent[]) {
  // Direct insert with NO duplicate checking
  await clickhouse.insert({
    table: "nostr_events",
    values: events.map((event) => ({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })),
    format: "JSONEachRow",
  });
}
```

**Result:**
- ⚠️ If a client sends the same event twice, it will be stored twice
- ⚠️ If multiple clients send the same event, it will be stored multiple times
- ✅ Maximum throughput - no database lookups on insert
- ✅ Optimized for write performance

## Implications

### 1. **Data Duplication Can Occur**
- Events can be duplicated if:
  - Importing the same file multiple times without `--skip-duplicates`
  - Clients reconnect and re-send events
  - Multiple relays forward the same event
  - Network retries cause duplicate submissions

### 2. **Query Results May Contain Duplicates**
When querying events, you may get the same event multiple times:

```typescript
const events = await queryEvents({ kinds: [1], limit: 100 });
// May contain duplicate event IDs!
```

### 3. **Storage Overhead**
- Duplicate events consume disk space
- Queries may be slower due to processing duplicates
- Bandwidth wasted sending duplicate events to clients

## Recommended Solutions

### Option 1: Add UNIQUE Constraint (Breaking Change)

Modify the schema to use ReplacingMergeTree:

```sql
CREATE TABLE nostr_events (
  id String,
  pubkey String,
  created_at UInt32,
  kind UInt32,
  tags Array(Array(String)),
  content String,
  sig String,
  event_date Date MATERIALIZED toDate(toDateTime(created_at))
) ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (id, kind, created_at)
```

**Pros:**
- Automatic deduplication during merge operations
- No application-level duplicate checking needed

**Cons:**
- Deduplication is not immediate (happens during background merges)
- Requires schema migration
- May still return duplicates in queries until merge completes

### Option 2: Add Duplicate Check to Relay Worker

Modify `relay-worker.ts` to check for duplicates before queuing:

```typescript
async function handleEvent(connId: string, event: NostrEvent): Promise<void> {
  // Validate event
  if (!await verifyNostrEvent(event)) {
    await sendResponse(connId, ["OK", event.id, false, "invalid: event validation failed"]);
    return;
  }

  // Check if event already exists
  const query = `SELECT id FROM nostr_events WHERE id = {id:String} LIMIT 1`;
  const result = await clickhouse.query({
    query,
    query_params: { id: event.id },
    format: "JSONEachRow",
  });
  const existing = await result.json();
  
  if (existing.length > 0) {
    await sendResponse(connId, ["OK", event.id, true, "duplicate: already have this event"]);
    return;
  }

  // Continue with normal flow...
}
```

**Pros:**
- Prevents duplicates at ingestion time
- Immediate feedback to clients

**Cons:**
- ⚠️ **Significant performance impact** - adds SELECT query for every event
- ⚠️ Reduces throughput from 10,000+ events/sec to ~1,000 events/sec
- May create bottleneck under high load

### Option 3: Use Redis Cache for Duplicate Detection

Use Redis to track recently seen event IDs:

```typescript
async function handleEvent(connId: string, event: NostrEvent): Promise<void> {
  // Check Redis cache first (fast)
  const exists = await redis.exists(`event:${event.id}`);
  if (exists) {
    await sendResponse(connId, ["OK", event.id, true, "duplicate: already have this event"]);
    return;
  }

  // Validate event
  if (!await verifyNostrEvent(event)) {
    await sendResponse(connId, ["OK", event.id, false, "invalid: event validation failed"]);
    return;
  }

  // Mark as seen in Redis with TTL (e.g., 24 hours)
  await redis.setEx(`event:${event.id}`, 86400, "1");

  // Queue event for storage
  await redis.lPush("nostr:events:queue", JSON.stringify(event));
  await sendResponse(connId, ["OK", event.id, true, ""]);
}
```

**Pros:**
- Fast duplicate detection (Redis is in-memory)
- Minimal performance impact
- Automatically expires old entries (TTL)

**Cons:**
- Not 100% accurate (cache can be cleared/expire)
- Requires additional Redis memory
- Duplicates can still occur if cache misses

### Option 4: Client-Side Deduplication

Add `DISTINCT` to queries:

```sql
SELECT DISTINCT id, pubkey, created_at, kind, tags, content, sig
FROM nostr_events
WHERE kind = 1
ORDER BY created_at DESC
LIMIT 100
```

**Pros:**
- No changes to ingestion pipeline
- Works with existing data

**Cons:**
- Slower queries (DISTINCT is expensive)
- Duplicates still stored (wasted space)
- Doesn't prevent duplicate ingestion

## Current Recommendation

**For most use cases:** Use **Option 3 (Redis Cache)** for live relay + `--skip-duplicates` for imports

This provides:
- ✅ Fast duplicate detection for live events
- ✅ Minimal performance impact
- ✅ Safe imports with explicit duplicate checking
- ✅ Backward compatible (no schema changes)

**For high-reliability systems:** Use **Option 1 (ReplacingMergeTree)** + **Option 3 (Redis Cache)**

This provides:
- ✅ Guaranteed eventual deduplication at database level
- ✅ Fast duplicate detection for live events
- ✅ Best of both worlds

## Summary Table

| Component | Duplicate Detection | Method | Performance Impact |
|-----------|-------------------|--------|-------------------|
| **Import Script** | In-memory (always) | `Set<string>` | Minimal |
| **Import Script** | Database (optional) | `--skip-duplicates` flag | High (slower imports) |
| **Relay Worker** | ❌ None | N/A | None |
| **Storage Worker** | ❌ None | N/A | None |
| **ClickHouse Schema** | ❌ None | No UNIQUE constraint | None |

**Bottom Line:** The system is optimized for **write performance** over **data integrity**. Duplicates are possible and expected unless you explicitly enable duplicate checking with `--skip-duplicates` during imports.
