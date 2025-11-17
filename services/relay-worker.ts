/**
 * Relay worker process that bridges Redis queues with OpenSearchRelay
 * Handles message routing, subscription state, and response delivery
 */
import { NSchema as n } from "@nostrify/nostrify";
import { setNostrWasm, verifyEvent } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";
import { Client } from "@opensearch-project/opensearch";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import { Config } from "@/lib/config.ts";
import { getMetricsInstance, initializeMetrics } from "@/lib/metrics.ts";
import { OpenSearchRelay } from "@/lib/opensearch.ts";
import { RelayManagement } from "@/lib/management.ts";
import { PubSub } from "@/lib/pubsub.ts";
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
const redis: RedisClientType = createRedisClient({
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

// Initialize relay management with relay for ban enforcement
const management = new RelayManagement(redis, relay);

// Initialize PubSub for subscription management
const pubsub = new PubSub(redis);

const WORKER_ID = crypto.randomUUID().slice(0, 8);

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

async function handleEvent(
  connId: string,
  event: NostrEvent,
): Promise<void> {
  // Increment events received counter
  await metrics.incrementEventsReceived();

  // Increment events by kind counter
  await metrics.incrementEventByKind(event.kind);

  // NIP-86: Check if pubkey is banned
  if (await management.isPubkeyBanned(event.pubkey)) {
    await metrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "blocked: pubkey is banned",
    ]);
    return;
  }

  // NIP-86: Check if pubkey is in allowlist (if allowlist is configured)
  if (!(await management.isPubkeyAllowed(event.pubkey))) {
    await metrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "blocked: pubkey not in allowlist",
    ]);
    return;
  }

  // NIP-86: Check if event is banned
  if (await management.isEventBanned(event.id)) {
    await metrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "blocked: event is banned",
    ]);
    return;
  }

  // NIP-86: Check if kind is allowed (if allowlist is configured)
  if (!(await management.isKindAllowed(event.kind))) {
    await metrics.incrementEventsRejected();
    await sendResponse(connId, [
      "OK",
      event.id,
      false,
      "blocked: event kind not allowed",
    ]);
    return;
  }

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

  // Subscribe for future events using PubSub
  try {
    await pubsub.subscribe(connId, subId, filters);
  } catch (error) {
    console.error("Failed to subscribe:", error);
    await sendResponse(connId, [
      "CLOSED",
      subId,
      "error: failed to create subscription",
    ]);
    return;
  }

  // Query historical events for each filter
  const queryPromises = filters.map(async (filter) => {
    try {
      const events = await relay.query([filter]);

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
  try {
    await pubsub.unsubscribe(connId, subId);
  } catch (error) {
    console.error("Failed to unsubscribe:", error);
  }
}

async function broadcastEvent(event: NostrEvent): Promise<void> {
  // Check if event is too old to broadcast (but not ephemeral)
  const ephemeral = isEphemeral(event.kind);
  const tooOld = isEventTooOld(event);

  if (!ephemeral && tooOld) {
    // Skip broadcasting old events
    return;
  }

  try {
    // Find all matching subscriptions using inverted indexes
    const matchingSubscriptions = await pubsub.findMatchingSubscriptions(event);

    // Broadcast to each matching subscription
    for (const [_indexKey, subscription] of matchingSubscriptions) {
      const { connId, subId } = subscription;

      // Send EVENT message to the connection
      await sendResponse(connId, ["EVENT", subId, event]);
    }

    // Increment broadcast counter if we sent to any subscriptions
    if (matchingSubscriptions.size > 0) {
      await metrics.incrementEventsBroadcast();
    }
  } catch (error) {
    console.error("Failed to broadcast event:", error);
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
