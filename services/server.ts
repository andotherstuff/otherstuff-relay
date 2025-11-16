import { Hono } from "hono";
import { createClient as createRedisClient } from "redis";
import { Config } from "@/lib/config.ts";
import {
  connectionsGauge,
  getMetrics,
  getMetricsInstance,
  initializeMetrics,
  register,
} from "@/lib/metrics.ts";

// Instantiate config with Deno.env
const config = new Config(Deno.env);

// Instantiate Redis client for queueing messages
const redis = createRedisClient({
  url: config.redisUrl,
});

await redis.connect();

// Initialize metrics with Redis client
initializeMetrics(redis);

// Get metrics instance for use in this module
const metrics = getMetricsInstance();

// Local counters for batching metrics updates
const localMetrics = {
  websocketOpens: 0,
  websocketCloses: 0,
  websocketErrors: 0,
  messagesSent: 0,
  messagesReceived: 0,
};

// Track memory usage for debugging OOM issues
let lastMemoryLog = 0;

// Flush local metrics to Redis every 5 seconds
setInterval(async () => {
  try {
    // Update connection count based on current gauge value
    const currentConnections = await connectionsGauge.get();
    await metrics.setConnections(currentConnections.values[0]?.value || 0);

    // Flush counters
    if (localMetrics.websocketOpens > 0) {
      await metrics.incrementWebSocketOpens(localMetrics.websocketOpens);
      localMetrics.websocketOpens = 0;
    }
    if (localMetrics.websocketCloses > 0) {
      await metrics.incrementWebSocketCloses(localMetrics.websocketCloses);
      localMetrics.websocketCloses = 0;
    }
    if (localMetrics.websocketErrors > 0) {
      await metrics.incrementWebSocketErrors(localMetrics.websocketErrors);
      localMetrics.websocketErrors = 0;
    }
    if (localMetrics.messagesSent > 0) {
      await metrics.incrementMessagesSent(localMetrics.messagesSent);
      localMetrics.messagesSent = 0;
    }
    if (localMetrics.messagesReceived > 0) {
      await metrics.incrementMessagesReceived(localMetrics.messagesReceived);
      localMetrics.messagesReceived = 0;
    }

    // Log memory usage every 60 seconds to help diagnose OOM
    const now = Date.now();
    if (now - lastMemoryLog >= 60000) {
      const mem = Deno.memoryUsage();
      const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
      const rssMB = (mem.rss / 1024 / 1024).toFixed(2);
      const connections = currentConnections.values[0]?.value || 0;
      console.log(
        `📊 Memory: ${heapMB}MB heap, ${rssMB}MB RSS, ${connections} connections`,
      );
      lastMemoryLog = now;
    }
  } catch (err) {
    console.error("Error flushing metrics:", err);
  }
}, 5000);

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
  const queueKey = `nostr:responses:${connId}`;

  let responsePoller: number | null = null;

  // Cleanup function to explicitly break circular references
  const cleanup = async () => {
    // Clear interval first
    if (responsePoller !== null) {
      clearInterval(responsePoller);
      responsePoller = null;
    }

    // Clean up response queue in Redis
    try {
      await redis.del(queueKey);
    } catch (err) {
      console.error("Error cleaning up connection data:", err);
    }

    // Explicitly null out all event handlers to break circular references
    // This helps V8 garbage collector identify these objects as collectable
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  };

  socket.onopen = () => {
    connectionsGauge.inc();
    localMetrics.websocketOpens++;

    // Start polling for responses from relay workers
    responsePoller = setInterval(async () => {
      // Check if socket is still open before doing work
      if (socket.readyState !== WebSocket.OPEN) {
        if (responsePoller !== null) {
          clearInterval(responsePoller);
          responsePoller = null;
        }
        return;
      }

      try {
        // Non-blocking pop of responses
        const responses = await redis.lPopCount(queueKey, 100);
        if (responses && responses.length > 0) {
          // Reset TTL since we're actively consuming - this is a live connection
          await redis.expire(queueKey, 5);

          for (const responseJson of responses) {
            try {
              const msg = JSON.parse(responseJson);
              // Inline send to avoid closure
              if (socket.readyState === WebSocket.OPEN) {
                localMetrics.messagesSent++;
                socket.send(JSON.stringify(msg));
              }
            } catch (err) {
              console.error("Error parsing/sending response:", err);
            }
          }
        }
      } catch (err) {
        console.error("Error polling responses:", err);
      }
    }, 100); // Poll every 100ms for balanced latency/performance
  };

  socket.onmessage = async (e) => {
    localMetrics.messagesReceived++;
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
      // Inline send to avoid closure
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify(["NOTICE", "error: failed to queue message"]),
          );
        }
      } catch {
        // Ignore send errors
      }
    }
  };

  socket.onclose = async () => {
    connectionsGauge.dec();
    localMetrics.websocketCloses++;
    await cleanup();
  };

  socket.onerror = async (err) => {
    localMetrics.websocketErrors++;
    if (Deno.env.get("DEBUG")) {
      console.error("WebSocket error:", err);
    }
    // Clean up on error to prevent leaks
    await cleanup();
  };

  return response;
});

console.log(`🔧 Initializing Nostr relay...`);
console.log(
  `📊 Metrics: http://localhost:${config.port}/metrics`,
);

const shutdown = async () => {
  console.log("Shutting down server...");

  await redis.quit();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
