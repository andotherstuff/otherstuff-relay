import { Hono } from "hono";
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import { connectionsGauge, getMetrics, register, RedisMetrics, initializeMetrics } from "./metrics.ts";
import type { NostrRelayMsg } from "@nostrify/nostrify";

// Instantiate config with Deno.env
const config = new Config(Deno.env);

// Instantiate ClickHouse client with config
const clickhouse = createClient({
  url: config.databaseUrl,
});

// Initialize ClickHouse database and tables
// Create the main events table
await clickhouse.query({
  query: `CREATE TABLE IF NOT EXISTS nostr_events (
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

// Instantiate Redis client for queueing messages
const redis = createRedisClient({
  url: config.redisUrl,
});

await redis.connect();

// Initialize metrics with Redis client
initializeMetrics(redis);

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
  const queueLength = await redis.lLen("nostr:relay:queue");
  return c.json({
    status: "ok",
    queueLength,
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
  let responsePoller: number | null = null;

  socket.onopen = () => {
    RedisMetrics.incrementConnections();
    connectionsGauge.inc();

    // Start polling for responses from relay workers
    responsePoller = setInterval(async () => {
      try {
        // Non-blocking pop of responses
        const responses = await redis.lPopCount(
          `nostr:responses:${connId}`,
          100,
        );
        if (responses && responses.length > 0) {
          for (const responseJson of responses) {
            try {
              const { msg } = JSON.parse(responseJson);
              send(msg);
            } catch (err) {
              console.error("Error parsing response:", err);
            }
          }
        }
      } catch (err) {
        console.error("Error polling responses:", err);
      }
    }, 10); // Poll every 10ms for low latency
  };

  socket.onmessage = async (e) => {
    try {
      // Queue the raw message for relay workers to process
      // Don't parse or validate here - let workers do that in parallel
      await redis.lPush(
        "nostr:relay:queue",
        JSON.stringify({
          connId,
          msg: e.data,
        }),
      );
    } catch (err) {
      console.error("Message queueing error:", err);
      send(["NOTICE", "error: failed to queue message"]);
    }
  };

  socket.onclose = async () => {
    RedisMetrics.incrementConnections(-1);
    connectionsGauge.dec();

    // Stop polling for responses
    if (responsePoller !== null) {
      clearInterval(responsePoller);
    }

    // Send disconnect message to relay workers for cleanup
    try {
      await redis.lPush(
        "nostr:relay:queue",
        JSON.stringify({
          connId,
          msg: JSON.stringify(["DISCONNECT"]),
        }),
      );
    } catch (err) {
      console.error("Error sending disconnect:", err);
    }

    // Clean up response queue
    try {
      await redis.del(`nostr:responses:${connId}`);
    } catch (err) {
      console.error("Error cleaning up responses:", err);
    }
  };

  socket.onerror = (err) => {
    if (Deno.env.get("DEBUG")) {
      console.error("WebSocket error:", err);
    }
  };

  function send(msg: NostrRelayMsg) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    } catch (err) {
      if (Deno.env.get("DEBUG")) {
        console.error("Error sending message:", err);
      }
    }
  }

  return response;
});

console.log(`🔧 Initializing Nostr relay...`);
console.log(
  `📊 Metrics: http://localhost:${config.port}/metrics`,
);

const shutdown = async () => {
  console.log("Shutting down server...");
  await redis.quit();
  await clickhouse.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
