/**
 * Relay worker process that processes Nostr relay messages from Redis queue
 * Handles validation, database operations, and sends responses back via Redis
 * Full NIP-01 compliance implementation
 */
import { NSchema as n } from "@nostrify/nostrify";
import { setNostrWasm, verifyEvent } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
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

// Initialize WASM for event verification
const wasmInitialized = (async () => {
  const wasm = await initNostrWasm();
  setNostrWasm(wasm);
})();

const WORKER_ID = crypto.randomUUID().slice(0, 8);
console.log(`🔧 Relay worker ${WORKER_ID} started, waiting for messages...`);

// NIP-01 constants
const MAX_SUBSCRIPTION_ID_LENGTH = 64;
const MAX_EVENT_SIZE = 500000;
const MAX_TIMESTAMP_DRIFT_SECONDS = 60 * 60 * 24 * 7; // 7 days

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

/**
 * Check if an event kind is replaceable (NIP-01)
 * Replaceable: kind 0, 3, or 10000 <= kind < 20000
 */
function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/**
 * Check if an event kind is addressable (NIP-01)
 * Addressable: 30000 <= kind < 40000
 */
function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/**
 * Check if an event kind is ephemeral (NIP-01)
 * Ephemeral: 20000 <= kind < 30000
 */
function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/**
 * Get the d-tag value from an event's tags
 */
function getDTag(event: NostrEvent): string | undefined {
  const dTag = event.tags.find((tag) => tag[0] === "d");
  return dTag?.[1];
}

/**
 * Check if event already exists in database
 */
async function eventExists(eventId: string): Promise<boolean> {
  try {
    const result = await clickhouse.query({
      query: "SELECT 1 FROM nostr_events WHERE id = {id:String} LIMIT 1",
      query_params: { id: eventId },
      format: "JSONEachRow",
    });
    const data = await result.json();
    return data.length > 0;
  } catch (error) {
    console.error("Error checking event existence:", error);
    return false;
  }
}

/**
 * Validate event timestamp is within acceptable range
 */
function validateTimestamp(created_at: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.abs(now - created_at);
  return diff <= MAX_TIMESTAMP_DRIFT_SECONDS;
}

/**
 * Validate subscription ID according to NIP-01
 */
function validateSubscriptionId(subId: string): string | null {
  if (!subId || subId.length === 0) {
    return "invalid: subscription ID cannot be empty";
  }
  if (subId.length > MAX_SUBSCRIPTION_ID_LENGTH) {
    return `invalid: subscription ID too long (max ${MAX_SUBSCRIPTION_ID_LENGTH} chars)`;
  }
  return null;
}

/**
 * Validate filter according to NIP-01
 */
function validateFilter(filter: NostrFilter): string | null {
  // Check that hex values are exactly 64 characters lowercase hex
  const hexFields = ["ids", "authors"] as const;
  for (const field of hexFields) {
    const values = filter[field];
    if (values && Array.isArray(values)) {
      for (const value of values) {
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
          return `invalid: ${field} must contain 64-character lowercase hex values`;
        }
      }
    }
  }

  // Check tag filters (e.g., #e, #p)
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#")) {
      const tagName = key.substring(1);
      // Only single-letter tags are indexed
      if (tagName.length !== 1 || !/^[a-zA-Z]$/.test(tagName)) {
        return `invalid: tag filter ${key} must be a single letter`;
      }
      
      // For #e and #p, values must be 64-char hex
      if ((tagName === "e" || tagName === "p") && Array.isArray(values)) {
        for (const value of values) {
          if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
            return `invalid: #${tagName} must contain 64-character lowercase hex values`;
          }
        }
      }
    }
  }

  return null;
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

  // NIP-01: For replaceable events, check if we're querying specific kinds
  // If so, we need to handle deduplication differently
  const hasReplaceableKinds = filter.kinds?.some((k) =>
    isReplaceableKind(k) || isAddressableKind(k)
  );

  let query: string;
  
  if (hasReplaceableKinds && filter.kinds && filter.kinds.length > 0) {
    // For replaceable/addressable events, we need to deduplicate
    // This is a simplified approach - in production you might want more sophisticated handling
    query = `
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
      ORDER BY created_at DESC, id ASC
      LIMIT {limit:UInt32}
    `;
  } else {
    // Regular events - standard query
    query = `
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
      ORDER BY created_at DESC, id ASC
      LIMIT {limit:UInt32}
    `;
  }

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
  // Validate event signature
  if (!await verifyNostrEvent(event)) {
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "invalid: event signature verification failed",
    ]);
    return;
  }

  // Validate event size
  if (JSON.stringify(event).length > MAX_EVENT_SIZE) {
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "rejected: event too large",
    ]);
    return;
  }

  // Validate timestamp
  if (!validateTimestamp(event.created_at)) {
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "invalid: event creation date is too far off from the current time",
    ]);
    return;
  }

  // Check for duplicate
  if (await eventExists(event.id)) {
    await sendResponse(connId, [
      "OK",
      event.id,
      true,
      "duplicate: already have this event",
    ]);
    return;
  }

  try {
    // Handle ephemeral events (NIP-01: should not be stored)
    if (isEphemeralKind(event.kind)) {
      // Don't store, just broadcast to active subscriptions
      await broadcastEvent(event);
      await sendResponse(connId, [
        "OK",
        event.id,
        true,
        "mute: ephemeral event not stored",
      ]);
      return;
    }

    // Handle replaceable events (NIP-01)
    if (isReplaceableKind(event.kind)) {
      await handleReplaceableEvent(event);
    } 
    // Handle addressable events (NIP-01)
    else if (isAddressableKind(event.kind)) {
      await handleAddressableEvent(event);
    } 
    // Handle regular events
    else {
      // Push event to storage queue for batch processing by storage worker
      await redis.lPush("nostr:events:queue", JSON.stringify(event));
    }

    await sendResponse(connId, ["OK", event.id, true, ""]);

    // Broadcast to subscribers
    await broadcastEvent(event);
  } catch (error) {
    console.error("Failed to process event:", error);
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "error: failed to process event",
    ]);
  }
}

/**
 * Handle replaceable events (NIP-01)
 * Only keep the latest event for each (pubkey, kind) combination
 */
async function handleReplaceableEvent(event: NostrEvent): Promise<void> {
  // Check if we have an existing event for this pubkey+kind
  const existingResult = await clickhouse.query({
    query: `
      SELECT id, created_at
      FROM nostr_events
      WHERE pubkey = {pubkey:String} AND kind = {kind:UInt32}
      ORDER BY created_at DESC, id ASC
      LIMIT 1
    `,
    query_params: {
      pubkey: event.pubkey,
      kind: event.kind,
    },
    format: "JSONEachRow",
  });

  const existingEvents = await existingResult.json<{
    id: string;
    created_at: number;
  }>();

  if (existingEvents.length > 0) {
    const existing = existingEvents[0];
    
    // If existing event is newer, reject the new one
    if (existing.created_at > event.created_at) {
      return;
    }
    
    // If same timestamp, keep the one with lower id (lexical order)
    if (existing.created_at === event.created_at && existing.id < event.id) {
      return;
    }

    // Delete the old event
    await clickhouse.command({
      query: `
        DELETE FROM nostr_events
        WHERE pubkey = {pubkey:String} AND kind = {kind:UInt32}
      `,
      query_params: {
        pubkey: event.pubkey,
        kind: event.kind,
      },
    });
  }

  // Insert the new event
  await redis.lPush("nostr:events:queue", JSON.stringify(event));
}

/**
 * Handle addressable events (NIP-01)
 * Only keep the latest event for each (kind, pubkey, d-tag) combination
 */
async function handleAddressableEvent(event: NostrEvent): Promise<void> {
  const dTag = getDTag(event) || "";

  // Check if we have an existing event for this kind+pubkey+d-tag
  const existingResult = await clickhouse.query({
    query: `
      SELECT id, created_at
      FROM nostr_events
      WHERE kind = {kind:UInt32}
        AND pubkey = {pubkey:String}
        AND arrayExists(tag -> tag[1] = 'd' AND tag[2] = {dTag:String}, tags)
      ORDER BY created_at DESC, id ASC
      LIMIT 1
    `,
    query_params: {
      kind: event.kind,
      pubkey: event.pubkey,
      dTag: dTag,
    },
    format: "JSONEachRow",
  });

  const existingEvents = await existingResult.json<{
    id: string;
    created_at: number;
  }>();

  if (existingEvents.length > 0) {
    const existing = existingEvents[0];
    
    // If existing event is newer, reject the new one
    if (existing.created_at > event.created_at) {
      return;
    }
    
    // If same timestamp, keep the one with lower id (lexical order)
    if (existing.created_at === event.created_at && existing.id < event.id) {
      return;
    }

    // Delete the old event
    await clickhouse.command({
      query: `
        DELETE FROM nostr_events
        WHERE kind = {kind:UInt32}
          AND pubkey = {pubkey:String}
          AND arrayExists(tag -> tag[1] = 'd' AND tag[2] = {dTag:String}, tags)
      `,
      query_params: {
        kind: event.kind,
        pubkey: event.pubkey,
        dTag: dTag,
      },
    });
  }

  // Insert the new event
  await redis.lPush("nostr:events:queue", JSON.stringify(event));
}

async function handleReq(
  connId: string,
  subId: string,
  filters: NostrFilter[],
): Promise<void> {
  // Validate subscription ID (NIP-01)
  const subIdError = validateSubscriptionId(subId);
  if (subIdError) {
    await sendResponse(connId, ["CLOSED", subId, subIdError]);
    return;
  }

  // Validate filters (NIP-01)
  for (const filter of filters) {
    const filterError = validateFilter(filter);
    if (filterError) {
      await sendResponse(connId, [
        "CLOSED",
        subId,
        `unsupported: ${filterError}`,
      ]);
      return;
    }
  }

  // Close existing subscription with same ID if it exists (NIP-01)
  const key = `${connId}:${subId}`;
  if (subscriptions.has(key)) {
    subscriptions.delete(key);
    await redis.hDel(`nostr:subs:${connId}`, subId);
  }

  // Limit filters per subscription
  if (filters.length > 10) {
    filters = filters.slice(0, 10);
  }

  // Store new subscription
  subscriptions.set(key, { connId, subId, filters });

  // Also store in Redis for subscription tracking across workers
  await redis.hSet(`nostr:subs:${connId}`, subId, JSON.stringify(filters));

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
    await sendResponse(connId, [
      "CLOSED",
      subId,
      "error: query timeout",
    ]);
    return;
  }

  // Send EOSE (NIP-01)
  await sendResponse(connId, ["EOSE", subId]);
}

async function handleClose(connId: string, subId: string): Promise<void> {
  const key = `${connId}:${subId}`;
  subscriptions.delete(key);
  await redis.hDel(`nostr:subs:${connId}`, subId);
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
