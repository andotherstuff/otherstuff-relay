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
import type { NostrRelayMsg } from "@nostrify/nostrify";

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
  let responsePoller: number | null = null;
  const queueKey = `nostr:responses:${connId}`;

  socket.onopen = () => {
    connectionsGauge.inc();
    localMetrics.websocketOpens++;

    // Start polling for responses from relay workers
    responsePoller = setInterval(async () => {
      try {
        // Non-blocking pop of responses
        const responses = await redis.lPopCount(queueKey, 100);
        if (responses && responses.length > 0) {
          // Reset TTL since we're actively consuming - this is a live connection
          await redis.expire(queueKey, 5);

          for (const responseJson of responses) {
            try {
              const msg = JSON.parse(responseJson);
              send(msg);
            } catch (err) {
              console.error("Error parsing response:", err);
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
      send(["NOTICE", "error: failed to queue message"]);
    }
  };

  socket.onclose = async () => {
    connectionsGauge.dec();
    localMetrics.websocketCloses++;

    // Stop polling for responses
    if (responsePoller !== null) {
      clearInterval(responsePoller);
    }

    // Clean up response queue in Redis
    try {
      await redis.del(queueKey);
    } catch (err) {
      console.error("Error cleaning up connection data:", err);
    }
  };

  socket.onerror = (err) => {
    localMetrics.websocketErrors++;
    if (Deno.env.get("DEBUG")) {
      console.error("WebSocket error:", err);
    }
  };

  function send(msg: NostrRelayMsg) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        localMetrics.messagesSent++;
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
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
