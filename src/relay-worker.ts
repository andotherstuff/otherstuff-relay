/**
 * Relay worker process that processes Nostr relay messages from Redis queue
 * Handles validation, database operations, and sends responses back via Redis
 */
import { NSchema as n } from "@nostrify/nostrify";
import { setNostrWasm, verifyEvent } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import { getMetricsInstance, initializeMetrics } from "./metrics.ts";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const config = new Config(Deno.env);

// ClickHouse client
const clickhouse = createClient({
  url: config.databaseUrl,
});

// Redis client
const redis = createRedisClient({
  url: config.redisUrl,
});
await redis.connect();

// Initialize metrics with Redis client
initializeMetrics(redis);

// Get metrics instance for use in this module
const metrics = getMetricsInstance();

// Initialize WASM for event verification
const wasmInitialized = (async () => {
  const wasm = await initNostrWasm();
  setNostrWasm(wasm);
})();

const WORKER_ID = crypto.randomUUID().slice(0, 8);
console.log(`🔧 Relay worker ${WORKER_ID} started, waiting for messages...`);

// In-memory subscription storage (shared across workers via Redis)
// Each worker maintains its own view but publishes updates to Redis
type Subscription = {
  connId: string;
  subId: string;
  filters: NostrFilter[];
};

const subscriptions = new Map<string, Subscription>();

// Reverse indexes are stored in Redis so all workers can access them
// Redis key patterns:
// - nostr:index:kind:{kind} -> Set of subscription keys
// - nostr:index:author:{pubkey} -> Set of subscription keys
// - nostr:index:tag:{tagName}:{tagValue} -> Set of subscription keys
// - nostr:index:id:{eventId} -> Set of subscription keys
// - nostr:index:catchall -> Set of subscription keys with no filters

async function verifyNostrEvent(event: NostrEvent): Promise<boolean> {
  await wasmInitialized;
  return verifyEvent(event);
}

/**
 * Add a subscription to the reverse indexes in Redis
 */
async function addToIndexes(
  key: string,
  filters: NostrFilter[],
): Promise<void> {
  let hasSpecificFilter = false;
  const pipeline = redis.multi();

  for (const filter of filters) {
    // Index by kind
    if (filter.kinds && filter.kinds.length > 0) {
      hasSpecificFilter = true;
      for (const kind of filter.kinds) {
        pipeline.sAdd(`nostr:index:kind:${kind}`, key);
      }
    }

    // Index by author
    if (filter.authors && filter.authors.length > 0) {
      hasSpecificFilter = true;
      for (const author of filter.authors) {
        pipeline.sAdd(`nostr:index:author:${author}`, key);
      }
    }

    // Index by tags
    for (const [filterKey, values] of Object.entries(filter)) {
      if (
        filterKey.startsWith("#") && Array.isArray(values) && values.length > 0
      ) {
        hasSpecificFilter = true;
        const tagName = filterKey.substring(1);
        for (const value of values) {
          pipeline.sAdd(`nostr:index:tag:${tagName}:${value}`, key);
        }
      }
    }

    // Index by IDpipeline
    if (filter.ids && filter.ids.length > 0) {
      hasSpecificFilter = true;
      for (const id of filter.ids) {
        pipeline.sAdd(`nostr:index:id:${id}`, key);
      }
    }
  }

  // If no specific filters, add to catch-all (matches everything)
  if (!hasSpecificFilter) {
    pipeline.sAdd("nostr:index:catchall", key);
  }

  await pipeline.exec();
}

/**
 * Remove a subscription from all reverse indexes in Redis
 *
 * Since we don't know which exact indexes this subscription is in,
 * we need to reconstruct them from the subscription's filters
 */
async function removeFromIndexes(key: string): Promise<void> {
  const sub = subscriptions.get(key);
  if (!sub) return;

  const pipeline = redis.multi();
  let hasSpecificFilter = false;

  for (const filter of sub.filters) {
    // Remove from kind indexes
    if (filter.kinds && filter.kinds.length > 0) {
      hasSpecificFilter = true;
      for (const kind of filter.kinds) {
        pipeline.sRem(`nostr:index:kind:${kind}`, key);
      }
    }

    // Remove from author indexes
    if (filter.authors && filter.authors.length > 0) {
      hasSpecificFilter = true;
      for (const author of filter.authors) {
        pipeline.sRem(`nostr:index:author:${author}`, key);
      }
    }

    // Remove from tag indexes
    for (const [filterKey, values] of Object.entries(filter)) {
      if (
        filterKey.startsWith("#") && Array.isArray(values) && values.length > 0
      ) {
        hasSpecificFilter = true;
        const tagName = filterKey.substring(1);
        for (const value of values) {
          pipeline.sRem(`nostr:index:tag:${tagName}:${value}`, key);
        }
      }
    }

    // Remove from ID indexes
    if (filter.ids && filter.ids.length > 0) {
      hasSpecificFilter = true;
      for (const id of filter.ids) {
        pipeline.sRem(`nostr:index:id:${id}`, key);
      }
    }
  }

  // Remove from catch-all if it was there
  if (!hasSpecificFilter) {
    pipeline.sRem("nostr:index:catchall", key);
  }

  await pipeline.exec();
}

/**
 * Find all subscription keys that might match an event using reverse indexes from Redis
 *
 * This is a HUGE performance improvement over the naive approach:
 * - OLD: O(total_subscriptions) - check every single subscription
 * - NEW: O(matching_subscriptions) - only check subscriptions that have relevant filters
 *
 * Example: With 10,000 subscriptions and an event of kind:1 from a specific author:
 * - OLD: Check all 10,000 subscriptions
 * - NEW: Check only ~50 subscriptions that filter for kind:1 or that author
 *
 * This is a 200x improvement in typical cases!
 *
 * Uses Redis SUNION to efficiently combine multiple index sets
 */
async function findCandidateSubscriptions(
  event: NostrEvent,
): Promise<string[]> {
  // Build list of Redis keys to check
  const redisKeys: string[] = [];

  // Add kind index
  redisKeys.push(`nostr:index:kind:${event.kind}`);

  // Add author index
  redisKeys.push(`nostr:index:author:${event.pubkey}`);

  // Add tag indexes
  for (const tag of event.tags) {
    if (tag.length >= 2) {
      redisKeys.push(`nostr:index:tag:${tag[0]}:${tag[1]}`);
    }
  }

  // Add ID index
  redisKeys.push(`nostr:index:id:${event.id}`);

  // Add catch-all subscriptions
  redisKeys.push("nostr:index:catchall");

  // Use SUNION to get all unique subscription keys across all indexes
  // This is much more efficient than fetching each set separately
  const candidates = await redis.sUnion(redisKeys);

  return candidates;
}

async function queryEvents(filter: NostrFilter): Promise<NostrEvent[]> {
  // If limit is 0, skip the query (realtime-only subscription)
  if (filter.limit === 0) {
    return [];
  }

  // Default to 500, cap at 5000
  const limit = Math.min(filter.limit || 500, 5000);

  // Extract tag filters
  const tagFilters: Array<{ name: string; values: string[] }> = [];
  const nonTagFilter: NostrFilter = {};

  // Copy non-tag filters
  if (filter.ids) nonTagFilter.ids = filter.ids;
  if (filter.authors) nonTagFilter.authors = filter.authors;
  if (filter.kinds) nonTagFilter.kinds = filter.kinds;
  if (filter.since) nonTagFilter.since = filter.since;
  if (filter.until) nonTagFilter.until = filter.until;
  if (filter.limit) nonTagFilter.limit = filter.limit;
  if (filter.search) nonTagFilter.search = filter.search;

  // Extract tag filters
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
      const tagName = key.substring(1);
      tagFilters.push({ name: tagName, values });
    }
  }

  // If we have tag filters, use the flattened tag view for better performance
  if (tagFilters.length > 0) {
    return await queryEventsWithTags(filter, tagFilters, limit);
  }

  // For non-tag queries, use the main table
  return await queryEventsSimple(nonTagFilter, limit);
}

async function queryEventsSimple(
  filter: NostrFilter,
  limit: number,
): Promise<NostrEvent[]> {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.ids && filter.ids.length > 0) {
    conditions.push(`id IN ({ids:Array(String)})`);
    params.ids = filter.ids;
  }

  if (filter.authors && filter.authors.length > 0) {
    conditions.push(`pubkey IN ({authors:Array(String)})`);
    params.authors = filter.authors;
  }

  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(`kind IN ({kinds:Array(UInt16)})`);
    params.kinds = filter.kinds;
  }

  if (filter.since) {
    conditions.push(`created_at >= {since:UInt32}`);
    params.since = filter.since;
  }

  if (filter.until) {
    conditions.push(`created_at <= {until:UInt32}`);
    params.until = filter.until;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  params.limit = limit;

  const query = `
    SELECT
      id,
      pubkey,
      created_at,
      kind,
      tags,
      content,
      sig
    FROM events_local
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT {limit:UInt32}
  `;

  const resultSet = await clickhouse.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });

  const data = await resultSet.json<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  }>();

  return data.map((row) => ({
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: row.tags,
    content: row.content,
    sig: row.sig,
  }));
}

async function queryEventsWithTags(
  filter: NostrFilter,
  tagFilters: Array<{ name: string; values: string[] }>,
  limit: number,
): Promise<NostrEvent[]> {
  // Build conditions for tag filters using flattened table
  const tagConditions: string[] = [];
  const params: Record<string, unknown> = {};

  for (let i = 0; i < tagFilters.length; i++) {
    const { name, values } = tagFilters[i];
    const paramName = `tag_values_${i}`;
    const tagNameParam = `tag_name_${i}`;

    tagConditions.push(
      `tag_name = {${tagNameParam}:String} AND tag_value_1 IN ({${paramName}:Array(String)})`,
    );
    params[paramName] = values;
    params[tagNameParam] = name;
  }

  const tagWhereClause = tagConditions.join(" OR ");

  // Build additional conditions
  const otherConditions: string[] = [];

  if (filter.authors && filter.authors.length > 0) {
    otherConditions.push(`pubkey IN ({authors:Array(String)})`);
    params.authors = filter.authors;
  }

  if (filter.kinds && filter.kinds.length > 0) {
    otherConditions.push(`kind IN ({kinds:Array(UInt16)})`);
    params.kinds = filter.kinds;
  }

  if (filter.since) {
    otherConditions.push(`created_at >= {since:DateTime}`);
    params.since = new Date(filter.since * 1000);
  }

  if (filter.until) {
    otherConditions.push(`created_at <= {until:DateTime}`);
    params.until = new Date(filter.until * 1000);
  }

  const allConditions = [tagWhereClause, ...otherConditions];
  const whereClause = `WHERE ${allConditions.join(" AND ")}`;

  params.limit = limit;

  // Query using the flattened tag view with JOIN to main table
  const query = `
    SELECT DISTINCT
      e.id,
      e.pubkey,
      toUnixTimestamp(e.created_at) as created_at,
      e.kind,
      e.tags,
      e.content,
      e.sig
    FROM events_local e
    INNER JOIN (
      SELECT DISTINCT event_id, created_at
      FROM event_tags_flat
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32}
    ) t ON e.id = t.event_id
    ORDER BY e.created_at DESC
    LIMIT {limit:UInt32}
  `;

  const resultSet = await clickhouse.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });

  const data = await resultSet.json<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  }>();

  return data.map((row) => ({
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: row.tags,
    content: row.content,
    sig: row.sig,
  }));
}

async function handleEvent(
  connId: string,
  event: NostrEvent,
): Promise<void> {
  // Increment events received counter
  await metrics.incrementEventsReceived();

  // Increment events by kind counter
  await metrics.incrementEventByKind(event.kind);

  // Validate event
  if (!await verifyNostrEvent(event)) {
    await metrics.incrementEventsInvalid();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "invalid: event validation failed",
    ]);
    return;
  }

  if (JSON.stringify(event).length > 500000) {
    await metrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "rejected: event too large",
    ]);
    return;
  }

  // Check if event is ephemeral (kind 20000 <= k < 30000)
  const isEphemeral = event.kind >= 20000 && event.kind < 30000;

  // Check if event is too old to broadcast
  const now = Math.floor(Date.now() / 1000);
  const eventAge = now - event.created_at;
  const isTooOld = eventAge > config.broadcastMaxAge;

  // Ephemeral events that are too old should be rejected
  if (isEphemeral && isTooOld) {
    await metrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      `rejected: ephemeral event too old (${eventAge}s old, max: ${config.broadcastMaxAge}s)`,
    ]);
    return;
  }

  try {
    // Only store non-ephemeral events in the database
    if (!isEphemeral) {
      await redis.lPush("nostr:events:queue", JSON.stringify(event));
    }

    await sendResponse(connId, ["OK", event.id, true, ""]);

    // Broadcast to subscribers (will be skipped if too old)
    await broadcastEvent(event);
  } catch (error) {
    console.error("Failed to queue event:", error);
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "error: failed to queue event",
    ]);
  }
}

async function handleReq(
  connId: string,
  subId: string,
  filters: NostrFilter[],
): Promise<void> {
  // Increment queries counter
  await metrics.incrementQueriesTotal();

  // Limit filters per subscription
  if (filters.length > 10) {
    filters = filters.slice(0, 10);
  }

  // Store subscription
  const key = `${connId}:${subId}`;
  subscriptions.set(key, { connId, subId, filters });

  // Add to reverse indexes for fast event matching
  addToIndexes(key, filters);

  // Also store in Redis for subscription tracking across workers
  await redis.hSet(`nostr:subs:${connId}`, subId, JSON.stringify(filters));

  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await metrics.setSubscriptions(totalSubs);

  // Query historical events for each filter
  const queryPromises = filters.map(async (filter) => {
    try {
      const events = await queryEvents(filter);
      for (const event of events) {
        await sendResponse(connId, ["EVENT", subId, event]);
      }
      return events.length;
    } catch (error) {
      console.error("Query failed for filter:", filter, error);
      return 0;
    }
  });

  try {
    await Promise.race([
      Promise.all(queryPromises),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Query timeout")), 10000)
      ),
    ]);
  } catch (error) {
    console.error("Query timeout or error:", error);
  }

  // Send EOSE
  await sendResponse(connId, ["EOSE", subId]);
}

async function handleClose(connId: string, subId: string): Promise<void> {
  const key = `${connId}:${subId}`;

  // Remove from reverse indexes
  removeFromIndexes(key);

  subscriptions.delete(key);
  await redis.hDel(`nostr:subs:${connId}`, subId);

  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await metrics.setSubscriptions(totalSubs);
}

async function handleDisconnect(connId: string): Promise<void> {
  // Remove all subscriptions for this connection
  const toDelete: string[] = [];
  for (const [key, sub] of subscriptions.entries()) {
    if (sub.connId === connId) {
      toDelete.push(key);
    }
  }

  for (const key of toDelete) {
    // Remove from reverse indexes
    removeFromIndexes(key);
    subscriptions.delete(key);
  }

  // Remove from Redis
  await redis.del(`nostr:subs:${connId}`);

  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await metrics.setSubscriptions(totalSubs);
}

// Helper function to count total subscriptions across all connections
async function countTotalSubscriptions(): Promise<number> {
  const keys = await redis.keys("nostr:subs:*");
  let total = 0;

  for (const key of keys) {
    const subCount = await redis.hLen(key);
    total += subCount;
  }

  return total;
}

async function broadcastEvent(event: NostrEvent): Promise<void> {
  // Skip broadcasting events that are too old (not relevant for realtime subscriptions)
  const now = Math.floor(Date.now() / 1000);
  const eventAge = now - event.created_at;

  if (eventAge > config.broadcastMaxAge) {
    // Event is too old, don't broadcast to realtime subscriptions
    return;
  }

  // Use reverse indexes from Redis to find candidate subscriptions across ALL workers
  const candidateKeys = await findCandidateSubscriptions(event);

  let matchCount = 0;
  let localChecks = 0;

  // For each candidate, check if we need to send it
  // Note: Each worker only processes subscriptions it knows about (in its local memory)
  for (const key of candidateKeys) {
    const sub = subscriptions.get(key);
    if (!sub) {
      // This subscription belongs to another worker, skip it
      continue;
    }

    localChecks++;

    // Check if event matches any filter in this subscription
    const matches = sub.filters.some((filter) => matchesFilter(event, filter));

    if (matches) {
      matchCount++;
      await sendResponse(sub.connId, ["EVENT", sub.subId, event]);
    }
  }

  // Log performance stats occasionally (every 1000 events)
  if (Math.random() < 0.001) {
    console.log(
      `📊 [${WORKER_ID}] Index: ${candidateKeys.length} candidates, ${localChecks} local checks, ${matchCount} matches`,
    );
  }
}

function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) {
    return false;
  }

  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }

  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }

  if (filter.since && event.created_at < filter.since) {
    return false;
  }

  if (filter.until && event.created_at > filter.until) {
    return false;
  }

  // Check tag filters
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && Array.isArray(values)) {
      const tagName = key.substring(1);
      const hasMatch = event.tags.some((tag) =>
        tag[0] === tagName && values.includes(tag[1])
      );
      if (!hasMatch) {
        return false;
      }
    }
  }

  return true;
}

// deno-lint-ignore no-explicit-any
async function sendResponse(connId: string, msg: any): Promise<void> {
  const response = {
    connId,
    msg,
  };
  await redis.rPush(`nostr:responses:${connId}`, JSON.stringify(response));
}

// Main processing loop
async function processMessages() {
  while (true) {
    try {
      // Block and wait for a message (BRPOP with 1 second timeout)
      const result = await redis.brPop("nostr:relay:queue", 1);

      if (result) {
        const messageData = JSON.parse(result.element);
        const { connId, msg } = messageData;

        try {
          // Try to parse as standard Nostr message
          let parsed;
          try {
            parsed = n.json().pipe(n.clientMsg()).parse(msg);
          } catch {
            // Check if it's our internal DISCONNECT message
            const msgArray = JSON.parse(msg);
            if (Array.isArray(msgArray) && msgArray[0] === "DISCONNECT") {
              await handleDisconnect(connId);
              continue;
            }
            throw new Error("Invalid message format");
          }

          switch (parsed[0]) {
            case "EVENT": {
              const event = parsed[1];
              await handleEvent(connId, event);
              break;
            }

            case "REQ": {
              const [_, subId, ...filters] = parsed;
              await handleReq(connId, subId, filters);
              break;
            }

            case "CLOSE": {
              const [_, subId] = parsed;
              await handleClose(connId, subId);
              break;
            }

            default:
              await sendResponse(connId, ["NOTICE", "unknown command"]);
          }
        } catch (err) {
          console.error("Message processing error:", err);
          await sendResponse(connId, ["NOTICE", "invalid message"]);
        }
      }
    } catch (error) {
      console.error("Error in message processing loop:", error);
      // Wait a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Graceful shutdown
const shutdown = async () => {
  console.log(`Shutting down relay worker ${WORKER_ID}...`);
  subscriptions.clear();
  await redis.quit();
  await clickhouse.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Start processing
processMessages();
