/**
 * Optimized relay worker - uses in-memory channels instead of Redis queues
 * Processes messages in parallel with minimal overhead
 */

import { NSchema as n } from "@nostrify/nostrify";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { Client } from "@opensearch-project/opensearch";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import { Config } from "@/lib/config.ts";
import { getMetricsInstance, initializeMetrics } from "@/lib/metrics.ts";
import { OpenSearchRelay } from "@/lib/opensearch.ts";
import { RelayManagement } from "@/lib/management.ts";
import { PubSub } from "@/lib/pubsub.ts";
import type { SharedState, ClientMessage } from "@/lib/worker-pool.ts";
import {
  initNativeSecp256k1,
  validateEventStructure,
  verifyEvent,
} from "@/lib/native-verify.ts";

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

if (config.opensearchUsername && config.opensearchPassword) {
  opensearchConfig.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}

const opensearch = new Client(opensearchConfig);

// Redis client (only for distributed state - subscriptions, metrics)
const redis: RedisClientType = createRedisClient({
  url: config.redisUrl,
});
await redis.connect();

// Initialize metrics
initializeMetrics(redis);
const metrics = getMetricsInstance();

// Initialize relay
const relay = new OpenSearchRelay(opensearch);
const management = new RelayManagement(redis, relay);
const pubsub = new PubSub(redis);

// Initialize native verification (falls back to WASM if unavailable)
const nativeAvailable = initNativeSecp256k1();
console.log(
  nativeAvailable
    ? "✅ Using native secp256k1 verification"
    : "⚠️  Using WASM verification",
);

const WORKER_ID = crypto.randomUUID().slice(0, 8);

// Helper functions
function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

function isEventTooOld(event: NostrEvent): boolean {
  if (config.broadcastMaxAge === 0) return false;
  const now = Math.floor(Date.now() / 1000);
  return (now - event.created_at) > config.broadcastMaxAge;
}

/**
 * Process a single client message
 */
async function processClientMessage(
  msg: ClientMessage,
  state: SharedState,
): Promise<void> {
  const { connId, msg: rawMsg } = msg;

  try {
    const parsed = n.json().pipe(n.clientMsg()).parse(rawMsg);

    switch (parsed[0]) {
      case "EVENT": {
        const event = parsed[1];
        await handleEvent(connId, event, state);
        break;
      }

      case "REQ": {
        const [_, subId, ...filters] = parsed;
        await handleReq(connId, subId, filters, state);
        break;
      }

      case "CLOSE": {
        const [_, subId] = parsed;
        await handleClose(connId, subId);
        break;
      }

      default:
        state.responses.send(connId, ["NOTICE", "unknown command"]);
    }

    state.stats.messagesProcessed++;
  } catch (err) {
    console.error("Message processing error:", err);
    state.responses.send(connId, ["NOTICE", "invalid message"]);
  }
}

/**
 * Handle EVENT message
 */
async function handleEvent(
  connId: string,
  event: NostrEvent,
  state: SharedState,
): Promise<void> {
  await metrics.incrementEventsReceived();
  await metrics.incrementEventByKind(event.kind);

  // Fast structure validation
  if (!validateEventStructure(event)) {
    await metrics.incrementEventsInvalid();
    // Use a default ID if event structure is invalid
    const eventId = (event as { id?: string }).id || "unknown";
    state.responses.send(connId, [
      "OK",
      eventId,
      false,
      "invalid: malformed event",
    ]);
    return;
  }

  // Size check
  if (JSON.stringify(event).length > 500000) {
    await metrics.incrementEventsRejected();
    state.responses.send(connId, [
      "OK",
      event.id,
      false,
      "rejected: event too large",
    ]);
    return;
  }

  // NIP-86 checks
  if (await management.isPubkeyBanned(event.pubkey)) {
    await metrics.incrementEventsRejected();
    state.responses.send(connId, [
      "OK",
      event.id,
      false,
      "blocked: pubkey is banned",
    ]);
    return;
  }

  if (!(await management.isPubkeyAllowed(event.pubkey))) {
    await metrics.incrementEventsRejected();
    state.responses.send(connId, [
      "OK",
      event.id,
      false,
      "blocked: pubkey not in allowlist",
    ]);
    return;
  }

  if (await management.isEventBanned(event.id)) {
    await metrics.incrementEventsRejected();
    state.responses.send(connId, [
      "OK",
      event.id,
      false,
      "blocked: event is banned",
    ]);
    return;
  }

  if (!(await management.isKindAllowed(event.kind))) {
    await metrics.incrementEventsRejected();
    state.responses.send(connId, [
      "OK",
      event.id,
      false,
      "blocked: event kind not allowed",
    ]);
    return;
  }

  // Verify signature
  const valid = await verifyEvent(event);
  if (!valid) {
    await metrics.incrementEventsInvalid();
    state.responses.send(connId, [
      "OK",
      event.id,
      false,
      "invalid: signature verification failed",
    ]);
    return;
  }

  state.stats.eventsValidated++;

  const ephemeral = isEphemeral(event.kind);
  const tooOld = isEventTooOld(event);

  // Reject ephemeral events that are too old
  if (ephemeral && tooOld) {
    await metrics.incrementEventsRejected();
    state.responses.send(connId, [
      "OK",
      event.id,
      false,
      "rejected: event too old",
    ]);
    return;
  }

  // Queue for storage (if not ephemeral)
  if (!ephemeral) {
    state.validatedEvents.push(event);
  }

  // Send OK response
  state.responses.send(connId, ["OK", event.id, true, ""]);

  // Broadcast to subscribers (if not too old)
  if (!tooOld || ephemeral) {
    state.eventBroadcast.push(event);
  }
}

/**
 * Handle REQ message
 */
async function handleReq(
  connId: string,
  subId: string,
  filters: NostrFilter[],
  state: SharedState,
): Promise<void> {
  await metrics.incrementQueriesTotal();

  // Limit filters
  if (filters.length > 10) {
    filters = filters.slice(0, 10);
  }

  // Subscribe for future events
  try {
    await pubsub.subscribe(connId, subId, filters);
  } catch (error) {
    console.error("Failed to subscribe:", error);
    state.responses.send(connId, [
      "CLOSED",
      subId,
      "error: failed to create subscription",
    ]);
    return;
  }

  // Query historical events
  try {
    const queryPromises = filters.map(async (filter) => {
      const events = await relay.query([filter]);
      for (const event of events) {
        state.responses.send(connId, ["EVENT", subId, event]);
      }
      return events.length;
    });

    await Promise.race([
      Promise.all(queryPromises),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Query timeout")), 10000)
      ),
    ]);
  } catch (error) {
    console.error("Query error:", error);
  }

  // Send EOSE
  state.responses.send(connId, ["EOSE", subId]);
}

/**
 * Handle CLOSE message
 */
async function handleClose(connId: string, subId: string): Promise<void> {
  try {
    await pubsub.unsubscribe(connId, subId);
  } catch (error) {
    console.error("Failed to unsubscribe:", error);
  }
}

/**
 * Worker main loop
 */
export async function runValidationWorker(state: SharedState): Promise<void> {
  console.log(`🔧 Validation worker ${WORKER_ID} started`);

  while (true) {
    try {
      // Pop messages from channel (blocking with 1s timeout)
      const messages = await state.clientMessages.pop(100, 1000);

      if (messages.length > 0) {
        // Process messages in parallel
        await Promise.all(
          messages.map((msg) => processClientMessage(msg, state)),
        );
      }
    } catch (error) {
      console.error("Worker error:", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Broadcast worker - distributes events to matching subscriptions
 */
export async function runBroadcastWorker(state: SharedState): Promise<void> {
  console.log(`📡 Broadcast worker ${WORKER_ID} started`);

  while (true) {
    try {
      const events = await state.eventBroadcast.pop(100, 1000);

      for (const event of events) {
        // Find matching subscriptions using Redis inverted indexes
        const matchingSubscriptions = await pubsub.findMatchingSubscriptions(
          event,
        );

        // Send to each matching subscription
        for (const [_indexKey, subscription] of matchingSubscriptions) {
          const { connId, subId } = subscription;
          state.responses.send(connId, ["EVENT", subId, event]);
        }

        if (matchingSubscriptions.size > 0) {
          await metrics.incrementEventsBroadcast();
        }
      }
    } catch (error) {
      console.error("Broadcast worker error:", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Storage worker - batches events and writes to OpenSearch
 */
export async function runStorageWorker(state: SharedState): Promise<void> {
  console.log(`💾 Storage worker ${WORKER_ID} started`);

  const BATCH_SIZE = 1000;

  while (true) {
    try {
      const events = await state.validatedEvents.pop(BATCH_SIZE, 100);

      if (events.length > 0) {
        try {
          await relay.eventBatch(events);
          await metrics.incrementEventsStored(events.length);
          state.stats.eventsStored += events.length;
          console.log(`✅ Stored ${events.length} events`);
        } catch (error) {
          console.error("Storage error:", error);
          await metrics.incrementEventsFailed(events.length);
          // Push back to queue for retry
          state.validatedEvents.pushBatch(events);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      console.error("Storage worker error:", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Graceful shutdown
const shutdown = async () => {
  console.log(`Shutting down worker ${WORKER_ID}...`);
  await redis.quit();
  await opensearch.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
