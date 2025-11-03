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
    const mainConditions: string[] = [];
    const tagConditions: string[] = [];
    const params: Record<string, unknown> = {};

    // Handle ID filters
    if (filter.ids && filter.ids.length > 0) {
      mainConditions.push(`e.id IN ({ids:Array(String)})`);
      params.ids = filter.ids;
    }

    // Handle author filters
    if (filter.authors && filter.authors.length > 0) {
      mainConditions.push(`e.pubkey IN ({authors:Array(String)})`);
      params.authors = filter.authors;
    }

    // Handle kind filters
    if (filter.kinds && filter.kinds.length > 0) {
      mainConditions.push(`e.kind IN ({kinds:Array(UInt32)})`);
      params.kinds = filter.kinds;
    }

    // Handle time filters
    if (filter.since) {
      mainConditions.push(`e.created_at >= {since:DateTime}`);
      params.since = new Date(filter.since * 1000);
    }

    if (filter.until) {
      mainConditions.push(`e.created_at <= {until:DateTime}`);
      params.until = new Date(filter.until * 1000);
    }

    // Handle tag filters (#e, #p, #t, etc.) using subquery pattern
    const tagFilters: string[] = [];
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        const paramName = `tag_${tagName}`;
        tagConditions.push(
          `tag_name = {tagname_${tagName}:String} AND tag_value_1 IN ({${paramName}:Array(String)})`
        );
        params[paramName] = values;
        params[`tagname_${tagName}`] = tagName;
        tagFilters.push(`tag_name = {tagname_${tagName}:String} AND tag_value_1 IN ({${paramName}:Array(String)})`);
      }
    }

    // Build the main query
    let whereClause = "";
    if (mainConditions.length > 0) {
      whereClause = `WHERE ${mainConditions.join(" AND ")}`;
    }

    // Add tag subquery if there are tag filters
    if (tagFilters.length > 0) {
      const tagWhere = tagFilters.join(" AND ");
      if (whereClause) {
        whereClause += ` AND e.id IN (
          SELECT event_id
          FROM event_tags_flat
          WHERE ${tagWhere}
        )`;
      } else {
        whereClause = `WHERE e.id IN (
          SELECT event_id
          FROM event_tags_flat
          WHERE ${tagWhere}
        )`;
      }
    }

    const limit = Math.min(filter.limit || 500, 5000);
    params.limit = limit;

    const query = `
      SELECT e.*
      FROM events_local AS e
      ${whereClause}
      ORDER BY e.created_at DESC
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
