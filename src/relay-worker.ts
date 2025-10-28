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
import { RedisMetrics, initializeMetrics } from "./metrics.ts";
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

async function verifyNostrEvent(event: NostrEvent): Promise<boolean> {
  await wasmInitialized;
  return verifyEvent(event);
}

async function queryEvents(filter: NostrFilter): Promise<NostrEvent[]> {
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
    conditions.push(`kind IN ({kinds:Array(UInt32)})`);
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

  // Handle tag filters (#e, #p, etc.)
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
      const tagName = key.substring(1);
      const paramName = `tag_${tagName}`;
      const tagNameParam = `tagname_${tagName}`;
      conditions.push(
        `arrayExists(tag -> tag[1] = {${tagNameParam}:String} AND has(({${paramName}:Array(String)}), tag[2]), tags)`,
      );
      params[paramName] = values;
      params[tagNameParam] = tagName;
    }
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const limit = Math.min(filter.limit || 500, 5000);
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
    FROM nostr_events
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

async function handleEvent(
  connId: string,
  event: NostrEvent,
): Promise<void> {
  // Increment events received counter
  await RedisMetrics.incrementEventsReceived();
  
  // Increment events by kind counter
  await RedisMetrics.incrementEventByKind(event.kind);
  
  // Validate event
  if (!await verifyNostrEvent(event)) {
    await RedisMetrics.incrementEventsInvalid();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "invalid: event validation failed",
    ]);
    return;
  }

  if (JSON.stringify(event).length > 500000) {
    await RedisMetrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "rejected: event too large",
    ]);
    return;
  }

  try {
    // Push event to storage queue for batch processing by storage worker
    await redis.lPush("nostr:events:queue", JSON.stringify(event));
    await sendResponse(connId, ["OK", event.id, true, ""]);

    // Broadcast to subscribers
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
  await RedisMetrics.incrementQueriesTotal();
  
  // Limit filters per subscription
  if (filters.length > 10) {
    filters = filters.slice(0, 10);
  }

  // Store subscription
  const key = `${connId}:${subId}`;
  subscriptions.set(key, { connId, subId, filters });

  // Also store in Redis for subscription tracking across workers
  await redis.hSet(`nostr:subs:${connId}`, subId, JSON.stringify(filters));
  
  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await RedisMetrics.setSubscriptions(totalSubs);

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
  subscriptions.delete(key);
  await redis.hDel(`nostr:subs:${connId}`, subId);
  
  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await RedisMetrics.setSubscriptions(totalSubs);
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
    subscriptions.delete(key);
  }

  // Remove from Redis
  await redis.del(`nostr:subs:${connId}`);
  
  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await RedisMetrics.setSubscriptions(totalSubs);
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
  // Get all active connections
  const connIds = await redis.keys("nostr:subs:*");

  for (const key of connIds) {
    const connId = key.replace("nostr:subs:", "");
    const subs = await redis.hGetAll(key);

    for (const [subId, filtersJson] of Object.entries(subs)) {
      try {
        if (typeof filtersJson !== "string") continue;
        const filters = JSON.parse(filtersJson) as NostrFilter[];

        // Check if event matches any filter
        if (filters.some((filter) => matchesFilter(event, filter))) {
          await sendResponse(connId, ["EVENT", subId, event]);
        }
      } catch (error) {
        console.error("Error broadcasting to subscription:", error);
      }
    }
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
  await redis.lPush(`nostr:responses:${connId}`, JSON.stringify(response));
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
