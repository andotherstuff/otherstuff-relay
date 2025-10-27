import { insertEvent, queryEvents, initDatabase } from './clickhouse.ts';
import { metrics } from './metrics.ts';
import { config } from './config.ts';
import type { Event, Filter } from './types.ts';

type Subscription = {
  connId: string;
  subId: string;
  filters: Filter[];
  sendEvent: (event: Event) => void;
  sendEose: () => void;
};

export class NostrRelay {
  private subscriptions = new Map<string, Subscription>(); // subId -> subscription
  private connectionSubs = new Map<string, Set<string>>(); // connId -> set of subIds

  async init(): Promise<void> {
    await initDatabase();
  }

  async handleEvent(event: Event): Promise<[boolean, string]> {
    metrics.events.received();
    
    // Basic validation
    if (!this.isValidEvent(event)) {
      return [false, 'invalid: event validation failed'];
    }

    // Async insert - don't wait for it
    (async () => {
      const success = await insertEvent(event);
      if (success) {
        metrics.events.stored();
      } else {
        metrics.events.failed();
      }
    })();

    return [true, ''];
  }

  async handleReq(
    connId: string,
    subId: string,
    filters: Filter[],
    sendEvent: (event: Event) => void,
    sendEose: () => void,
  ): Promise<void> {
    metrics.subscriptions.inc();
    metrics.queries.inc();
    
    // Track subscription
    this.subscriptions.set(subId, {
      connId,
      subId,
      filters,
      sendEvent,
      sendEose,
    });
    
    if (!this.connectionSubs.has(connId)) {
      this.connectionSubs.set(connId, new Set());
    }
    this.connectionSubs.get(connId)!.add(subId);

    // Parallel query execution - each filter runs in parallel
    const queryPromises = filters.map(async (filter) => {
      const events = await queryEvents(filter);
      for (const event of events) {
        sendEvent(event);
      }
      return events.length;
    });

    // Wait for all queries to complete
    await Promise.all(queryPromises);
    
    sendEose();
  }

  handleClose(connId: string, subId: string): void {
    this.subscriptions.delete(subId);
    const subs = this.connectionSubs.get(connId);
    if (subs) {
      subs.delete(subId);
      if (subs.size === 0) {
        this.connectionSubs.delete(connId);
      }
    }
    metrics.subscriptions.dec();
  }

  handleDisconnect(connId: string): void {
    const subs = this.connectionSubs.get(connId);
    if (subs) {
      for (const subId of subs) {
        this.subscriptions.delete(subId);
      }
      this.connectionSubs.delete(connId);
      metrics.subscriptions.dec();
    }
  }

  health(): { status: string; subscriptions: number } {
    return {
      status: 'ok',
      subscriptions: this.subscriptions.size,
    };
  }

  async close(): Promise<void> {
    this.subscriptions.clear();
    this.connectionSubs.clear();
  }

  private isValidEvent(event: Event): boolean {
    // Basic structure validation
    if (!event.id || !event.pubkey || !event.sig || typeof event.created_at !== 'number' || typeof event.kind !== 'number') {
      return false;
    }
    
    // ID validation (should be 64-char hex)
    if (!/^[a-f0-9]{64}$/i.test(event.id)) {
      return false;
    }
    
    // Pubkey validation (should be 64-char hex)
    if (!/^[a-f0-9]{64}$/i.test(event.pubkey)) {
      return false;
    }
    
    // Content should be string
    if (typeof event.content !== 'string') {
      return false;
    }
    
    // Tags should be array of arrays
    if (!Array.isArray(event.tags) || !event.tags.every(Array.isArray)) {
      return false;
    }
    
    // Skip signature verification if disabled
    if (!config.verification.enabled) {
      return true;
    }
    
    // TODO: Add actual signature verification if needed
    // For now, just check sig format
    return /^[a-f0-9]{128}$/i.test(event.sig);
  }
}