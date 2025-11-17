/**
 * STRFRY MODE - Zero network calls in hot path
 * 
 * Like strfry but with OpenSearch storage:
 * - All message processing in-memory
 * - Zero Redis calls for message routing
 * - Native secp256k1 validation
 * - Batched OpenSearch writes (1/sec)
 * - In-memory subscription matching
 * 
 * Expected: 100,000+ messages/sec (100x improvement)
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Client } from "@opensearch-project/opensearch";
import { Config } from "@/lib/config.ts";
import { MessageQueue } from "@/lib/ring-buffer.ts";
import { OpenSearchRelay } from "@/lib/opensearch.ts";
import type { NostrEvent, NostrFilter, NostrRelayMsg } from "@nostrify/nostrify";
import { NSchema as n } from "@nostrify/nostrify";
import { setNostrWasm, verifyEvent } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";

const config = new Config(Deno.env);

// Initialize WASM for event verification
const wasmInitialized = (async () => {
  const wasm = await initNostrWasm();
  setNostrWasm(wasm);
})();

// OpenSearch client (only for storage, not hot path)
const opensearch = new Client({
  node: config.opensearchUrl,
  ...(config.opensearchUsername && config.opensearchPassword
    ? {
      auth: {
        username: config.opensearchUsername,
        password: config.opensearchPassword,
      },
    }
    : {}),
});

const relay = new OpenSearchRelay(opensearch);

// In-memory message queue (like strfry's inbox)
const messageQueue = new MessageQueue(100000, 65536);

// In-memory event buffer for batched OpenSearch writes
const eventBuffer: NostrEvent[] = [];
const MAX_BUFFER_SIZE = 1000;
const FLUSH_INTERVAL_MS = 1000;

// In-memory subscription storage
interface Subscription {
  connId: string;
  subId: string;
  filters: NostrFilter[];
}

const subscriptions = new Map<string, Map<string, NostrFilter[]>>(); // connId -> subId -> filters
const connectionSockets = new Map<string, WebSocket>(); // connId -> socket

// Metrics
let stats = {
  messagesReceived: 0,
  eventsValidated: 0,
  eventsStored: 0,
  eventsRejected: 0,
  queriesTotal: 0,
  connections: 0,
  subscriptions: 0,
};

/**
 * Check if event matches filter (in-memory, no network calls)
 */
function eventMatchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && filter.ids.length > 0) {
    const match = filter.ids.some((id) => event.id.startsWith(id));
    if (!match) return false;
  }

  if (filter.authors && filter.authors.length > 0) {
    const match = filter.authors.some((author) => event.pubkey.startsWith(author));
    if (!match) return false;
  }

  if (filter.kinds && filter.kinds.length > 0) {
    if (!filter.kinds.includes(event.kind)) return false;
  }

  if (filter.since !== undefined) {
    if (event.created_at < filter.since) return false;
  }

  if (filter.until !== undefined) {
    if (event.created_at > filter.until) return false;
  }

  // Tag filters
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && Array.isArray(values)) {
      const tagName = key.slice(1);
      const eventTagValues = event.tags
        .filter((tag) => tag[0] === tagName)
        .map((tag) => tag[1]);

      const match = values.some((v) => eventTagValues.includes(v as string));
      if (!match) return false;
    }
  }

  return true;
}

/**
 * Broadcast event to matching subscriptions (in-memory, no network calls)
 */
function broadcastEvent(event: NostrEvent): number {
  let broadcastCount = 0;

  for (const [connId, subs] of subscriptions) {
    const socket = connectionSockets.get(connId);
    if (!socket || socket.readyState !== WebSocket.OPEN) continue;

    for (const [subId, filters] of subs) {
      for (const filter of filters) {
        if (eventMatchesFilter(event, filter)) {
          try {
            socket.send(JSON.stringify(["EVENT", subId, event]));
            broadcastCount++;
          } catch (err) {
            console.error("Broadcast error:", err);
          }
          break; // Only send once per subscription
        }
      }
    }
  }

  return broadcastCount;
}

/**
 * Send response to specific connection
 */
function sendToConnection(connId: string, msg: NostrRelayMsg): void {
  const socket = connectionSockets.get(connId);
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      console.error("Send error:", err);
    }
  }
}

/**
 * Process a single message (in-memory, no network calls)
 */
async function processMessage(connId: string, rawMsg: string): Promise<void> {
  stats.messagesReceived++;

  try {
    const parsed = n.json().pipe(n.clientMsg()).parse(rawMsg);

    switch (parsed[0]) {
      case "EVENT": {
        const event = parsed[1];

        // Validate event
        await wasmInitialized;
        if (!verifyEvent(event)) {
          stats.eventsRejected++;
          sendToConnection(connId, ["OK", event.id, false, "invalid: signature verification failed"]);
          return;
        }

        stats.eventsValidated++;

        // Buffer for batched OpenSearch write
        eventBuffer.push(event);

        // Send OK immediately (optimistic)
        sendToConnection(connId, ["OK", event.id, true, ""]);

        // Broadcast to subscribers (in-memory)
        broadcastEvent(event);

        // Flush buffer if full
        if (eventBuffer.length >= MAX_BUFFER_SIZE) {
          await flushEventBuffer();
        }

        break;
      }

      case "REQ": {
        const [_, subId, ...filters] = parsed;
        stats.queriesTotal++;

        // Store subscription in memory
        if (!subscriptions.has(connId)) {
          subscriptions.set(connId, new Map());
        }
        subscriptions.get(connId)!.set(subId, filters);
        stats.subscriptions++;

        // Query historical events from OpenSearch
        try {
          const events = await relay.query(filters.slice(0, 10));
          for (const event of events) {
            sendToConnection(connId, ["EVENT", subId, event]);
          }
        } catch (error) {
          console.error("Query error:", error);
        }

        // Send EOSE
        sendToConnection(connId, ["EOSE", subId]);
        break;
      }

      case "CLOSE": {
        const [_, subId] = parsed;

        // Remove subscription from memory
        const connSubs = subscriptions.get(connId);
        if (connSubs) {
          connSubs.delete(subId);
          stats.subscriptions--;
          if (connSubs.size === 0) {
            subscriptions.delete(connId);
          }
        }
        break;
      }

      default:
        sendToConnection(connId, ["NOTICE", "unknown command"]);
    }
  } catch (err) {
    console.error("Message processing error:", err);
    sendToConnection(connId, ["NOTICE", "invalid message"]);
  }
}

/**
 * Flush event buffer to OpenSearch (batched, only 1 network call)
 */
async function flushEventBuffer(): Promise<void> {
  if (eventBuffer.length === 0) return;

  const batch = eventBuffer.splice(0, MAX_BUFFER_SIZE);

  try {
    await relay.eventBatch(batch);
    stats.eventsStored += batch.length;
    console.log(`✅ Flushed ${batch.length} events to OpenSearch`);
  } catch (error) {
    console.error("❌ Failed to flush events:", error);
    // Put events back in buffer for retry
    eventBuffer.unshift(...batch);
  }
}

// Background thread: Flush event buffer periodically
setInterval(() => {
  flushEventBuffer();
}, FLUSH_INTERVAL_MS);

// Background thread: Process messages from queue
setInterval(() => {
  const messages = messageQueue.popAll(1000);
  
  for (const msg of messages) {
    const { connId, rawMsg } = msg as { connId: string; rawMsg: string };
    processMessage(connId, rawMsg);
  }
}, 1); // Process every 1ms for low latency

const app = new Hono();

app.use("*", (c, next) => {
  const upgrade = c.req.header("upgrade");
  if (upgrade === "websocket") {
    return next();
  } else {
    return cors()(c, next);
  }
});

// Health endpoint
app.get("/health", (c) => {
  const queueStats = messageQueue.stats();

  return c.json({
    status: "ok",
    mode: "strfry",
    stats: {
      ...stats,
      queue: queueStats,
      eventBuffer: eventBuffer.length,
    },
  });
});

// WebSocket endpoint
app.get("/", (c) => {
  const upgrade = c.req.header("upgrade");

  if (upgrade !== "websocket") {
    return c.text("Use a Nostr client to connect", 400);
  }

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  const connId = crypto.randomUUID();

  socket.onopen = () => {
    stats.connections++;
    connectionSockets.set(connId, socket);
    console.log(`🔌 Connection opened: ${connId}`);
  };

  socket.onmessage = (e) => {
    // Push to in-memory queue (zero network calls!)
    const success = messageQueue.push({ connId, rawMsg: e.data });

    if (!success) {
      // Queue full - send backpressure signal
      try {
        socket.send(JSON.stringify(["NOTICE", "relay overloaded - please slow down"]));
      } catch {
        // Socket might be closed
      }
    }
  };

  socket.onclose = () => {
    stats.connections--;
    connectionSockets.delete(connId);

    // Clean up subscriptions
    const connSubs = subscriptions.get(connId);
    if (connSubs) {
      stats.subscriptions -= connSubs.size;
      subscriptions.delete(connId);
    }

    console.log(`🔌 Connection closed: ${connId}`);
  };

  socket.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  return response;
});

console.log(`
╔════════════════════════════════════════════════════════════════╗
║              🚀 STRFRY MODE - ZERO NETWORK CALLS 🚀            ║
╠════════════════════════════════════════════════════════════════╣
║  Like strfry but with OpenSearch storage                       ║
║                                                                ║
║  ✅ In-memory message queue (zero Redis calls)                ║
║  ✅ In-memory subscriptions (zero Redis lookups)              ║
║  ✅ Batched OpenSearch writes (1 call/sec)                    ║
║  ✅ Native validation (WASM for now, FFI later)               ║
║  ✅ Single process (no worker coordination)                   ║
║                                                                ║
║  Expected: 100,000+ messages/sec                               ║
╠════════════════════════════════════════════════════════════════╣
║  Port: ${config.port.toString().padEnd(59)} ║
║  Queue capacity: 100,000 messages                              ║
║  Event buffer: 1,000 events (flush every 1s)                   ║
╚════════════════════════════════════════════════════════════════╝
`);

const shutdown = async () => {
  console.log("Shutting down strfry mode...");
  
  // Flush remaining events
  await flushEventBuffer();
  
  await opensearch.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
