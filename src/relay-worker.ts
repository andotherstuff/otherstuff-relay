/**
 * Relay worker process that bridges Redis queues with OpenSearchRelay
 * Handles message routing, subscription state, and response delivery
 */
import { NSchema as n } from "@nostrify/nostrify";
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

async function handleClose(_connId: string, _subId: string): Promise<void> {
  // Subscription tracking removed - will be reimplemented differently
}

async function broadcastEvent(_event: NostrEvent): Promise<void> {
  // Event broadcasting removed - will be reimplemented differently
  // The old implementation using nostr:conn:* keys was highly inefficient
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
