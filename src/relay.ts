import { verifyEvent } from "nostr-tools";
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
  subId: string;
  filters: NostrFilter[];
};

export class NostrRelay {
  constructor(
    private clickhouse: ClickHouseClient,
    private redisPublisher: RedisClientType,
  ) {}

  async handleEvent(
    event: NostrEvent,
  ): Promise<[boolean, string]> {
    eventsReceivedCounter.inc();

    if (!verifyEvent(event)) {
      eventsInvalidCounter.inc();
      return [false, "invalid: event validation failed"];
    }

    if (JSON.stringify(event).length > 500000) {
      eventsRejectedCounter.inc();
      return [false, "rejected: event too large"];
    }

    try {
      // Insert event directly into ClickHouse
      await this.clickhouse.insert({
        table: "events",
        values: [{
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
          sig: event.sig,
        }],
        format: "JSONEachRow",
      });
      eventsStoredCounter.inc();

      // Publish event to Redis for real-time delivery
      // Use a single channel for all events - subscribers will filter
      await this.redisPublisher.publish(
        "nostr:events",
        JSON.stringify(event),
      );

      return [true, ""];
    } catch (error) {
      eventsFailedCounter.inc();
      console.error("Failed to store event:", error);
      return [false, "error: failed to store event"];
    }
  }

  async handleReq(
    _subId: string,
    filters: NostrFilter[],
    sendEvent: (event: NostrEvent) => void,
    sendEose: () => void,
  ): Promise<void> {
    subscriptionsGauge.inc();
    queriesCounter.inc();

    if (filters.length > 10) {
      filters = filters.slice(0, 10);
    }

    // Query historical events from ClickHouse
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

    // Send EOSE after historical events are delivered
    sendEose();
  }

  handleClose(): void {
    subscriptionsGauge.dec();
  }

  async close(): Promise<void> {
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
      FROM events
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

  /**
   * Check if an event matches any of the subscription filters
   */
  static matchesFilters(event: NostrEvent, filters: NostrFilter[]): boolean {
    return filters.some((filter) => this.matchesFilter(event, filter));
  }

  /**
   * Check if an event matches a single filter
   */
  private static matchesFilter(
    event: NostrEvent,
    filter: NostrFilter,
  ): boolean {
    // Check IDs
    if (filter.ids && filter.ids.length > 0) {
      if (!filter.ids.some((id) => event.id.startsWith(id))) {
        return false;
      }
    }

    // Check authors
    if (filter.authors && filter.authors.length > 0) {
      if (!filter.authors.some((author) => event.pubkey.startsWith(author))) {
        return false;
      }
    }

    // Check kinds
    if (filter.kinds && filter.kinds.length > 0) {
      if (!filter.kinds.includes(event.kind)) {
        return false;
      }
    }

    // Check since
    if (filter.since !== undefined && event.created_at < filter.since) {
      return false;
    }

    // Check until
    if (filter.until !== undefined && event.created_at > filter.until) {
      return false;
    }

    // Check tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        const hasMatchingTag = event.tags.some(
          (tag) => tag[0] === tagName && values.includes(tag[1]),
        );
        if (!hasMatchingTag) {
          return false;
        }
      }
    }

    return true;
  }
}
