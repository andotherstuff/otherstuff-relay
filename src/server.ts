import { Hono } from "hono";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import {
  connectionsGauge,
  getMetrics,
  getMetricsInstance,
  initializeMetrics,
  messagesReceivedCounter,
  messagesSentCounter,
  register,
  responsePollerInvocationsCounter,
  webSocketClosesCounter,
  webSocketErrorsCounter,
  webSocketOpensCounter,
} from "./metrics.ts";
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
    metrics.incrementConnections();
    metrics.incrementWebSocketOpens();
    connectionsGauge.inc();
    webSocketOpensCounter.inc();

    // Start polling for responses from relay workers
    responsePoller = setInterval(async () => {
      // Track poller invocation
      metrics.incrementResponsePollerInvocations();
      responsePollerInvocationsCounter.inc();

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
    }, 10); // Poll every 10ms for low latency
  };

  socket.onmessage = async (e) => {
    // Track message received
    metrics.incrementMessagesReceived();
    messagesReceivedCounter.inc();

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
    metrics.incrementWebSocketCloses();
    connectionsGauge.dec();
    webSocketClosesCounter.inc();

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
    metrics.incrementWebSocketErrors();
    webSocketErrorsCounter.inc();
    if (Deno.env.get("DEBUG")) {
      console.error("WebSocket error:", err);
    }
  };

  function send(msg: NostrRelayMsg) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        // Track message sent
        metrics.incrementMessagesSent();
        messagesSentCounter.inc();

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
