import type { Config } from "./config.ts";
import type { ClickHouseClient } from "./clickhouse.ts";
import {
  eventsFailedCounter,
  eventsInvalidCounter,
  eventsReceivedCounter,
  eventsRejectedCounter,
  eventsStoredCounter,
  queriesCounter,
  subscriptionsGauge,
} from "./metrics.ts";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

type Subscription = {
  connId: string;
  subId: string;
  filters: NostrFilter[];
  sendEvent: (event: NostrEvent) => void;
  sendEose: () => void;
};

class RateLimiter {
  private lastReset = Date.now();
  private eventCount = 0;
  private readonly maxEventsPerSecond: number;
  private readonly maxEventsPerMinute: number;
  private readonly minuteEvents: number[] = [];

  constructor(maxPerSecond: number = 10, maxPerMinute: number = 1000) {
    this.maxEventsPerSecond = maxPerSecond;
    this.maxEventsPerMinute = maxPerMinute;
  }

  canPostEvent(): boolean {
    const now = Date.now();

    if (now - this.lastReset >= 1000) {
      this.eventCount = 0;
      this.lastReset = now;
    }

    const oneMinuteAgo = now - 60000;
    while (
      this.minuteEvents.length > 0 && this.minuteEvents[0] < oneMinuteAgo
    ) {
      this.minuteEvents.shift();
    }

    if (this.eventCount >= this.maxEventsPerSecond) {
      return false;
    }

    if (this.minuteEvents.length >= this.maxEventsPerMinute) {
      return false;
    }

    this.eventCount++;
    this.minuteEvents.push(now);

    return true;
  }
}

export class NostrRelay {
  private subscriptions = new Map<string, Subscription>();
  private connectionSubs = new Map<string, Set<string>>();
  private connectionRateLimiters = new Map<string, RateLimiter>();

  constructor(
    private config: Config,
    private clickhouse: ClickHouseClient,
  ) {}

  async init(): Promise<void> {
    await this.clickhouse.initDatabase();
  }

  async handleEvent(
    event: NostrEvent,
    connId?: string,
  ): Promise<[boolean, string]> {
    eventsReceivedCounter.inc();

    if (!this.isValidEvent(event)) {
      eventsInvalidCounter.inc();
      return [false, "invalid: event validation failed"];
    }

    if (JSON.stringify(event).length > 500000) {
      eventsRejectedCounter.inc();
      return [false, "rejected: event too large"];
    }

    (async () => {
      const success = await this.clickhouse.insertEvent(event);
      if (success) {
        eventsStoredCounter.inc();
      } else {
        eventsFailedCounter.inc();
      }
    })();

    return [true, ""];
  }

  async handleReq(
    connId: string,
    subId: string,
    filters: NostrFilter[],
    sendEvent: (event: NostrEvent) => void,
    sendEose: () => void,
  ): Promise<void> {
    subscriptionsGauge.inc();
    queriesCounter.inc();

    const connSubs = this.connectionSubs.get(connId);
    if (connSubs && connSubs.size >= 10) {
      sendEose();
      return;
    }

    if (filters.length > 10) {
      filters = filters.slice(0, 10);
    }

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

    const queryPromises = filters.map(async (filter) => {
      try {
        const events = await this.clickhouse.queryEvents(filter);
        for (const event of events) {
          sendEvent(event);
        }
        return events.length;
      } catch (error) {
        console.error("Query failed for filter:", filter, error);
        return 0;
      }
    });

    try {
      await Promise.race([
        Promise.all(queryPromises),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Query timeout")), 10000)
        ),
      ]);
    } catch (error) {
      console.error("Query timeout or error:", error);
    }

    sendEose();
  }

  handleClose(connId: string, subId: string): void {
    this.subscriptions.delete(subId);
    const subs = this.connectionSubs.get(connId);
    if (subs) {
      subs.delete(subId);
      if (subs.size === 0) {
        this.connectionSubs.delete(connId);
        this.connectionRateLimiters.delete(connId);
      }
    }
    subscriptionsGauge.dec();
  }

  handleDisconnect(connId: string): void {
    const subs = this.connectionSubs.get(connId);
    if (subs) {
      for (const subId of subs) {
        this.subscriptions.delete(subId);
        subscriptionsGauge.dec();
      }
      this.connectionSubs.delete(connId);
      this.connectionRateLimiters.delete(connId);
    }
  }

  health(): {
    status: string;
    subscriptions: number;
    connections: number;
    rateLimiters: number;
  } {
    return {
      status: "ok",
      subscriptions: this.subscriptions.size,
      connections: this.connectionSubs.size,
      rateLimiters: this.connectionRateLimiters.size,
    };
  }

  async close(): Promise<void> {
    this.subscriptions.clear();
    this.connectionSubs.clear();
    this.connectionRateLimiters.clear();
    await this.clickhouse.shutdown();
  }

  private isValidEvent(event: NostrEvent): boolean {
    if (
      !event.id || !event.pubkey || !event.sig ||
      typeof event.created_at !== "number" || typeof event.kind !== "number"
    ) {
      return false;
    }

    if (!/^[a-f0-9]{64}$/i.test(event.id)) {
      return false;
    }

    if (!/^[a-f0-9]{64}$/i.test(event.pubkey)) {
      return false;
    }

    if (typeof event.content !== "string") {
      return false;
    }

    if (!Array.isArray(event.tags) || !event.tags.every(Array.isArray)) {
      return false;
    }

    if (event.content.length > 50000) {
      return false;
    }

    if (!this.config.verification.enabled) {
      return true;
    }

    return /^[a-f0-9]{128}$/i.test(event.sig);
  }
}
