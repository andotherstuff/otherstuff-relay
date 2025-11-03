import { Hono } from "hono";
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import {
  connectionsGauge,
  getMetrics,
  getMetricsInstance,
  initializeMetrics,
  register,
} from "./metrics.ts";
import type { NostrRelayMsg } from "@nostrify/nostrify";

// Instantiate config with Deno.env
const config = new Config(Deno.env);

// Now connect to the specific database
const clickhouse = createClient({
  url: config.databaseUrl,
});

// Initialize ClickHouse tables
await clickhouse.query({
  query: `CREATE TABLE IF NOT EXISTS events_local (
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
  query: `CREATE MATERIALIZED VIEW IF NOT EXISTS event_tags_flat
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
FROM events_local`,
});

// Create statistics views for monitoring and analytics
await clickhouse.query({
  query: `CREATE VIEW IF NOT EXISTS event_stats AS
SELECT
    toStartOfDay(toDateTime(created_at)) as date,
    kind,
    count() as event_count,
    uniq(pubkey) as unique_authors,
    avg(length(content)) as avg_content_length,
    sum(length(tags)) as total_tags
FROM events_local
GROUP BY date, kind
ORDER BY date DESC, event_count DESC`,
});

await clickhouse.query({
  query: `CREATE VIEW IF NOT EXISTS relay_stats AS
SELECT
    relay_source,
    count() as event_count,
    uniq(id) as unique_events,
    min(toDateTime(created_at)) as earliest_event,
    max(toDateTime(created_at)) as latest_event,
    uniq(pubkey) as unique_authors
FROM events_local
WHERE relay_source != ''
GROUP BY relay_source
ORDER BY event_count DESC`,
});

await clickhouse.query({
  query: `CREATE VIEW IF NOT EXISTS tag_stats AS
SELECT
    tag_name,
    count() as occurrence_count,
    uniq(event_id) as unique_events,
    avg(tag_length) as avg_tag_length
FROM event_tags_flat
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
  const queueKey = `nostr:responses:${connId}`;

  socket.onopen = async () => {
    metrics.incrementConnections();
    connectionsGauge.inc();

    // Track connection start time for age-based cleanup
    const connectionStartTime = Date.now();
    await redis.hSet(`nostr:conn:meta:${connId}`, {
      start_time: connectionStartTime.toString(),
      last_activity: connectionStartTime.toString(),
    });

    // Set initial TTL on response queue as safety net for orphaned queues
    await redis.expire(queueKey, 300); // 5 minutes TTL
    await redis.expire(`nostr:conn:meta:${connId}`, 3600); // 1 hour for metadata

    // Start polling for responses from relay workers
    responsePoller = setInterval(async () => {
      try {
        // Check queue size to prevent endless buildup
        const queueSize = await redis.lLen(queueKey);
        
// Log queue sizes for monitoring (but not too frequently)
        if (queueSize > 1000 && queueSize % 1000 === 0) {
          console.warn(`📊 Queue size for ${connId}: ${queueSize} messages, bufferedAmount: ${socket.bufferedAmount}`);
        }
        
        // Emergency cleanup for massive queues
        if (queueSize > 50000) {
          console.error(`🚨 Response queue emergency for ${connId}: ${queueSize} messages, bufferedAmount: ${socket.bufferedAmount}, forcing immediate cleanup`);
          await redis.del(queueKey);
          await redis.hSet(`nostr:conn:meta:${connId}`, "emergency_cleanup", Date.now().toString());
          socket.close(1013, "Server overloaded");
          return;
        }
        
        // Force cleanup if queue gets too large (potential abuse or stuck client)
        if (queueSize > 10000) {
          console.warn(`⚠️  Response queue too large for ${connId}: ${queueSize} messages, bufferedAmount: ${socket.bufferedAmount}, forcing cleanup`);
          await redis.del(queueKey);
          await redis.hSet(`nostr:conn:meta:${connId}`, "forced_cleanup", Date.now().toString());
          return;
        }

        // Non-blocking pop of responses
        const responses = await redis.lPopCount(queueKey, 100);
        if (responses && responses.length > 0) {
          let sentCount = 0;
          let failedCount = 0;
          const failedMessages = [];
          
          for (const responseJson of responses) {
            try {
              const { msg } = JSON.parse(responseJson);
              if (send(msg)) {
                sentCount++;
              } else {
                failedCount++;
                failedMessages.push(responseJson); // Store failed messages
              }
            } catch (err) {
              console.error("Error parsing response:", err);
              failedCount++;
            }
          }
          
          // CRITICAL FIX: Put failed messages at the BACK of the queue, not front!
          if (failedMessages.length > 0) {
            await redis.rPush(queueKey, failedMessages);
          }
          
          // Only update activity and reset TTL if we actually sent messages
          if (sentCount > 0) {
            await redis.hSet(`nostr:conn:meta:${connId}`, "last_activity", Date.now().toString());
            
            // Only reset TTL if connection is not too old and sending successfully
            const connectionAge = Date.now() - connectionStartTime;
            if (connectionAge < 1800000) { // 30 minutes max connection age
              await redis.expire(queueKey, 300); // Reset to 5 minutes
            }
          }
          
          // If too many sends failed, the connection is likely stuck
          if (failedCount > 50) { // Increased threshold since we're now properly queuing failed messages
            console.warn(`⚠️  Too many send failures for ${connId}: ${failedCount}/${responses.length}, closing connection`);
            socket.close(1013, "Try again later");
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

    // Clean up all connection-related data in Redis with a single command
    try {
      await redis.del([
        `nostr:subs:${connId}`,
        `nostr:sub:counts:${connId}`,
        `nostr:sub:limits:${connId}`,
        `nostr:sub:eose:${connId}`,
        queueKey,
        `nostr:conn:meta:${connId}`,
        `nostr:block:${connId}`,
      ]);
    } catch (err) {
      console.error("Error cleaning up connection data:", err);
    }
  };

  socket.onerror = (err) => {
    if (Deno.env.get("DEBUG")) {
      console.error("WebSocket error:", err);
    }
  };

  let sendFailures = 0;
  
  function send(msg: NostrRelayMsg): boolean {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        // Check buffered amount to prevent backing up
        if (socket.bufferedAmount > 1024 * 1024) { // 1MB buffer limit
          console.warn(`⚠️  WebSocket buffer full for ${connId}: ${socket.bufferedAmount} bytes`);
          sendFailures++;
          return false;
        }
        
        socket.send(JSON.stringify(msg));
        sendFailures = 0; // Reset on successful send
        return true;
      }
      return false;
    } catch (err) {
      sendFailures++;
      console.error(`Error sending message to ${connId}:`, err);
      return false;
    }
  }

  return response;
});

// Periodic cleanup of orphaned response keys and stuck connections
const cleanupOrphanedKeys = async () => {
  try {
    let cleaned = 0;
    let forcedCleaned = 0;
    let cursor = "0";
    
    // Use SCAN for production safety (doesn't block the server)
    do {
      const result = await redis.scan(cursor, {
        MATCH: "nostr:responses:*",
        COUNT: 100,
      });
      
      cursor = result.cursor;
      const responseKeys = result.keys;

      // Check each response key for various cleanup conditions
      for (const responseKey of responseKeys) {
        const connId = responseKey.replace("nostr:responses:", "");
        const subsKey = `nostr:subs:${connId}`;
        const metaKey = `nostr:conn:meta:${connId}`;
        const blockKey = `nostr:block:${connId}`;
        
        // Check if connection is orphaned (no subscriptions exist)
        if (!(await redis.exists(subsKey))) {
          await redis.del([responseKey, metaKey, blockKey]);
          cleaned++;
          continue;
        }

        // Emergency cleanup for massive queues
        const queueSize = await redis.lLen(responseKey);
        if (queueSize > 100000) {
          console.error(`🚨 EMERGENCY: Massive queue cleanup for ${connId}: ${queueSize} messages`);
          await redis.del([
            responseKey,
            subsKey,
            `nostr:sub:counts:${connId}`,
            `nostr:sub:limits:${connId}`,
            `nostr:sub:eose:${connId}`,
            metaKey,
            blockKey,
          ]);
          forcedCleaned++;
          continue;
        }

        // Check for stuck connections (old and inactive)
        const meta = await redis.hGetAll(metaKey);
        if (meta && meta.start_time && meta.last_activity) {
          const connectionAge = Date.now() - parseInt(meta.start_time);
          const inactivityTime = Date.now() - parseInt(meta.last_activity);
          
          // Force cleanup for very old connections (> 1 hour) or inactive (> 30 minutes)
          if (connectionAge > 3600000 || inactivityTime > 1800000) {
            console.warn(`⚠️  Force cleaning stuck connection ${connId}: age=${Math.round(connectionAge/1000)}s, inactive=${Math.round(inactivityTime/1000)}s`);
            await redis.del([
              responseKey,
              subsKey,
              `nostr:sub:counts:${connId}`,
              `nostr:sub:limits:${connId}`,
              `nostr:sub:eose:${connId}`,
              metaKey,
              blockKey,
            ]);
            forcedCleaned++;
          }
        }
      }
    } while (cursor !== "0");

    if (cleaned > 0 || forcedCleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} orphaned and ${forcedCleaned} stuck response keys`);
    }
  } catch (error) {
    console.error("Error during orphaned key cleanup:", error);
  }
};

// Run cleanup every 2 minutes
setInterval(cleanupOrphanedKeys, 120000);

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
