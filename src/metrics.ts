import { Counter, Gauge, Registry } from "prom-client";

// Create a custom registry
export const register = new Registry();

// Gauge for active connections
export const connectionsGauge = new Gauge({
  name: "nostr_connections_active",
  help: "Current WebSocket connections",
  registers: [register],
});

// Counter for events received
export const eventsReceivedCounter = new Counter({
  name: "nostr_events_received",
  help: "Total events received",
  registers: [register],
});

// Counter for events stored
export const eventsStoredCounter = new Counter({
  name: "nostr_events_stored",
  help: "Total events successfully stored",
  registers: [register],
});

// Counter for events failed
export const eventsFailedCounter = new Counter({
  name: "nostr_events_failed",
  help: "Total events failed to store",
  registers: [register],
});

// Counter for events rate limited
export const eventsRateLimitedCounter = new Counter({
  name: "nostr_events_rate_limited",
  help: "Total events rate limited",
  registers: [register],
});

// Counter for invalid events
export const eventsInvalidCounter = new Counter({
  name: "nostr_events_invalid",
  help: "Total events invalid",
  registers: [register],
});

// Counter for rejected events
export const eventsRejectedCounter = new Counter({
  name: "nostr_events_rejected",
  help: "Total events rejected",
  registers: [register],
});

// Counter for queries
export const queriesCounter = new Counter({
  name: "nostr_queries_total",
  help: "Total queries processed",
  registers: [register],
});

// Gauge for active subscriptions
export const subscriptionsGauge = new Gauge({
  name: "nostr_subscriptions_active",
  help: "Current active subscriptions",
  registers: [register],
});

export async function getMetrics(): Promise<string> {
  return await register.metrics();
}
