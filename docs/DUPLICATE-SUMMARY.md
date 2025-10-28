# Duplicate Handling - Quick Summary

## TL;DR

**The system does NOT prevent duplicates by default.** The same event can be stored multiple times in ClickHouse.

## Current State

```
┌─────────────────────────────────────────────────────────────┐
│                    IMPORT SCRIPT                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ In-Memory Deduplication (Always Active)                 │
│     - Prevents duplicates within single import run          │
│     - Does NOT check database                               │
│                                                              │
│  ⚙️  Database Deduplication (Optional)                      │
│     - Flag: --skip-duplicates                               │
│     - Checks ClickHouse before inserting                    │
│     - ⚠️  Slower imports                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    LIVE RELAY                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ❌ NO Duplicate Detection                                  │
│     - Events inserted directly                              │
│     - Maximum performance                                   │
│     - Duplicates WILL occur if:                             │
│       • Client resends same event                           │
│       • Multiple clients send same event                    │
│       • Network retries                                     │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    CLICKHOUSE                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ❌ NO UNIQUE Constraint                                    │
│  ❌ NO PRIMARY KEY                                          │
│  ⚠️  Same event ID can exist multiple times                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## What This Means

### ✅ Advantages
- **Maximum write performance** (~10,000+ events/sec)
- **No bottlenecks** from duplicate checking
- **Simple architecture** - no complex deduplication logic

### ⚠️ Disadvantages
- **Data duplication** - same events stored multiple times
- **Wasted storage** - duplicates consume disk space
- **Slower queries** - may need DISTINCT or deduplication
- **Bandwidth waste** - may send duplicate events to clients

## Common Scenarios

### Scenario 1: Importing the Same File Twice

```bash
# First import
deno task import events.jsonl
# Result: 1,000,000 events inserted

# Second import (same file)
deno task import events.jsonl
# Result: 1,000,000 MORE events inserted (duplicates!)

# Total in database: 2,000,000 events (1M duplicates)
```

**Solution:** Use `--skip-duplicates` flag
```bash
deno task import events.jsonl --skip-duplicates
# Result: 0 events inserted (all already exist)
```

### Scenario 2: Client Reconnects and Resends Events

```
Client connects → Sends event A → Disconnect
Client reconnects → Sends event A again
```

**Result:** Event A stored twice in database

**Solution:** Implement Redis cache (see Option 3 in DUPLICATE-HANDLING.md)

### Scenario 3: Multiple Relays Forward Same Event

```
Relay 1 → Sends event X → Your relay
Relay 2 → Sends event X → Your relay
```

**Result:** Event X stored twice in database

**Solution:** Implement duplicate detection in relay-worker

## Quick Fixes

### For Imports: Always Use `--skip-duplicates`

```bash
# Safe import (recommended)
deno task import events.jsonl --skip-duplicates

# Unsafe import (fast but creates duplicates)
deno task import events.jsonl
```

### For Live Relay: Add Redis Cache Check

Add this to `src/relay-worker.ts`:

```typescript
// Before queuing event
const cacheKey = `seen:${event.id}`;
const exists = await redis.exists(cacheKey);

if (exists) {
  await sendResponse(connId, ["OK", event.id, true, "duplicate: already have this event"]);
  return;
}

// Mark as seen (expires in 24 hours)
await redis.setEx(cacheKey, 86400, "1");
```

### For Queries: Use DISTINCT

```sql
-- Without DISTINCT (may return duplicates)
SELECT * FROM nostr_events WHERE kind = 1 LIMIT 100

-- With DISTINCT (no duplicates, but slower)
SELECT DISTINCT * FROM nostr_events WHERE kind = 1 LIMIT 100
```

## Performance Impact

| Method | Write Speed | Duplicate Prevention | Complexity |
|--------|------------|---------------------|------------|
| **Current (no checking)** | 🚀 10,000+ events/sec | ❌ None | ✅ Simple |
| **Import with --skip-duplicates** | 🐌 1,000-2,000 events/sec | ✅ 100% for imports | ✅ Simple |
| **Redis cache** | 🚀 8,000-9,000 events/sec | ⚠️ ~99% (cache can miss) | ⚙️ Medium |
| **Database check** | 🐌 500-1,000 events/sec | ✅ 100% | ⚙️ Medium |
| **ReplacingMergeTree** | 🚀 10,000+ events/sec | ✅ Eventual (not immediate) | 🔧 Complex |

## Recommended Actions

### Short Term (No Code Changes)
1. **Always use `--skip-duplicates` when importing**
2. **Run deduplication query periodically:**
   ```sql
   OPTIMIZE TABLE nostr_events FINAL DEDUPLICATE BY id
   ```

### Medium Term (Add Redis Cache)
1. Implement Redis cache in relay-worker (1-2 hours of work)
2. Prevents ~99% of duplicates with minimal performance impact
3. See Option 3 in `docs/DUPLICATE-HANDLING.md`

### Long Term (Schema Change)
1. Migrate to ReplacingMergeTree engine
2. Automatic deduplication during merges
3. Requires downtime and data migration
4. See Option 1 in `docs/DUPLICATE-HANDLING.md`

## Questions?

See the full documentation: `docs/DUPLICATE-HANDLING.md`
