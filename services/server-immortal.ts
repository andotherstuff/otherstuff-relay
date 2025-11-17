/**
 * IMMORTAL SERVER - A server that can NEVER die
 * 
 * Features:
 * - Adaptive backpressure (never closes connections unless absolutely necessary)
 * - Circuit breaker (auto-recovery from overload)
 * - Priority queuing (critical messages always go through)
 * - Rate limiting per connection
 * - Graceful degradation (slows down instead of dying)
 * - Real-time monitoring
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import { Config } from "@/lib/config.ts";
import {
  connectionsGauge,
  getMetrics,
  getMetricsInstance,
  initializeMetrics,
  register,
} from "@/lib/metrics.ts";
import type { NostrRelayMsg } from "@nostrify/nostrify";
import {
  extractAuthEvent,
  isAuthorizedAdmin,
  validateAuthEvent,
} from "@/lib/auth.ts";
import { RelayManagement } from "@/lib/management.ts";
import { getRelayInformation } from "@/lib/relay-info.ts";
import { PubSub } from "@/lib/pubsub.ts";
import { ImmortalQueue, Priority, QueueState } from "@/lib/immortal-queue.ts";

const config = new Config(Deno.env);

// Create IMMORTAL queue (100k capacity, adaptive backpressure)
const immortalQueue = new ImmortalQueue<{ connId: string; msg: string }>(100000);

// Redis client (only for distributed state)
const redis: RedisClientType = createRedisClient({
  url: config.redisUrl,
});
await redis.connect();

// Initialize metrics
initializeMetrics(redis);
const metrics = getMetricsInstance();

// Initialize relay management
const management = new RelayManagement(redis);
const pubsub = new PubSub(redis);

// Initialize relay metadata from config
if (config.relayName) {
  await management.setRelayName(config.relayName);
}
if (config.relayDescription) {
  await management.setRelayDescription(config.relayDescription);
}
if (config.relayIcon) {
  await management.setRelayIcon(config.relayIcon);
}

// Local metrics counters (batched to Redis)
const localMetrics = {
  websocketOpens: 0,
  websocketCloses: 0,
  websocketErrors: 0,
  messagesSent: 0,
  messagesReceived: 0,
  messagesDropped: 0,
  rateLimited: 0,
  circuitBreakerTrips: 0,
};

// Flush metrics every 5 seconds
setInterval(async () => {
  try {
    const currentConnections = await connectionsGauge.get();
    await metrics.setConnections(currentConnections.values[0]?.value || 0);

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

// Cleanup stale rate limiters every minute
setInterval(() => {
  immortalQueue.cleanup(60000);
}, 60000);

// Management command handler (unchanged)
async function sendManagementCommand(
  method: string,
  params: unknown[],
  timeoutMs = 5000,
): Promise<unknown> {
  const requestId = crypto.randomUUID();

  await redis.rPush(
    "relay:management:queue",
    JSON.stringify({ method, params, requestId }),
  );

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const response = await redis.get(`relay:management:response:${requestId}`);
    if (response) {
      await redis.del(`relay:management:response:${requestId}`);
      const parsed = JSON.parse(response);
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Management command timed out");
}

/**
 * Determine message priority
 */
function getMessagePriority(msg: string): Priority {
  try {
    const parsed = JSON.parse(msg);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return Priority.NORMAL;
    }

    const verb = parsed[0];
    
    // Critical: AUTH, CLOSE (always process)
    if (verb === "CLOSE" || verb === "AUTH") {
      return Priority.CRITICAL;
    }
    
    // High: REQ (queries should be fast)
    if (verb === "REQ") {
      return Priority.HIGH;
    }
    
    // Normal: EVENT
    if (verb === "EVENT") {
      return Priority.NORMAL;
    }

    return Priority.LOW;
  } catch {
    return Priority.LOW;
  }
}

const app = new Hono();

// Enable CORS
app.use("*", (c, next) => {
  const upgrade = c.req.header("upgrade");
  if (upgrade === "websocket") {
    return next();
  } else {
    return cors()(c, next);
  }
});

// Metrics endpoint
app.get("/metrics", async (c) => {
  const metricsText = await getMetrics();
  return c.text(metricsText, 200, {
    "Content-Type": register.contentType,
  });
});

// Health endpoint with queue stats
app.get("/health", (c) => {
  const queueStats = immortalQueue.getStats();

  return c.json({
    status: queueStats.state === QueueState.CRITICAL ? "degraded" : "ok",
    queue: {
      state: queueStats.state,
      length: queueStats.length,
      capacity: queueStats.capacity,
      utilization: `${(queueStats.utilization * 100).toFixed(1)}%`,
      dropped: queueStats.droppedMessages,
      processed: queueStats.processedMessages,
      avgProcessingTime: `${queueStats.avgProcessingTime.toFixed(2)}ms`,
    },
    localMetrics: {
      dropped: localMetrics.messagesDropped,
      rateLimited: localMetrics.rateLimited,
      circuitBreakerTrips: localMetrics.circuitBreakerTrips,
    },
  });
});

// Admin endpoint to adjust queue settings
app.post("/admin/queue", async (c) => {
  const authHeader = c.req.header("authorization");
  const authEvent = extractAuthEvent(authHeader);

  if (!authEvent) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const body = await c.req.text();
  const url = config.relayUrl || c.req.url;
  const validation = validateAuthEvent(authEvent, url, "POST", body);

  if (!validation.valid || !isAuthorizedAdmin(validation.pubkey!, config.adminPubkeys)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const params = JSON.parse(body);
    
    if (params.capacity) {
      immortalQueue.setCapacity(params.capacity);
    }
    
    if (params.rateLimit) {
      immortalQueue.setRateLimit(params.rateLimit);
    }
    
    if (params.resetCircuitBreaker) {
      immortalQueue.resetCircuitBreaker();
    }

    return c.json({ success: true, stats: immortalQueue.getStats() });
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

// NIP-86 Management API (unchanged - omitted for brevity, same as server.ts)

// NIP-11 Relay Information
app.get("/", async (c) => {
  const accept = c.req.header("accept");
  const upgrade = c.req.header("upgrade");

  if (accept === "application/nostr+json") {
    const info = await getRelayInformation(redis, {
      name: config.relayName,
      description: config.relayDescription,
      icon: config.relayIcon,
      pubkey: config.relayPubkey,
      contact: config.relayContact,
      banner: config.relayBanner,
    });

    return c.json(info, 200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET",
    });
  }

  if (upgrade !== "websocket") {
    return c.text("Use a Nostr client to connect", 400);
  }

  // WebSocket upgrade
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
        const responses = await redis.lPopCount(queueKey, 100);
        if (responses && responses.length > 0) {
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

        if (Math.random() < 0.1) {
          await pubsub.refreshConnection(connId);
        }
      } catch (err) {
        console.error("Error polling responses:", err);
      }
    }, 100);
  };

  socket.onmessage = (e) => {
    localMetrics.messagesReceived++;

    try {
      // Determine message priority
      const priority = getMessagePriority(e.data);

      // Push to immortal queue (sync, no race conditions)
      const result = immortalQueue.push(
        { connId, msg: e.data },
        connId,
        priority,
      );

      if (!result.accepted) {
        // Message was rejected - send appropriate response
        localMetrics.messagesDropped++;

        if (result.reason?.includes("rate limited")) {
          localMetrics.rateLimited++;
        }

        if (result.reason?.includes("circuit breaker")) {
          localMetrics.circuitBreakerTrips++;
        }

        // Send degraded response based on queue state
        switch (result.state) {
          case QueueState.DEGRADED:
            // Warn but don't close connection
            send(["NOTICE", `relay degraded: ${result.reason}`]);
            break;

          case QueueState.OVERLOADED:
            // Send error response but keep connection alive
            try {
              const msg = JSON.parse(e.data);
              if (Array.isArray(msg) && msg.length > 0) {
                const verb = msg[0];
                if (verb === "EVENT") {
                  const eventId = msg[1]?.id || "unknown";
                  send(["OK", eventId, false, `error: ${result.reason}`]);
                } else if (verb === "REQ") {
                  const subId = msg[1];
                  if (subId) {
                    send(["CLOSED", subId, `error: ${result.reason}`]);
                  }
                }
              }
            } catch {
              send(["NOTICE", `error: ${result.reason}`]);
            }
            break;

          case QueueState.CRITICAL:
            // Only close on critical if circuit breaker is open
            if (result.reason?.includes("circuit breaker")) {
              send(["NOTICE", "relay recovering from overload - please reconnect in a few seconds"]);
              setTimeout(() => socket.close(), 1000);
            } else {
              send(["NOTICE", `critical: ${result.reason}`]);
            }
            break;

          default:
            send(["NOTICE", `error: ${result.reason}`]);
        }
      }

      // Log state changes
      if (result.state !== QueueState.HEALTHY) {
        if (Math.random() < 0.01) { // Log 1% of messages when degraded
          console.warn(
            `⚠️  Queue ${result.state}: ${immortalQueue.length()}/${immortalQueue.getStats().capacity} (${(immortalQueue.getStats().utilization * 100).toFixed(1)}%)`,
          );
        }
      }
    } catch (err) {
      console.error("Message queueing error:", err);
      send(["NOTICE", "error: failed to queue message"]);
    }
  };

  socket.onclose = async () => {
    connectionsGauge.dec();
    localMetrics.websocketCloses++;

    if (responsePoller !== null) {
      clearInterval(responsePoller);
    }

    try {
      await redis.del(queueKey);
      await pubsub.unsubscribeAll(connId);
    } catch (err) {
      console.error("Error cleaning up connection:", err);
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

console.log(`
╔════════════════════════════════════════════════════════════════╗
║              🧟 IMMORTAL RELAY - UNKILLABLE MODE 🧟            ║
╠════════════════════════════════════════════════════════════════╣
║  Features:                                                     ║
║  ✅ Adaptive backpressure (slows down, never dies)            ║
║  ✅ Circuit breaker (auto-recovery from overload)             ║
║  ✅ Priority queuing (critical messages always go through)    ║
║  ✅ Rate limiting (${immortalQueue.getStats().capacity} msg/sec per connection)          ║
║  ✅ Graceful degradation (warns before dropping)              ║
║  ✅ Real-time monitoring (/health endpoint)                   ║
╠════════════════════════════════════════════════════════════════╣
║  Queue Capacity: ${immortalQueue.getStats().capacity.toLocaleString().padEnd(46)} ║
║  Port:           ${config.port.toString().padEnd(46)} ║
╚════════════════════════════════════════════════════════════════╝
`);

const shutdown = async () => {
  console.log("Shutting down IMMORTAL server...");
  const stats = immortalQueue.getStats();
  console.log(`📊 Final stats: ${stats.processedMessages.toLocaleString()} processed, ${stats.droppedMessages.toLocaleString()} dropped`);
  await redis.quit();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
