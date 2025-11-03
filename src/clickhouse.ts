import type { ClickHouseClient } from "@clickhouse/client-web";
import type {
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayCOUNT,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NRelay,
} from "@nostrify/nostrify";

/**
 * Options for ClickhouseRelay
 */
export interface ClickhouseRelayOptions {
  /** Relay source identifier for tracking event origins */
  relaySource?: string;
}

/**
 * ClickHouse-backed Nostr relay implementation
 * Handles event storage and querying without any Redis dependencies
 * Expects events to be pre-validated before insertion
 */
export class ClickhouseRelay implements NRelay {
  private relaySource: string;

  constructor(
    private clickhouse: ClickHouseClient,
    options: ClickhouseRelayOptions = {},
  ) {
    this.relaySource = options.relaySource ?? "";
  }

  /**
   * Query events from ClickHouse based on a single filter
   */
  private async queryFilter(filter: NostrFilter): Promise<NostrEvent[]> {
    // If limit is 0, skip the query (realtime-only subscription)
    if (filter.limit === 0) {
      return [];
    }

    // Default to 500, cap at 5000
    const limit = Math.min(filter.limit || 500, 5000);

    // Extract tag filters
    const tagFilters: Array<{ name: string; values: string[] }> = [];
    const nonTagFilter: NostrFilter = {};

    // Copy non-tag filters
    if (filter.ids) nonTagFilter.ids = filter.ids;
    if (filter.authors) nonTagFilter.authors = filter.authors;
    if (filter.kinds) nonTagFilter.kinds = filter.kinds;
    if (filter.since) nonTagFilter.since = filter.since;
    if (filter.until) nonTagFilter.until = filter.until;
    if (filter.limit) nonTagFilter.limit = filter.limit;
    if (filter.search) nonTagFilter.search = filter.search;

    // Extract tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        tagFilters.push({ name: tagName, values });
      }
    }

    // If we have tag filters, use the flattened tag view for better performance
    if (tagFilters.length > 0) {
      return await this.queryEventsWithTags(filter, tagFilters, limit);
    }

    // For non-tag queries, use the main table
    return await this.queryEventsSimple(nonTagFilter, limit);
  }

  /**
   * Query events without tag filters (optimized path)
   */
  private async queryEventsSimple(
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`id IN ({ids:Array(String)})`);
      params.ids = filter.ids;
    }

    if (filter.authors && filter.authors.length > 0) {
      conditions.push(`pubkey IN ({authors:Array(String)})`);
      params.authors = filter.authors;
    }

    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`kind IN ({kinds:Array(UInt16)})`);
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

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

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
      FROM events_local
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
   * Query events with tag filters (uses materialized view)
   */
  private async queryEventsWithTags(
    filter: NostrFilter,
    tagFilters: Array<{ name: string; values: string[] }>,
    limit: number,
  ): Promise<NostrEvent[]> {
    // Build conditions for tag filters using flattened table
    const tagConditions: string[] = [];
    const params: Record<string, unknown> = {};

    for (let i = 0; i < tagFilters.length; i++) {
      const { name, values } = tagFilters[i];
      const paramName = `tag_values_${i}`;
      const tagNameParam = `tag_name_${i}`;

      tagConditions.push(
        `tag_name = {${tagNameParam}:String} AND tag_value_1 IN ({${paramName}:Array(String)})`,
      );
      params[paramName] = values;
      params[tagNameParam] = name;
    }

    const tagWhereClause = tagConditions.join(" OR ");

    // Build additional conditions
    const otherConditions: string[] = [];

    if (filter.authors && filter.authors.length > 0) {
      otherConditions.push(`pubkey IN ({authors:Array(String)})`);
      params.authors = filter.authors;
    }

    if (filter.kinds && filter.kinds.length > 0) {
      otherConditions.push(`kind IN ({kinds:Array(UInt16)})`);
      params.kinds = filter.kinds;
    }

    if (filter.since) {
      otherConditions.push(`created_at >= {since:DateTime}`);
      params.since = new Date(filter.since * 1000);
    }

    if (filter.until) {
      otherConditions.push(`created_at <= {until:DateTime}`);
      params.until = new Date(filter.until * 1000);
    }

    const allConditions = [tagWhereClause, ...otherConditions];
    const whereClause = `WHERE ${allConditions.join(" AND ")}`;

    params.limit = limit;

    // Query using the flattened tag view with JOIN to main table
    const query = `
      SELECT DISTINCT
        e.id,
        e.pubkey,
        toUnixTimestamp(e.created_at) as created_at,
        e.kind,
        e.tags,
        e.content,
        e.sig
      FROM events_local e
      INNER JOIN (
        SELECT DISTINCT event_id, created_at
        FROM event_tags_flat
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT {limit:UInt32}
      ) t ON e.id = t.event_id
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

  /**
   * Insert a single event into ClickHouse
   * Events are expected to be pre-validated
   */
  async event(
    event: NostrEvent,
    _opts?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.clickhouse.insert({
      table: "events_local",
      values: [{
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
        indexed_at: Math.floor(Date.now() / 1000),
        relay_source: this.relaySource,
      }],
      format: "JSONEachRow",
    });
  }

  /**
   * Insert a batch of events into ClickHouse
   * Events are expected to be pre-validated
   */
  async eventBatch(events: NostrEvent[]): Promise<void> {
    if (events.length === 0) return;

    await this.clickhouse.insert({
      table: "events_local",
      values: events.map((event) => ({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
        indexed_at: Math.floor(Date.now() / 1000),
        relay_source: this.relaySource,
      })),
      format: "JSONEachRow",
    });
  }

  /**
   * Query events from ClickHouse
   */
  async query(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    const allEvents: NostrEvent[] = [];

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }
      try {
        const events = await this.queryFilter(filter);
        allEvents.push(...events);
      } catch (error) {
        console.error("Query failed for filter:", filter, error);
      }
    }

    return allEvents;
  }

  /**
   * Stream events from ClickHouse
   */
  async *req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED> {
    // Query all filters
    for (const filter of filters) {
      try {
        const events = await this.queryFilter(filter);
        for (const event of events) {
          if (opts?.signal?.aborted) {
            return;
          }
          yield ["EVENT", "req", event];
        }
      } catch (error) {
        console.error("Query failed for filter:", filter, error);
      }
    }
    yield ["EOSE", "req"];
  }

  /**
   * Count events matching filters
   */
  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrRelayCOUNT[2]> {
    let total = 0;

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }
      try {
        const events = await this.queryFilter(filter);
        total += events.length;
      } catch (error) {
        console.error("Count query failed for filter:", filter, error);
      }
    }

    return { count: total };
  }

  /**
   * Remove events (not supported)
   */
  remove(
    _filters: NostrFilter[],
    _opts?: { signal?: AbortSignal },
  ): Promise<void> {
    throw new Error("Event deletion not supported");
  }

  /**
   * Close the ClickHouse connection
   */
  async close(): Promise<void> {
    await this.clickhouse.close();
  }

  /**
   * Migrate database schema (placeholder for future implementation)
   */
  async migrate(): Promise<void> {
    // TODO: Implement table creation
  }
}
