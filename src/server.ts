import { Hono } from "hono";
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import { connectionsGauge, getMetrics, register, initializeMetrics, getMetricsInstance } from "./metrics.ts";
import type { NostrRelayMsg } from "@nostrify/nostrify";

// Instantiate config with Deno.env
const config = new Config(Deno.env);

// Instantiate ClickHouse client with config (connect to default database first)
const clickhouse = createClient({
  url: config.getClickHouseUrl(),
});

// Initialize ClickHouse database and tables
// Create the nostr database if it doesn't exist
await clickhouse.query({
  query: "CREATE DATABASE IF NOT EXISTS nostr",
});

// Create the main events table using the new schema
await clickhouse.query({
  query: `CREATE TABLE IF NOT EXISTS nostr.events_local (
    id String COMMENT '32-byte hex event ID (SHA-256 hash)',
    pubkey String COMMENT '32-byte hex public key of event creator',
    created_at UInt32 COMMENT 'Unix timestamp when event was created',
    kind UInt16 COMMENT 'Event kind (0-65535, see NIP-01)',
    content String COMMENT 'Event content (arbitrary string, format depends on kind)',
    sig String COMMENT '64-byte hex Schnorr signature',
    tags Array(Array(String)) COMMENT 'Nested array of tags',
    indexed_at UInt32 DEFAULT now() COMMENT 'When this event was indexed into Clickhouse',
    relay_source String DEFAULT '' COMMENT 'Source relay URL (e.g., wss://relay.damus.io)',
    INDEX idx_kind kind TYPE minmax GRANULARITY 4,
    INDEX idx_pubkey pubkey TYPE bloom_filter(0.01) GRANULARITY 4
  ) ENGINE = ReplacingMergeTree(indexed_at)
  ORDER BY (id, created_at, kind, pubkey)
  PARTITION BY toYYYYMM(toDateTime(created_at))
  SETTINGS 
    index_granularity = 8192,
    allow_nullable_key = 0
  COMMENT 'Main Nostr events table with time-first sort order'`,
});

// Create flattened tag materialized view for fast tag queries
await clickhouse.query({
  query: `CREATE MATERIALIZED VIEW IF NOT EXISTS nostr.event_tags_flat
ENGINE = MergeTree()
ORDER BY (tag_name, tag_value_1, created_at, event_id)
PARTITION BY toYYYYMM(toDateTime(created_at))
AS SELECT
    id as event_id,
    pubkey,
    created_at,
    kind,
    arrayJoin(tags) as tag_array,
    tag_array[1] as tag_name,
    if(length(tag_array) >= 2, tag_array[2], '') as tag_value_1,
    if(length(tag_array) >= 3, tag_array[3], '') as tag_value_2,
    if(length(tag_array) >= 4, tag_array[4], '') as tag_value_3,
    if(length(tag_array) >= 5, tag_array[5], '') as tag_value_4,
    length(tag_array) as tag_length,
    tag_array as tag_full
FROM nostr.events_local`,
});

// Create statistics views for monitoring and analytics
await clickhouse.query({
  query: `CREATE VIEW IF NOT EXISTS nostr.event_stats AS
SELECT
    toStartOfDay(toDateTime(created_at)) as date,
    kind,
    count() as event_count,
    uniq(pubkey) as unique_authors,
    avg(length(content)) as avg_content_length,
    sum(length(tags)) as total_tags
FROM nostr.events_local
GROUP BY date, kind
ORDER BY date DESC, event_count DESC`,
});

await clickhouse.query({
  query: `CREATE VIEW IF NOT EXISTS nostr.relay_stats AS
SELECT
    relay_source,
    count() as event_count,
    uniq(id) as unique_events,
    min(toDateTime(created_at)) as earliest_event,
    max(toDateTime(created_at)) as latest_event,
    uniq(pubkey) as unique_authors
FROM nostr.events_local
WHERE relay_source != ''
GROUP BY relay_source
ORDER BY event_count DESC`,
});

await clickhouse.query({
  query: `CREATE VIEW IF NOT EXISTS nostr.tag_stats AS
SELECT
    tag_name,
    count() as occurrence_count,
    uniq(event_id) as unique_events,
    avg(tag_length) as avg_tag_length
FROM nostr.event_tags_flat
GROUP BY tag_name
ORDER BY occurrence_count DESC`,
});

// Instantiate Redis client for queueing messages
const redis = createRedisClient({
  url: config.redisUrl,
});

await redis.connect();

// Initialize metrics with Redis client
initializeMetrics(redis);

// Get metrics instance for use in this module
const metrics = getMetricsInstance();

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
    metrics.incrementConnections();
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
    metrics.incrementConnections(-1);
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
