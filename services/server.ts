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

// Instantiate config with Deno.env
const config = new Config(Deno.env);

// Instantiate Redis client for queueing messages
const redis: RedisClientType = createRedisClient({
  url: config.redisUrl,
});

await redis.connect();

// Initialize metrics with Redis client
initializeMetrics(redis);

// Get metrics instance for use in this module
const metrics = getMetricsInstance();

// Initialize relay management
const management = new RelayManagement(redis);

// Initialize PubSub for subscription cleanup
const pubsub = new PubSub(redis);

// Initialize relay metadata from config if provided
if (config.relayName) {
  await management.setRelayName(config.relayName);
}
if (config.relayDescription) {
  await management.setRelayDescription(config.relayDescription);
}
if (config.relayIcon) {
  await management.setRelayIcon(config.relayIcon);
}

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

/**
 * Send a management command to the management worker and wait for response
 */
async function sendManagementCommand(
  method: string,
  params: unknown[],
  timeoutMs = 5000,
): Promise<unknown> {
  const requestId = crypto.randomUUID();

  // Queue the command
  await redis.rPush(
    "relay:management:queue",
    JSON.stringify({ method, params, requestId }),
  );

  // Wait for response with timeout
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const response = await redis.get(`relay:management:response:${requestId}`);
    if (response) {
      // Clean up response
      await redis.del(`relay:management:response:${requestId}`);

      const parsed = JSON.parse(response);
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      return parsed.result;
    }

    // Poll every 50ms
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Management command timed out");
}

const app = new Hono();

// Enable CORS for all routes except WebSocket upgrades
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
app.get("/health", async (c) => {
  const queueLength = await redis.lLen("nostr:relay:queue");
  const pubsubStats = await pubsub.getStats();

  return c.json({
    status: "ok",
    queueLength,
    subscriptions: pubsubStats,
  });
});

// NIP-86 Management API endpoint
app.post("/", async (c) => {
  const contentType = c.req.header("content-type");

  // Only handle management API requests
  if (contentType !== "application/nostr+json+rpc") {
    return c.text("Invalid Content-Type", 400);
  }

  // Extract and validate NIP-98 auth event
  const authHeader = c.req.header("authorization");
  const authEvent = extractAuthEvent(authHeader);

  if (!authEvent) {
    return c.json(
      { error: "Missing or invalid Authorization header" },
      401,
    );
  }

  // Get request body for payload validation
  const body = await c.req.text();

  // Use configured relay URL if provided, otherwise use request URL
  const url = config.relayUrl || c.req.url;

  // Validate auth event
  const validation = validateAuthEvent(authEvent, url, "POST", body);

  if (!validation.valid) {
    return c.json({ error: validation.error }, 401);
  }

  // Check if pubkey is authorized admin
  if (!isAuthorizedAdmin(validation.pubkey!, config.adminPubkeys)) {
    return c.json(
      { error: "Unauthorized: not an admin pubkey" },
      401,
    );
  }

  // Parse JSON-RPC request
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

  // Log management operation
  console.log(
    `[NIP-86] ${validation.pubkey} called ${request.method} with params:`,
    params,
  );

  // Dispatch to appropriate method
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
        // Send to management worker to delete events from OpenSearch
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
        // Send to management worker to delete event from OpenSearch
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

// NIP-11 Relay Information endpoint
app.get("/", async (c) => {
  const accept = c.req.header("accept");
  const upgrade = c.req.header("upgrade");

  // NIP-11: Return relay information if Accept header is application/nostr+json
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

  // WebSocket upgrade
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

        // Refresh subscription TTLs every 10 iterations (1 second)
        // This keeps active subscriptions alive
        if (Math.random() < 0.1) {
          await pubsub.refreshConnection(connId);
        }
      } catch (err) {
        console.error("Error polling responses:", err);
      }
    }, 100); // Poll every 100ms for balanced latency/performance
  };

  socket.onmessage = async (e) => {
    localMetrics.messagesReceived++;
    try {
      // Check queue length before pushing
      const queueLength = await redis.lLen("nostr:relay:queue");
      if (queueLength > 1000) {
        console.warn(
          `Queue length exceeded (${queueLength}), closing connection ${connId}`,
        );

        send(["NOTICE", "relay is overloaded, please try again later"]);

        // Parse the message to determine appropriate response
        try {
          const msg = JSON.parse(e.data) as unknown;
          if (Array.isArray(msg) && msg.length > 0) {
            const verb = msg[0];
            if (verb === "EVENT") {
              // Return false OK for EVENT messages
              const eventId = msg[1]?.id;
              if (eventId) {
                send([
                  "OK",
                  eventId,
                  false,
                  "error: relay is overloaded, please try again later",
                ]);
              }
            } else if (verb === "REQ") {
              // Return CLOSED for REQ messages
              const subId = msg[1];
              if (subId) {
                send([
                  "CLOSED",
                  subId,
                  "error: relay is overloaded, please try again later",
                ]);
              }
            }
          }
        } catch {
          // fallthrough
        }

        socket.close();
        return;
      }

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

    // Clean up response queue and subscriptions in Redis
    try {
      await redis.del(queueKey);
      await pubsub.unsubscribeAll(connId);
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
