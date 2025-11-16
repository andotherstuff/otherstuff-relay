/**
 * Relay worker process that bridges Redis queues with OpenSearchRelay
 * Handles message routing, subscription state, and response delivery
 */
import { NSchema as n } from "@nostrify/nostrify";
import { getFilterLimit, matchFilters } from "nostr-tools";
import { setNostrWasm, verifyEvent } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";
import { Client } from "@opensearch-project/opensearch";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import { getMetricsInstance, initializeMetrics } from "./metrics.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type {
  NostrEvent,
  NostrFilter,
  NostrRelayMsg,
} from "@nostrify/nostrify";

const config = new Config(Deno.env);

// OpenSearch client
interface OpenSearchConfig {
  node: string;
  auth?: {
    username: string;
    password: string;
  };
}

const opensearchConfig: OpenSearchConfig = {
  node: config.opensearchUrl,
};

// Add authentication if provided
if (config.opensearchUsername && config.opensearchPassword) {
  opensearchConfig.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}

const opensearch = new Client(opensearchConfig);

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

// Initialize OpenSearchRelay
const relay = new OpenSearchRelay(opensearch);

const WORKER_ID = crypto.randomUUID().slice(0, 8);
console.log(`🔧 Relay worker ${WORKER_ID} started, waiting for messages...`);

// Lua script for atomic check-and-increment with limit
// Returns: [should_send (0 or 1), new_count, limit_reached (0 or 1)]
const CHECK_AND_INCREMENT_SCRIPT = `
  local counts_key = KEYS[1]
  local limits_key = KEYS[2]
  local sub_id = ARGV[1]
  
  local count = tonumber(redis.call('HGET', counts_key, sub_id) or '0')
  local limit = tonumber(redis.call('HGET', limits_key, sub_id) or '0')
  
  -- If no limit (0), always send
  if limit == 0 then
    local new_count = redis.call('HINCRBY', counts_key, sub_id, 1)
    return {1, new_count, 0}
  end
  
  -- If already at or over limit, don't send
  if count >= limit then
    return {0, count, 1}
  end
  
  -- Increment and check if we just reached the limit
  local new_count = redis.call('HINCRBY', counts_key, sub_id, 1)
  local limit_reached = (new_count >= limit) and 1 or 0
  
  return {1, new_count, limit_reached}
`;

// Helper function to check if an event is ephemeral
function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

// Helper function to check if an event is too old to broadcast
function isEventTooOld(event: NostrEvent): boolean {
  if (config.broadcastMaxAge === 0) {
    return false; // Age filtering disabled
  }

  const now = Math.floor(Date.now() / 1000);
  const eventAge = now - event.created_at;
  return eventAge > config.broadcastMaxAge;
}

// Helper function to get the effective limit for a set of filters
// Returns the maximum limit of all filters, or undefined if no limit
function getEffectiveLimit(filters: NostrFilter[]): number | undefined {
  const limit = filters.reduce(
    (result, filter) => result + getFilterLimit(filter),
    0,
  );

  return limit === Infinity ? undefined : limit;
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
  await wasmInitialized;
  if (!verifyEvent(event)) {
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

  // Check if event is ephemeral
  const ephemeral = isEphemeral(event.kind);
  const tooOld = isEventTooOld(event);

  // Reject ephemeral events that are too old
  if (ephemeral && tooOld) {
    await metrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "rejected: event too old",
    ]);
    return;
  }

  try {
    // Only store non-ephemeral events
    // Ephemeral events are only broadcast, never stored
    if (!ephemeral) {
      await redis.lPush("nostr:events:queue", JSON.stringify(event));
    }

    await sendResponse(connId, ["OK", event.id, true, ""]);

    // Broadcast to subscribers (will be filtered if too old)
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

  // Store in Redis for subscription tracking across workers
  await redis.hSet(`nostr:conn:${connId}`, subId, JSON.stringify(filters));

  // Initialize event count for this subscription
  const effectiveLimit = getEffectiveLimit(filters);
  await redis.hSet(`nostr:sub:counts:${connId}`, subId, "0");

  // Store the limit for this subscription if it exists
  if (effectiveLimit !== undefined) {
    await redis.hSet(
      `nostr:sub:limits:${connId}`,
      subId,
      effectiveLimit.toString(),
    );
  }

  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await metrics.setSubscriptions(totalSubs);

  // Check if subscription was already fulfilled by realtime events
  // This can happen in the race condition where events come in before DB query
  const currentCount = parseInt(
    await redis.hGet(`nostr:sub:counts:${connId}`, subId) || "0",
  );
  const alreadyFulfilled = effectiveLimit !== undefined &&
    currentCount >= effectiveLimit;

  if (alreadyFulfilled) {
    // Subscription already fulfilled by realtime events, send EOSE immediately
    await sendResponse(connId, ["EOSE", subId]);
    return;
  }

  // Query historical events for each filter
  const queryPromises = filters.map(async (filter) => {
    try {
      const events = await relay.query([filter]);

      // Check if still needed before sending each event
      for (const event of events) {
        // Atomically check and increment (prevents race with broadcast events)
        const result = await redis.eval(
          CHECK_AND_INCREMENT_SCRIPT,
          {
            keys: [
              `nostr:sub:counts:${connId}`,
              `nostr:sub:limits:${connId}`,
            ],
            arguments: [subId],
          },
        ) as number[];

        const shouldSend = result[0] === 1;
        const limitReached = result[2] === 1;

        // If limit reached, stop sending database events
        if (!shouldSend) {
          break;
        }

        await sendResponse(connId, ["EVENT", subId, event]);

        // If we just reached the limit, we can stop
        if (limitReached) {
          break;
        }
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

  // Check if EOSE was already sent by realtime events reaching the limit
  const eoseSent = await redis.hGet(`nostr:sub:eose:${connId}`, subId);

  if (!eoseSent) {
    // Send EOSE only if it wasn't already sent
    await sendResponse(connId, ["EOSE", subId]);
    await redis.hSet(`nostr:sub:eose:${connId}`, subId, "1");
  }
}

async function handleClose(connId: string, subId: string): Promise<void> {
  await redis.hDel(`nostr:conn:${connId}`, subId);

  // Clean up tracking data for this subscription
  await redis.hDel(`nostr:sub:counts:${connId}`, subId);
  await redis.hDel(`nostr:sub:limits:${connId}`, subId);
  await redis.hDel(`nostr:sub:eose:${connId}`, subId);

  // Update subscription count
  const totalSubs = await countTotalSubscriptions();
  await metrics.setSubscriptions(totalSubs);
}

// Helper function to count total subscriptions across all connections
async function countTotalSubscriptions(): Promise<number> {
  const keys = await redis.keys("nostr:conn:*");
  let total = 0;

  for (const key of keys) {
    const subCount = await redis.hLen(key);
    total += subCount;
  }

  return total;
}

async function broadcastEvent(event: NostrEvent): Promise<void> {
  // Don't broadcast events that are too old
  if (isEventTooOld(event)) {
    return;
  }

  // Get all active connections
  const connIds = await redis.keys("nostr:conn:*");

  for (const key of connIds) {
    const connId = key.replace("nostr:conn:", "");
    const subs = await redis.hGetAll(key);

    for (const [subId, filtersJson] of Object.entries(subs)) {
      try {
        if (typeof filtersJson !== "string") continue;
        const filters = JSON.parse(filtersJson) as NostrFilter[];

        // Check if event matches any filter
        if (matchFilters(filters, event)) {
          // Atomically check count and increment (prevents race condition)
          const result = await redis.eval(
            CHECK_AND_INCREMENT_SCRIPT,
            {
              keys: [
                `nostr:sub:counts:${connId}`,
                `nostr:sub:limits:${connId}`,
              ],
              arguments: [subId],
            },
          ) as number[];

          const shouldSend = result[0] === 1;
          const limitReached = result[2] === 1;

          // Only send if we're under the limit
          if (shouldSend) {
            await sendResponse(connId, ["EVENT", subId, event]);

            // If we just reached the limit, send EOSE
            if (limitReached) {
              // Check if EOSE was already sent
              const eoseSent = await redis.hGet(
                `nostr:sub:eose:${connId}`,
                subId,
              );

              if (!eoseSent) {
                // Send EOSE immediately - subscription is fulfilled
                await sendResponse(connId, ["EOSE", subId]);
                await redis.hSet(`nostr:sub:eose:${connId}`, subId, "1");
              }
            }
          }
        }
      } catch (error) {
        console.error("Error broadcasting to subscription:", error);
      }
    }
  }
}

async function sendResponse(connId: string, msg: NostrRelayMsg): Promise<void> {
  const queueKey = `nostr:responses:${connId}`;

  // Push the response and set TTL atomically using pipeline
  // TTL of 5 seconds ensures orphaned queues get cleaned up
  // If the connection is still active, the server will reset this TTL
  // Note: We only store the message, not the connId - it's already in the queue key
  const pipeline = redis.multi();
  pipeline.rPush(queueKey, JSON.stringify(msg));
  pipeline.expire(queueKey, 5);
  await pipeline.exec();
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
          const parsed = n.json().pipe(n.clientMsg()).parse(msg);

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
  await redis.quit();
  await opensearch.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Start processing
processMessages();
