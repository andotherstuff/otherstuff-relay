import { Counter, Gauge, Registry } from "prom-client";
import type { RedisClientType } from "redis";

// Create a custom registry
export const register = new Registry();

// Redis client for metrics storage (will be injected)
let redis: any;

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
};

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

// Initialize metrics with Redis client
export function initializeMetrics(redisClient: any): void {
  redis = redisClient;
}

// Redis-based metrics functions
export class RedisMetrics {
  static async incrementConnections(delta: number = 1): Promise<void> {
    await redis.incrBy(METRICS_KEYS.connections_active, delta);
  }

  static async setConnections(value: number): Promise<void> {
    await redis.set(METRICS_KEYS.connections_active, value);
  }

  static async incrementEventsReceived(delta: number = 1): Promise<void> {
    await redis.incrBy(METRICS_KEYS.events_received, delta);
  }

  static async incrementEventsStored(delta: number = 1): Promise<void> {
    await redis.incrBy(METRICS_KEYS.events_stored, delta);
  }

  static async incrementEventsFailed(delta: number = 1): Promise<void> {
    await redis.incrBy(METRICS_KEYS.events_failed, delta);
  }

  static async incrementEventsInvalid(delta: number = 1): Promise<void> {
    await redis.incrBy(METRICS_KEYS.events_invalid, delta);
  }

  static async incrementEventsRejected(delta: number = 1): Promise<void> {
    await redis.incrBy(METRICS_KEYS.events_rejected, delta);
  }

  static async incrementQueriesTotal(delta: number = 1): Promise<void> {
    await redis.incrBy(METRICS_KEYS.queries_total, delta);
  }

  static async setSubscriptions(value: number): Promise<void> {
    await redis.set(METRICS_KEYS.subscriptions_active, value);
  }

  static async getConnections(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.connections_active);
    return value ? parseInt(value, 10) : 0;
  }

  static async getSubscriptions(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.subscriptions_active);
    return value ? parseInt(value, 10) : 0;
  }

  static async getEventsReceived(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.events_received);
    return value ? parseInt(value, 10) : 0;
  }

  static async getEventsStored(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.events_stored);
    return value ? parseInt(value, 10) : 0;
  }

  static async getEventsFailed(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.events_failed);
    return value ? parseInt(value, 10) : 0;
  }

  static async getEventsInvalid(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.events_invalid);
    return value ? parseInt(value, 10) : 0;
  }

  static async getEventsRejected(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.events_rejected);
    return value ? parseInt(value, 10) : 0;
  }

  static async getQueriesTotal(): Promise<number> {
    const value = await redis.get(METRICS_KEYS.queries_total);
    return value ? parseInt(value, 10) : 0;
  }

  static async incrementEventByKind(kind: number, delta: number = 1): Promise<void> {
    await redis.hIncrBy(METRICS_KEYS.events_by_kind, kind.toString(), delta);
  }

  static async getEventsByKind(): Promise<Record<string, number>> {
    const hashData = await redis.hGetAll(METRICS_KEYS.events_by_kind);
    const result: Record<string, number> = {};
    
    for (const [kind, count] of Object.entries(hashData)) {
      result[kind] = typeof count === 'string' ? parseInt(count, 10) : 0;
    }
    
    return result;
  }

  static async getAllMetrics(): Promise<Record<string, number>> {
    const keys = Object.values(METRICS_KEYS).filter(k => k !== METRICS_KEYS.events_by_kind);
    const values = await redis.mGet(keys);
    
    const metrics: Record<string, number> = {};
    Object.entries(METRICS_KEYS).forEach(([key, redisKey], index) => {
      if (redisKey !== METRICS_KEYS.events_by_kind) {
        metrics[key] = values[index] ? parseInt(values[index] as string, 10) : 0;
      }
    });
    
    return metrics;
  }
}

// Legacy counter exports for backward compatibility (these will be no-ops)
export const eventsReceivedCounter = {
  inc: (delta?: number) => RedisMetrics.incrementEventsReceived(delta || 1),
};

export const eventsStoredCounter = {
  inc: (delta?: number) => RedisMetrics.incrementEventsStored(delta || 1),
};

export const eventsFailedCounter = {
  inc: (delta?: number) => RedisMetrics.incrementEventsFailed(delta || 1),
};

export const eventsInvalidCounter = {
  inc: (delta?: number) => RedisMetrics.incrementEventsInvalid(delta || 1),
};

export const eventsRejectedCounter = {
  inc: (delta?: number) => RedisMetrics.incrementEventsRejected(delta || 1),
};

export const queriesCounter = {
  inc: (delta?: number) => RedisMetrics.incrementQueriesTotal(delta || 1),
};

export async function getMetrics(): Promise<string> {
  // Get all metrics from Redis
  const metrics = await RedisMetrics.getAllMetrics();
  const eventsByKind = await RedisMetrics.getEventsByKind();
  
  // Clear the registry to avoid duplicate metrics
  register.clear();
  
  // Create fresh metrics with Redis values
  
  // Gauges
  new Gauge({
    name: "nostr_connections_active",
    help: "Current WebSocket connections",
    registers: [register],
  }).set(metrics.connections_active);
  
  new Gauge({
    name: "nostr_subscriptions_active",
    help: "Current active subscriptions",
    registers: [register],
  }).set(metrics.subscriptions_active);
  
  // Counters
  new Counter({
    name: "nostr_events_received",
    help: "Total events received",
    registers: [register],
  }).inc(metrics.events_received);
  
  new Counter({
    name: "nostr_events_stored",
    help: "Total events successfully stored",
    registers: [register],
  }).inc(metrics.events_stored);
  
  new Counter({
    name: "nostr_events_failed",
    help: "Total events failed to store",
    registers: [register],
  }).inc(metrics.events_failed);
  
  new Counter({
    name: "nostr_events_invalid",
    help: "Total events invalid",
    registers: [register],
  }).inc(metrics.events_invalid);
  
  new Counter({
    name: "nostr_events_rejected",
    help: "Total events rejected",
    registers: [register],
  }).inc(metrics.events_rejected);
  
  new Counter({
    name: "nostr_queries_total",
    help: "Total queries processed",
    registers: [register],
  }).inc(metrics.queries_total);
  
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
