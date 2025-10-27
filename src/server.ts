import { Hono } from "hono";
import { NostrRelay } from "./relay.ts";
import { shutdown as clickhouseShutdown } from "./clickhouse.ts";
import { config } from "./config.ts";
import { connectionsGauge, getMetrics, register } from "./metrics.ts";
import type { ClientMessage, Event, RelayMessage } from "./types.ts";

const app = new Hono();
const relay = new NostrRelay();

await relay.init();

// Metrics endpoint
if (config.metrics.enabled) {
  app.get(config.metrics.path, async (c) => {
    const metricsText = await getMetrics();
    return c.text(metricsText, 200, {
      "Content-Type": register.contentType,
    });
  });
}

// Health endpoint
app.get("/health", (c) => {
  return c.json(relay.health());
});

// WebSocket endpoint
app.get("/", (c) => {
  const upgrade = c.req.header("upgrade");
  if (upgrade !== "websocket") {
    return c.text("Use a Nostr client to connect", 400);
  }

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  const connId = crypto.randomUUID();

  socket.onopen = () => {
    connectionsGauge.inc();
  };

  socket.onmessage = async (e) => {
    try {
      const msg: ClientMessage = JSON.parse(e.data);

      switch (msg[0]) {
        case "EVENT": {
          const event = msg[1];
          const [ok, message] = await relay.handleEvent(event, connId);
          send(["OK", event.id, ok, message]);
          break;
        }

        case "REQ": {
          const [_, subId, ...filters] = msg;
          await relay.handleReq(
            connId,
            subId,
            filters,
            (event: Event) => send(["EVENT", subId, event]),
            () => send(["EOSE", subId]),
          );
          break;
        }

        case "CLOSE": {
          const [_, subId] = msg;
          relay.handleClose(connId, subId);
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

  socket.onclose = () => {
    connectionsGauge.dec();
    relay.handleDisconnect(connId);
  };

  socket.onerror = (err) => {
    if (Deno.env.get("DEBUG")) {
      console.error("WebSocket error:", err);
    } else {
      console.error("WebSocket connection error");
    }
  };

  function send(msg: RelayMessage) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    } catch (err) {
    }
  }

  return response;
});

console.log(`🔧 Initializing Nostr relay...`);
console.log(
  `📊 Metrics: http://localhost:${config.port}${config.metrics.path}`,
);
console.log(
  `🔐 Verification: ${config.verification.enabled ? "enabled" : "disabled"}`,
);

const shutdown = async () => {
  console.log("Shutting down...");
  await relay.close();
  await clickhouseShutdown();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
