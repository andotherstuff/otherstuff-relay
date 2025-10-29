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

  async getQueriesTotal(): Promise<number> {
    const value = await this.redis.get(METRICS_KEYS.queries_total);
    return value ? parseInt(value, 10) : 0;
  }

  async incrementEventByKind(kind: number, delta: number = 1): Promise<void> {
    await this.redis.hIncrBy(METRICS_KEYS.events_by_kind, kind.toString(), delta);
  }

  async getEventsByKind(): Promise<Record<string, number>> {
    const hashData = await this.redis.hGetAll(METRICS_KEYS.events_by_kind);
    const result: Record<string, number> = {};
    
    for (const [kind, count] of Object.entries(hashData)) {
      result[kind] = typeof count === 'string' ? parseInt(count, 10) : 0;
    }
    
    return result;
  }

  async getAllMetrics(): Promise<Record<string, number>> {
    const keys = Object.values(METRICS_KEYS).filter(k => k !== METRICS_KEYS.events_by_kind);
    const values = await this.redis.mGet(keys);
    
    const metrics: Record<string, number> = {};
    Object.entries(METRICS_KEYS).forEach(([key, redisKey], index) => {
      if (redisKey !== METRICS_KEYS.events_by_kind) {
        metrics[key] = values[index] ? parseInt(values[index] as string, 10) : 0;
      }
    });
    
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

// Legacy counter exports for backward compatibility (these will be no-ops)
export const eventsReceivedCounter = {
  inc: (delta?: number) => getMetricsInstance().incrementEventsReceived(delta || 1),
};

export const eventsStoredCounter = {
  inc: (delta?: number) => getMetricsInstance().incrementEventsStored(delta || 1),
};

export const eventsFailedCounter = {
  inc: (delta?: number) => getMetricsInstance().incrementEventsFailed(delta || 1),
};

export const eventsInvalidCounter = {
  inc: (delta?: number) => getMetricsInstance().incrementEventsInvalid(delta || 1),
};

export const eventsRejectedCounter = {
  inc: (delta?: number) => getMetricsInstance().incrementEventsRejected(delta || 1),
};

export const queriesCounter = {
  inc: (delta?: number) => getMetricsInstance().incrementQueriesTotal(delta || 1),
};

export async function getMetrics(): Promise<string> {
  // Get metrics instance
  const metrics = getMetricsInstance();
  
  // Get all metrics from Redis
  const allMetrics = await metrics.getAllMetrics();
  const eventsByKind = await metrics.getEventsByKind();
  
  // Clear the registry to avoid duplicate metrics
  register.clear();
  
  // Update gauges with Redis values
  connectionsGauge.set(allMetrics.connections_active);
  subscriptionsGauge.set(allMetrics.subscriptions_active);
  
  // Create counters with Redis values
  new Counter({
    name: "nostr_events_received",
    help: "Total events received",
    registers: [register],
  }).inc(allMetrics.events_received);
  
  new Counter({
    name: "nostr_events_stored",
    help: "Total events successfully stored",
    registers: [register],
  }).inc(allMetrics.events_stored);
  
  new Counter({
    name: "nostr_events_failed",
    help: "Total events failed to store",
    registers: [register],
  }).inc(allMetrics.events_failed);
  
  new Counter({
    name: "nostr_events_invalid",
    help: "Total events invalid",
    registers: [register],
  }).inc(allMetrics.events_invalid);
  
  new Counter({
    name: "nostr_events_rejected",
    help: "Total events rejected",
    registers: [register],
  }).inc(allMetrics.events_rejected);
  
  new Counter({
    name: "nostr_queries_total",
    help: "Total queries processed",
    registers: [register],
  }).inc(allMetrics.queries_total);
  
  // Event kind metrics - create a counter for each kind
  const eventsByKindCounter = new Counter({
    name: "nostr_events_by_kind_total",
    help: "Total events received by kind",
    labelNames: ["kind"],
    registers: [register],
  });
  
  for (const [kind, count] of Object.entries(eventsByKind)) {
    eventsByKindCounter.inc({ kind }, count);
  }
  
  return await register.metrics();
}