/**
 * Worker pool for parallel message processing
 * Uses in-memory channels instead of Redis queues
 */

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { Channel, ResponseRouter } from "./channel.ts";

export interface ClientMessage {
  connId: string;
  msg: string;
  ipAddr?: string;
}

export interface EventMessage {
  connId: string;
  event: NostrEvent;
}

export interface ReqMessage {
  connId: string;
  subId: string;
  filters: NostrFilter[];
}

export interface CloseMessage {
  connId: string;
  subId: string;
}

export interface CloseConnMessage {
  connId: string;
}

export type WorkerMessage =
  | { type: "client"; data: ClientMessage }
  | { type: "event"; data: EventMessage }
  | { type: "req"; data: ReqMessage }
  | { type: "close"; data: CloseMessage }
  | { type: "closeConn"; data: CloseConnMessage };

/**
 * Shared state accessible by all workers
 */
export interface SharedState {
  // Input channel for raw client messages
  clientMessages: Channel<ClientMessage>;

  // Input channel for validated events ready for storage
  validatedEvents: Channel<NostrEvent>;

  // Response router for sending messages back to connections
  responses: ResponseRouter;

  // Broadcast channel for real-time event distribution
  eventBroadcast: Channel<NostrEvent>;

  // Stats
  stats: {
    messagesProcessed: number;
    eventsValidated: number;
    eventsStored: number;
    activeConnections: number;
  };
}

/**
 * Create shared state for worker pool
 */
export function createSharedState(): SharedState {
  return {
    clientMessages: new Channel<ClientMessage>(10000),
    validatedEvents: new Channel<NostrEvent>(10000),
    responses: new ResponseRouter(),
    eventBroadcast: new Channel<NostrEvent>(10000),
    stats: {
      messagesProcessed: 0,
      eventsValidated: 0,
      eventsStored: 0,
      activeConnections: 0,
    },
  };
}

/**
 * Worker pool configuration
 */
export interface WorkerPoolConfig {
  validationWorkers: number;
  storageWorkers: number;
}

/**
 * Get default worker pool configuration based on CPU cores
 */
export function getDefaultWorkerConfig(): WorkerPoolConfig {
  const cpuCount = navigator.hardwareConcurrency || 4;

  return {
    // Use most cores for validation (CPU bound)
    validationWorkers: Math.max(1, Math.floor(cpuCount * 0.75)),
    // Fewer workers for storage (I/O bound)
    storageWorkers: Math.max(1, Math.floor(cpuCount * 0.25)),
  };
}

/**
 * Connection state stored in memory
 */
export interface ConnectionState {
  connId: string;
  subscriptions: Map<string, NostrFilter[]>;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
}

/**
 * Connection manager
 */
export class ConnectionManager {
  private connections: Map<string, ConnectionState> = new Map();

  /**
   * Add a new connection
   */
  add(connId: string): ConnectionState {
    const state: ConnectionState = {
      connId,
      subscriptions: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
    };
    this.connections.set(connId, state);
    return state;
  }

  /**
   * Get connection state
   */
  get(connId: string): ConnectionState | undefined {
    return this.connections.get(connId);
  }

  /**
   * Update last activity timestamp
   */
  touch(connId: string): void {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.lastActivity = Date.now();
      conn.messageCount++;
    }
  }

  /**
   * Add subscription to connection
   */
  addSubscription(connId: string, subId: string, filters: NostrFilter[]): void {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.subscriptions.set(subId, filters);
    }
  }

  /**
   * Remove subscription from connection
   */
  removeSubscription(connId: string, subId: string): void {
    const conn = this.connections.get(connId);
    if (conn) {
      conn.subscriptions.delete(subId);
    }
  }

  /**
   * Remove connection
   */
  remove(connId: string): void {
    this.connections.delete(connId);
  }

  /**
   * Get all subscriptions for a connection
   */
  getSubscriptions(connId: string): Map<string, NostrFilter[]> {
    const conn = this.connections.get(connId);
    return conn?.subscriptions || new Map();
  }

  /**
   * Get all connections with subscriptions matching an event
   */
  findMatchingConnections(event: NostrEvent): Array<{ connId: string; subId: string }> {
    const matches: Array<{ connId: string; subId: string }> = [];

    for (const [connId, conn] of this.connections) {
      for (const [subId, filters] of conn.subscriptions) {
        // Check if event matches any filter
        if (this.eventMatchesFilters(event, filters)) {
          matches.push({ connId, subId });
        }
      }
    }

    return matches;
  }

  /**
   * Simple filter matching (can be optimized with indexes later)
   */
  private eventMatchesFilters(event: NostrEvent, filters: NostrFilter[]): boolean {
    for (const filter of filters) {
      if (this.eventMatchesFilter(event, filter)) {
        return true;
      }
    }
    return false;
  }

  private eventMatchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
    // IDs
    if (filter.ids && filter.ids.length > 0) {
      const match = filter.ids.some((id) => event.id.startsWith(id));
      if (!match) return false;
    }

    // Authors
    if (filter.authors && filter.authors.length > 0) {
      const match = filter.authors.some((author) => event.pubkey.startsWith(author));
      if (!match) return false;
    }

    // Kinds
    if (filter.kinds && filter.kinds.length > 0) {
      if (!filter.kinds.includes(event.kind)) return false;
    }

    // Since
    if (filter.since !== undefined) {
      if (event.created_at < filter.since) return false;
    }

    // Until
    if (filter.until !== undefined) {
      if (event.created_at > filter.until) return false;
    }

    // Generic tags (#e, #p, etc.)
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values)) {
        const tagName = key.slice(1);
        const eventTagValues = event.tags
          .filter((tag) => tag[0] === tagName)
          .map((tag) => tag[1]);

        const match = values.some((v) => eventTagValues.includes(v as string));
        if (!match) return false;
      }
    }

    return true;
  }

  /**
   * Get stats
   */
  stats(): {
    connections: number;
    totalSubscriptions: number;
    avgSubscriptionsPerConnection: number;
  } {
    let totalSubs = 0;
    for (const conn of this.connections.values()) {
      totalSubs += conn.subscriptions.size;
    }

    return {
      connections: this.connections.size,
      totalSubscriptions: totalSubs,
      avgSubscriptionsPerConnection: this.connections.size > 0
        ? totalSubs / this.connections.size
        : 0,
    };
  }

  /**
   * Clean up stale connections (no activity for > timeout)
   */
  cleanup(timeoutMs = 300000): number {
    const now = Date.now();
    let removed = 0;

    for (const [connId, conn] of this.connections) {
      if (now - conn.lastActivity > timeoutMs) {
        this.connections.delete(connId);
        removed++;
      }
    }

    return removed;
  }
}
