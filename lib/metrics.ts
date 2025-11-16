import { Counter, Gauge, Registry } from "prom-client";

// Create a custom registry
export const register = new Registry();

// Redis keys for metrics
const METRICS_KEYS = {
  connections_active: "nostr:metrics:connections_active",
  events_received: "nostr:metrics:events_received",
  events_stored: "nostr:metrics:events_stored",
  events_failed: "nostr:metrics:events_failed",
  events_invalid: "nostr:metrics:events_invalid",
  events_rejected: "nostr:metrics:events_rejected",
  queries_total: "nostr:metrics:queries_total",
  subscriptions_active: "nostr:metrics:subscriptions_active",
  events_by_kind: "nostr:metrics:events_by_kind",
  websocket_opens: "nostr:metrics:websocket_opens",
  websocket_closes: "nostr:metrics:websocket_closes",
  websocket_errors: "nostr:metrics:websocket_errors",
  messages_sent: "nostr:metrics:messages_sent",
  messages_received: "nostr:metrics:messages_received",
  response_poller_invocations: "nostr:metrics:response_poller_invocations",
} as const;

// Interface for Redis client methods we use
interface RedisClient {
  incrBy(key: string, increment: number): Promise<number>;
  set(key: string, value: string | number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  mGet(keys: string[]): Promise<(string | null)[]>;
}

// Local metrics for the server process
export const connectionsGauge = new Gauge({
  name: "nostr_connections_active",
  help: "Current WebSocket connections",
  registers: [register],
});

export const subscriptionsGauge = new Gauge({
  name: "nostr_subscriptions_active",
  help: "Current active subscriptions",
  registers: [register],
});

// Create all metric objects once to avoid memory leaks
const eventsReceivedCounter = new Counter({
  name: "nostr_events_received",
  help: "Total events received",
  registers: [register],
});

const eventsStoredCounter = new Counter({
  name: "nostr_events_stored",
  help: "Total events successfully stored",
  registers: [register],
});

const eventsFailedCounter = new Counter({
  name: "nostr_events_failed",
  help: "Total events failed to store",
  registers: [register],
});

const eventsInvalidCounter = new Counter({
  name: "nostr_events_invalid",
  help: "Total events invalid",
  registers: [register],
});

const eventsRejectedCounter = new Counter({
  name: "nostr_events_rejected",
  help: "Total events rejected",
  registers: [register],
});

const queriesTotalCounter = new Counter({
  name: "nostr_queries_total",
  help: "Total queries processed",
  registers: [register],
});

const webSocketOpensCounter = new Counter({
  name: "nostr_websocket_opens_total",
  help: "Total WebSocket connections opened",
  registers: [register],
});

const webSocketClosesCounter = new Counter({
  name: "nostr_websocket_closes_total",
  help: "Total WebSocket connections closed",
  registers: [register],
});

const webSocketErrorsCounter = new Counter({
  name: "nostr_websocket_errors_total",
  help: "Total WebSocket errors",
  registers: [register],
});

const messagesSentCounter = new Counter({
  name: "nostr_messages_sent_total",
  help: "Total messages sent to clients",
  registers: [register],
});

const messagesReceivedCounter = new Counter({
  name: "nostr_messages_received_total",
  help: "Total messages received from clients",
  registers: [register],
});

const responsePollerInvocationsCounter = new Counter({
  name: "nostr_response_poller_invocations_total",
  help: "Total response poller invocations",
  registers: [register],
});

const eventsByKindCounter = new Counter({
  name: "nostr_events_by_kind_total",
  help: "Total events received by kind",
  labelNames: ["kind"],
  registers: [register],
});

// Redis-based metrics class
export class RedisMetrics {
  private redis: RedisClient;

  constructor(redisClient: RedisClient) {
    this.redis = redisClient;
  }

  async incrementConnections(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.connections_active, delta);
  }

  async setConnections(value: number): Promise<void> {
    await this.redis.set(METRICS_KEYS.connections_active, value);
  }

  async incrementEventsReceived(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.events_received, delta);
  }

  async incrementEventsStored(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.events_stored, delta);
  }

  async incrementEventsFailed(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.events_failed, delta);
  }

  async incrementEventsInvalid(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.events_invalid, delta);
  }

  async incrementEventsRejected(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.events_rejected, delta);
  }

  async incrementWebSocketOpens(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.websocket_opens, delta);
  }

  async incrementWebSocketCloses(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.websocket_closes, delta);
  }

  async incrementWebSocketErrors(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.websocket_errors, delta);
  }

  async incrementMessagesSent(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.messages_sent, delta);
  }

  async incrementMessagesReceived(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.messages_received, delta);
  }

  async incrementResponsePollerInvocations(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.response_poller_invocations, delta);
  }

  async incrementQueriesTotal(delta: number = 1): Promise<void> {
    await this.redis.incrBy(METRICS_KEYS.queries_total, delta);
  }

  async setSubscriptions(value: number): Promise<void> {
    await this.redis.set(METRICS_KEYS.subscriptions_active, value);
  }

  async getConnections(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.connections_active);
    return value ? parseInt(value, 10) : 0;
  }

  async getSubscriptions(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.subscriptions_active);
    return value ? parseInt(value, 10) : 0;
  }

  async getEventsReceived(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.events_received);
    return value ? parseInt(value, 10) : 0;
  }

  async getEventsStored(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.events_stored);
    return value ? parseInt(value, 10) : 0;
  }

  async getEventsFailed(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.events_failed);
    return value ? parseInt(value, 10) : 0;
  }

  async getEventsInvalid(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.events_invalid);
    return value ? parseInt(value, 10) : 0;
  }

  async getEventsRejected(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.events_rejected);
    return value ? parseInt(value, 10) : 0;
  }

  async getWebSocketOpens(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.websocket_opens);
    return value ? parseInt(value, 10) : 0;
  }

  async getWebSocketCloses(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.websocket_closes);
    return value ? parseInt(value, 10) : 0;
  }

  async getWebSocketErrors(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.websocket_errors);
    return value ? parseInt(value, 10) : 0;
  }

  async getMessagesSent(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.messages_sent);
    return value ? parseInt(value, 10) : 0;
  }

  async getMessagesReceived(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.messages_received);
    return value ? parseInt(value, 10) : 0;
  }

  async getResponsePollerInvocations(): Promise<number> {
    const value = await this.redis.get(
      METRICS_KEYS.response_poller_invocations,
    );
    return value ? parseInt(value, 10) : 0;
  }

  async getQueriesTotal(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.queries_total);
    return value ? parseInt(value, 10) : 0;
  }

  async incrementEventByKind(kind: number, delta: number = 1): Promise<void> {
    await this.redis.hIncrBy(
      METRICS_KEYS.events_by_kind,
      kind.toString(),
      delta,
    );
  }

  async getEventsByKind(): Promise<Record<string, number>> {
    const hashData = await this.redis.hGetAll(METRICS_KEYS.events_by_kind);
    const result: Record<string, number> = {};

    for (const [kind, count] of Object.entries(hashData)) {
      result[kind] = typeof count === "string" ? parseInt(count, 10) : 0;
    }

    return result;
  }

  async getAllMetrics(): Promise<Record<string, number>> {
    const keys = Object.values(METRICS_KEYS).filter((k) =>
      k !== METRICS_KEYS.events_by_kind
    );
    const values = await this.redis.mGet(keys);

    const metrics: Record<string, number> = {};
    let valueIndex = 0;

    for (const [key, redisKey] of Object.entries(METRICS_KEYS)) {
      if (redisKey !== METRICS_KEYS.events_by_kind) {
        metrics[key] = values[valueIndex]
          ? parseInt(values[valueIndex] as string, 10)
          : 0;
        valueIndex++;
      }
    }

    return metrics;
  }
}

// Global metrics instance (will be initialized)
let metricsInstance: RedisMetrics;

// Initialize metrics with Redis client and return the instance
export function initializeMetrics(redisClient: RedisClient): RedisMetrics {
  metricsInstance = new RedisMetrics(redisClient);
  return metricsInstance;
}

// Export a function to get the metrics instance
export function getMetricsInstance(): RedisMetrics {
  if (!metricsInstance) {
    throw new Error("Metrics not initialized. Call initializeMetrics() first.");
  }
  return metricsInstance;
}

// Track the last values we set to avoid resetting counters
const lastMetricsValues: Record<string, number> = {};
const lastEventsByKind: Record<string, number> = {};

export async function getMetrics(): Promise<string> {
  // Get metrics instance
  const metrics = getMetricsInstance();

  // Get all metrics from Redis
  const allMetrics = await metrics.getAllMetrics();
  const eventsByKind = await metrics.getEventsByKind();

  // Update gauges with Redis values (these can be set directly)
  connectionsGauge.set(allMetrics.connections_active);
  subscriptionsGauge.set(allMetrics.subscriptions_active);

  // For counters, we need to increment by the delta since last read
  // Prometheus counters can only go up, so we track what we've already reported
  const incrementCounter = (
    counter: Counter,
    key: string,
    newValue: number,
  ) => {
    const lastValue = lastMetricsValues[key] || 0;
    const delta = newValue - lastValue;
    if (delta > 0) {
      counter.inc(delta);
      lastMetricsValues[key] = newValue;
    }
  };

  incrementCounter(
    eventsReceivedCounter,
    "events_received",
    allMetrics.events_received,
  );
  incrementCounter(
    eventsStoredCounter,
    "events_stored",
    allMetrics.events_stored,
  );
  incrementCounter(
    eventsFailedCounter,
    "events_failed",
    allMetrics.events_failed,
  );
  incrementCounter(
    eventsInvalidCounter,
    "events_invalid",
    allMetrics.events_invalid,
  );
  incrementCounter(
    eventsRejectedCounter,
    "events_rejected",
    allMetrics.events_rejected,
  );
  incrementCounter(
    queriesTotalCounter,
    "queries_total",
    allMetrics.queries_total,
  );
  incrementCounter(
    webSocketOpensCounter,
    "websocket_opens",
    allMetrics.websocket_opens || 0,
  );
  incrementCounter(
    webSocketClosesCounter,
    "websocket_closes",
    allMetrics.websocket_closes || 0,
  );
  incrementCounter(
    webSocketErrorsCounter,
    "websocket_errors",
    allMetrics.websocket_errors || 0,
  );
  incrementCounter(
    messagesSentCounter,
    "messages_sent",
    allMetrics.messages_sent || 0,
  );
  incrementCounter(
    messagesReceivedCounter,
    "messages_received",
    allMetrics.messages_received || 0,
  );
  incrementCounter(
    responsePollerInvocationsCounter,
    "response_poller_invocations",
    allMetrics.response_poller_invocations || 0,
  );

  // Update events by kind counter
  for (const [kind, count] of Object.entries(eventsByKind)) {
    const lastCount = lastEventsByKind[kind] || 0;
    const delta = count - lastCount;
    if (delta > 0) {
      eventsByKindCounter.inc({ kind }, delta);
      lastEventsByKind[kind] = count;
    }
  }

  return await register.metrics();
}
