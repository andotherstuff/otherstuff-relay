// Clean, fast Nostr relay server
import { Hono } from 'https://deno.land/x/hono@v3.12.11/mod.ts';
import { NostrRelay } from './relay.ts';
import { config } from './config.ts';
import { metrics, getMetrics } from './metrics.ts';
import type { ClientMessage, RelayMessage, Event } from './types.ts';

const app = new Hono();
const relay = new NostrRelay();

await relay.init();

// Metrics endpoint
if (config.metrics.enabled) {
  app.get(config.metrics.path, async (c) => {
    return c.text(await getMetrics(), 200, {
      'Content-Type': 'text/plain; version=0.0.4',
    });
  });
}

// Health endpoint
app.get('/health', (c) => {
  return c.json(relay.health());
});

// WebSocket endpoint
app.get('/', (c) => {
  const upgrade = c.req.header('upgrade');
  if (upgrade !== 'websocket') {
    return c.text('Use a Nostr client to connect', 400);
  }

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
  const connId = crypto.randomUUID();

  socket.onopen = () => {
    metrics.connections.inc();
  };

  socket.onmessage = async (e) => {
    try {
      const msg: ClientMessage = JSON.parse(e.data);
      
      switch (msg[0]) {
        case 'EVENT': {
          const event = msg[1];
          const [ok, message] = await relay.handleEvent(event);
          send(['OK', event.id, ok, message]);
          break;
        }

        case 'REQ': {
          const [_, subId, ...filters] = msg;
          await relay.handleReq(
            connId,
            subId,
            filters,
            (event: Event) => send(['EVENT', subId, event]),
            () => send(['EOSE', subId])
          );
          break;
        }

        case 'CLOSE': {
          const [_, subId] = msg;
          relay.handleClose(connId, subId);
          break;
        }

        default:
          send(['NOTICE', 'unknown command']);
      }
    } catch (err) {
      console.error('Message error:', err);
      send(['NOTICE', 'invalid message']);
    }
  };

  socket.onclose = () => {
    metrics.connections.dec();
    relay.handleDisconnect(connId);
  };

  socket.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  function send(msg: RelayMessage) {
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      // Socket closed, ignore
    }
  }

  return response;
});

// Start server
if (import.meta.main) {
  Deno.serve({
    port: config.port,
    hostname: '0.0.0.0',
    // Leverage Deno's parallelism for maximum throughput
    handler: app.fetch,
  });

  console.log(`🚀 Nostr relay running on port ${config.port}`);
  console.log(`📊 Metrics: http://localhost:${config.port}${config.metrics.path}`);
  console.log(`🔐 Verification: ${config.verification.enabled ? 'enabled' : 'disabled'}`);
  console.log(`🔄 Parallel queries: enabled`);
}

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down...');
  await relay.close();
  Deno.exit(0);
};

Deno.addSignalListener('SIGINT', shutdown);
Deno.addSignalListener('SIGTERM', shutdown);

export default app;
