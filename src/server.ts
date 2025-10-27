import { Hono } from "hono";
import { createClient } from "@clickhouse/client-web";
import { Config } from "./config.ts";
import { NostrRelay } from "./relay.ts";
import { connectionsGauge, getMetrics, register } from "./metrics.ts";
import type {
  NostrClientMsg,
  NostrEvent,
  NostrRelayMsg,
} from "@nostrify/nostrify";

// Instantiate config with Deno.env
const config = new Config(Deno.env);

// Instantiate ClickHouse client with config
const clickhouse = createClient({
  url: config.databaseUrl,
});

// Initialize ClickHouse database and tables
await clickhouse.query({
  query: `CREATE TABLE IF NOT EXISTS events (
    id String,
    pubkey String,
    created_at DateTime64(3),
    kind UInt32,
    tags Array(Array(String)),
    content String,
    sig String,
    event_date Date MATERIALIZED toDate(created_at),
    INDEX idx_pubkey pubkey TYPE bloom_filter GRANULARITY 1,
    INDEX idx_kind kind TYPE minmax GRANULARITY 1,
    INDEX idx_created_at created_at TYPE minmax GRANULARITY 1
  ) ENGINE = MergeTree()
  PARTITION BY toYYYYMM(event_date)
  ORDER BY (kind, created_at, id)
  SETTINGS index_granularity = 8192`,
});

// Instantiate relay with config and clickhouse
const relay = new NostrRelay(config, clickhouse);

const app = new Hono();

// Metrics endpoint
app.get("/metrics", async (c) => {
  const metricsText = await getMetrics();
  return c.text(metricsText, 200, {
    "Content-Type": register.contentType,
  });
});

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
      const msg: NostrClientMsg = JSON.parse(e.data);

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
            (event: NostrEvent) => send(["EVENT", subId, event]),
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

  function send(msg: NostrRelayMsg) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    } catch {
      // fallthrough
    }
  }

  return response;
});

console.log(`🔧 Initializing Nostr relay...`);
console.log(
  `📊 Metrics: http://localhost:${config.port}/metrics`,
);

const shutdown = async () => {
  console.log("Shutting down...");
  await relay.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

export default app;
