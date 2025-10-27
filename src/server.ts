import { Hono } from "hono";
import { NSchema as n } from "@nostrify/nostrify";
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import { NostrRelay } from "./relay.ts";
import { connectionsGauge, getMetrics, register } from "./metrics.ts";
import type { NostrEvent, NostrFilter, NostrRelayMsg } from "@nostrify/nostrify";
import type { RedisClientType } from "redis";

// Instantiate config with Deno.env
const config = new Config(Deno.env);

// Instantiate ClickHouse client with config
const clickhouse = createClient({
  url: config.databaseUrl,
});

// Initialize ClickHouse database and tables
await clickhouse.query({
  query: `CREATE TABLE IF NOT EXISTS events (
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
  SETTINGS index_granularity = 8192`,
});

// Create Redis publisher client (shared across all connections)
const redisPublisher = createRedisClient({
  url: config.redisUrl,
}) as RedisClientType;

await redisPublisher.connect();
console.log("✅ Connected to Redis");

// Instantiate relay with config, clickhouse, and redis
const relay = new NostrRelay(clickhouse, redisPublisher);

const app = new Hono();

// Metrics endpoint
app.get("/metrics", async (c) => {
  const metricsText = await getMetrics();
  return c.text(metricsText, 200, {
    "Content-Type": register.contentType,
  });
});

// Health endpoint
app.get("/health", async (c) => {
  try {
    // Check ClickHouse connection
    await clickhouse.ping();
    
    // Check Redis connection
    await redisPublisher.ping();

    return c.json({
      status: "ok",
      clickhouse: "connected",
      redis: "connected",
    });
  } catch (error) {
    return c.json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});

// WebSocket endpoint
app.get("/", (c) => {
  const upgrade = c.req.header("upgrade");
  if (upgrade !== "websocket") {
    return c.text("Use a Nostr client to connect", 400);
  }

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  
  // Create a dedicated Redis subscriber for this connection
  let redisSubscriber: RedisClientType | null = null;
  const subscriptions = new Map<string, NostrFilter[]>();
  const maxSubs = 20; // Max subscriptions per connection

  const setupRedisSubscriber = async () => {
    redisSubscriber = createRedisClient({
      url: config.redisUrl,
    }) as RedisClientType;

    await redisSubscriber.connect();

    // Subscribe to the events channel
    await redisSubscriber.subscribe("nostr:events", (message) => {
      try {
        const event = JSON.parse(message) as NostrEvent;
        
        // Check if event matches any active subscription
        for (const [subId, filters] of subscriptions.entries()) {
          if (NostrRelay.matchesFilters(event, filters)) {
            send(["EVENT", subId, event]);
          }
        }
      } catch (error) {
        console.error("Error processing Redis message:", error);
      }
    });
  };

  socket.onopen = () => {
    connectionsGauge.inc();
    setupRedisSubscriber().catch((error) => {
      console.error("Failed to setup Redis subscriber:", error);
      socket.close();
    });
  };

  socket.onmessage = async (e) => {
    try {
      const msg = n.json().pipe(n.clientMsg()).parse(e.data);

      switch (msg[0]) {
        case "EVENT": {
          const event = msg[1];
          const [ok, message] = await relay.handleEvent(event);
          send(["OK", event.id, ok, message]);
          break;
        }

        case "REQ": {
          const [_, subId, ...filters] = msg;
          
          // Check subscription limit
          if (subscriptions.size >= maxSubs) {
            send(["CLOSED", subId, "error: too many subscriptions"]);
            break;
          }

          // Store subscription filters for real-time matching
          subscriptions.set(subId, filters);

          // Query historical events and send EOSE
          await relay.handleReq(
            subId,
            filters,
            (event: NostrEvent) => send(["EVENT", subId, event]),
            () => send(["EOSE", subId]),
          );
          
          // Real-time events will be delivered via Redis pub/sub
          break;
        }

        case "CLOSE": {
          const [_, subId] = msg;
          if (subscriptions.has(subId)) {
            subscriptions.delete(subId);
            relay.handleClose();
          }
          break;
        }

        default:
          send(["NOTICE", "unknown command"]);
      }
    } catch (err) {
      console.error("Message error:", err);
      send(["NOTICE", "invalid message"]);
    }
  };

  socket.onclose = async () => {
    connectionsGauge.dec();
    
    // Clean up subscriptions
    for (const _subId of subscriptions.keys()) {
      relay.handleClose();
    }
    subscriptions.clear();

    // Disconnect Redis subscriber
    if (redisSubscriber) {
      try {
        await redisSubscriber.unsubscribe("nostr:events");
        await redisSubscriber.quit();
      } catch (error) {
        console.error("Error closing Redis subscriber:", error);
      }
    }
  };

  socket.onerror = (err) => {
    if (Deno.env.get("DEBUG")) {
      console.error("WebSocket error:", err);
    } else {
      console.error("WebSocket connection error");
    }
  };

  function send(msg: NostrRelayMsg) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    } catch {
      // fallthrough
    }
  }

  return response;
});

console.log(`🔧 Initializing Nostr relay...`);
console.log(`📊 Metrics: http://localhost:${config.port}/metrics`);
console.log(`🚀 Server ready on port ${config.port}`);

const shutdown = async () => {
  console.log("Shutting down...");
  await relay.close();
  await redisPublisher.quit();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
