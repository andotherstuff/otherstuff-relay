/**
 * Optimized WebSocket server - uses in-memory channels instead of Redis queues
 * Minimal overhead for message routing
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
import { createSharedState, ConnectionManager } from "@/lib/worker-pool.ts";
import type { SharedState } from "@/lib/worker-pool.ts";

const config = new Config(Deno.env);

// Create shared state for workers
const sharedState: SharedState = createSharedState();

// Connection manager (in-memory)
const connectionManager = new ConnectionManager();

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

// Health endpoint
app.get("/health", (c) => {
  const connStats = connectionManager.stats();
  const channelStats = sharedState.responses.stats();

  return c.json({
    status: "ok",
    connections: connStats.connections,
    subscriptions: connStats.totalSubscriptions,
    queuedMessages: channelStats.totalQueued,
    stats: sharedState.stats,
  });
});

// NIP-86 Management API (unchanged)
app.post("/", async (c) => {
  const contentType = c.req.header("content-type");

  if (contentType !== "application/nostr+json+rpc") {
    return c.text("Invalid Content-Type", 400);
  }

  const authHeader = c.req.header("authorization");
  const authEvent = extractAuthEvent(authHeader);

  if (!authEvent) {
    return c.json(
      { error: "Missing or invalid Authorization header" },
      401,
    );
  }

  const body = await c.req.text();
  const url = config.relayUrl || c.req.url;
  const validation = validateAuthEvent(authEvent, url, "POST", body);

  if (!validation.valid) {
    return c.json({ error: validation.error }, 401);
  }

  if (!isAuthorizedAdmin(validation.pubkey!, config.adminPubkeys)) {
    return c.json(
      { error: "Unauthorized: not an admin pubkey" },
      401,
    );
  }

  let request: { method: string; params?: unknown[] };
  try {
    request = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!request.method) {
    return c.json({ error: "Missing method" }, 400);
  }

  const params = request.params || [];

  console.log(
    `[NIP-86] ${validation.pubkey} called ${request.method} with params:`,
    params,
  );

  try {
    let result: unknown;

    switch (request.method) {
      case "supportedmethods":
        result = management.getSupportedMethods();
        break;

      case "banpubkey":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid pubkey parameter" }, 400);
        }
        result = await sendManagementCommand("banpubkey", params);
        break;

      case "listbannedpubkeys":
        result = await management.listBannedPubkeys();
        break;

      case "allowpubkey":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid pubkey parameter" }, 400);
        }
        result = await management.allowPubkey(
          params[0],
          params[1] as string | undefined,
        );
        break;

      case "listallowedpubkeys":
        result = await management.listAllowedPubkeys();
        break;

      case "banevent":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid event id parameter" }, 400);
        }
        result = await sendManagementCommand("banevent", params);
        break;

      case "allowevent":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid event id parameter" }, 400);
        }
        result = await management.allowEvent(params[0]);
        break;

      case "listbannedevents":
        result = await management.listBannedEvents();
        break;

      case "allowkind":
        if (typeof params[0] !== "number") {
          return c.json({ error: "Invalid kind parameter" }, 400);
        }
        result = await management.allowKind(params[0]);
        break;

      case "disallowkind":
        if (typeof params[0] !== "number") {
          return c.json({ error: "Invalid kind parameter" }, 400);
        }
        result = await management.disallowKind(params[0]);
        break;

      case "listallowedkinds":
        result = await management.listAllowedKinds();
        break;

      case "blockip":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid IP parameter" }, 400);
        }
        result = await management.blockIP(
          params[0],
          params[1] as string | undefined,
        );
        break;

      case "unblockip":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid IP parameter" }, 400);
        }
        result = await management.unblockIP(params[0]);
        break;

      case "listblockedips":
        result = await management.listBlockedIPs();
        break;

      case "changerelayname":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid name parameter" }, 400);
        }
        result = await management.setRelayName(params[0]);
        break;

      case "changerelaydescription":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid description parameter" }, 400);
        }
        result = await management.setRelayDescription(params[0]);
        break;

      case "changerelayicon":
        if (typeof params[0] !== "string") {
          return c.json({ error: "Invalid icon parameter" }, 400);
        }
        result = await management.setRelayIcon(params[0]);
        break;

      default:
        return c.json({ error: `Unknown method: ${request.method}` }, 400);
    }

    return c.json({ result });
  } catch (err) {
    console.error(`[NIP-86] Error executing ${request.method}:`, err);
    return c.json(
      {
        error: `Internal error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      500,
    );
  }
});

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

  // Get response channel for this connection
  const responseChannel = sharedState.responses.getChannel(connId);

  // Response consumer loop
  let responseConsumer: number | null = null;

  socket.onopen = () => {
    connectionsGauge.inc();
    localMetrics.websocketOpens++;
    sharedState.stats.activeConnections++;

    // Add connection to manager
    connectionManager.add(connId);

    // Start consuming responses from the channel (non-blocking)
    responseConsumer = setInterval(async () => {
      try {
        // Non-blocking pop with short timeout
        const messages = await responseChannel.pop(100, 10);

        for (const msg of messages) {
          send(msg as NostrRelayMsg);
        }

        // Refresh subscription TTLs periodically
        if (Math.random() < 0.1) {
          await pubsub.refreshConnection(connId);
        }
      } catch (err) {
        console.error("Error consuming responses:", err);
      }
    }, 10); // Poll every 10ms for low latency
  };

  socket.onmessage = (e) => {
    localMetrics.messagesReceived++;
    connectionManager.touch(connId);

    try {
      // Check backpressure
      const queueLength = sharedState.clientMessages.length();
      if (queueLength > 1000) {
        console.warn(`Queue overloaded (${queueLength}), closing ${connId}`);
        send(["NOTICE", "relay is overloaded, please try again later"]);
        socket.close();
        return;
      }

      // Push message to channel (instant, non-blocking)
      const success = sharedState.clientMessages.push({
        connId,
        msg: e.data,
      });

      if (!success) {
        send(["NOTICE", "relay is experiencing high load"]);
      }
    } catch (err) {
      console.error("Message queueing error:", err);
      send(["NOTICE", "error: failed to queue message"]);
    }
  };

  socket.onclose = async () => {
    connectionsGauge.dec();
    localMetrics.websocketCloses++;
    sharedState.stats.activeConnections--;

    // Stop response consumer
    if (responseConsumer !== null) {
      clearInterval(responseConsumer);
    }

    // Clean up connection state
    try {
      sharedState.responses.removeChannel(connId);
      connectionManager.remove(connId);
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

console.log(`🚀 Optimized Nostr relay server starting...`);
console.log(`📊 Metrics: http://localhost:${config.port}/metrics`);
console.log(`⚡ Using in-memory channels for maximum performance`);

const shutdown = async () => {
  console.log("Shutting down server...");
  await redis.quit();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Export shared state for workers
export { sharedState };
export default app;
