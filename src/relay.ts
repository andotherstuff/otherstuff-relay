import { setNostrWasm, verifyEvent } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";
import {
  eventsFailedCounter,
  eventsInvalidCounter,
  eventsReceivedCounter,
  eventsRejectedCounter,
  eventsStoredCounter,
  queriesCounter,
  subscriptionsGauge,
} from "./metrics.ts";
import type { ClickHouseClient } from "@clickhouse/client-web";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { RedisClientType } from "redis";

type Subscription = {
  connId: string;
  subId: string;
  filters: NostrFilter[];
  sendEvent: (event: NostrEvent) => void;
  sendEose: () => void;
};

export class NostrRelay {
  private subscriptions = new Map<string, Subscription>();
  private connectionSubs = new Map<string, Set<string>>();

  private wasmInitialized: Promise<void> = (async () => {
    const wasm = await initNostrWasm();
    setNostrWasm(wasm);
  })();

  constructor(
    private clickhouse: ClickHouseClient,
    private redis: RedisClientType,
  ) {}

  async handleEvent(
    event: NostrEvent,
  ): Promise<[boolean, string]> {
    eventsReceivedCounter.inc();

    if (!await this.verifyEvent(event)) {
      eventsInvalidCounter.inc();
      return [false, "invalid: event validation failed"];
    }

    if (JSON.stringify(event).length > 500000) {
      eventsRejectedCounter.inc();
      return [false, "rejected: event too large"];
    }

    try {
      // Push event to Redis queue for batch processing by worker
      await this.redis.lPush("nostr:events:queue", JSON.stringify(event));
      eventsStoredCounter.inc();
      return [true, ""];
    } catch (error) {
      eventsFailedCounter.inc();
      console.error("Failed to queue event:", error);
      return [false, "error: failed to queue event"];
    }
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
        const events = await this.queryEvents(filter);
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
    }
  }

  health(): {
    status: string;
    subscriptions: number;
    connections: number;
  } {
    return {
      status: "ok",
      subscriptions: this.subscriptions.size,
      connections: this.connectionSubs.size,
    };
  }

  async close(): Promise<void> {
    this.subscriptions.clear();
    this.connectionSubs.clear();
    await this.redis.quit();
    await this.clickhouse.close();
  }

  private async queryEvents(filter: NostrFilter): Promise<NostrEvent[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`id IN {ids:Array(String)}`);
      params.ids = filter.ids;
    }

    if (filter.authors && filter.authors.length > 0) {
      conditions.push(`pubkey IN {authors:Array(String)}`);
      params.authors = filter.authors;
    }

    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`kind IN {kinds:Array(UInt32)}`);
      params.kinds = filter.kinds;
    }

    if (filter.since) {
      conditions.push(`created_at >= {since:UInt32}`);
      params.since = filter.since;
    }

    if (filter.until) {
      conditions.push(`created_at <= {until:UInt32}`);
      params.until = filter.until;
    }

    // Handle tag filters (#e, #p, etc.)
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        const paramName = `tag_${tagName}`;
        const tagNameParam = `tagname_${tagName}`;
        conditions.push(
          `arrayExists(tag -> tag[1] = {${tagNameParam}:String} AND has({${paramName}:Array(String)}, tag[2]), tags)`,
        );
        params[paramName] = values;
        params[tagNameParam] = tagName;
      }
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const limit = Math.min(filter.limit || 500, 5000);
    params.limit = limit;

    const query = `
      SELECT
        id,
        pubkey,
        created_at,
        kind,
        tags,
        content,
        sig
      FROM nostr_events
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32}
    `;

    const resultSet = await this.clickhouse.query({
      query,
      query_params: params,
      format: "JSONEachRow",
    });

    const data = await resultSet.json<{
      id: string;
      pubkey: string;
      created_at: number;
      kind: number;
      tags: string[][];
      content: string;
      sig: string;
    }>();

    return data.map((row) => ({
      id: row.id,
      pubkey: row.pubkey,
      created_at: row.created_at,
      kind: row.kind,
      tags: row.tags,
      content: row.content,
      sig: row.sig,
    }));
  }

  private async verifyEvent(event: NostrEvent): Promise<boolean> {
    await this.wasmInitialized;
    return verifyEvent(event);
  }
}
