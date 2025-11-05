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
export class ClickhouseRelay implements NRelay, AsyncDisposable {
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
  private async queryFilter(
    filter: NostrFilter,
    signal?: AbortSignal,
  ): Promise<NostrEvent[]> {
    // If limit is 0, skip the query (realtime-only subscription)
    if (filter.limit === 0) {
      return [];
    }

    // Default to 100, cap at 5000
    const limit = Math.min(filter.limit || 100, 5000);

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

    // Use flattened tag view for tag queries
    if (tagFilters.length > 0) {
      return await this.queryEventsWithTags(filter, tagFilters, limit, signal);
    }

    // Use main table for non-tag queries
    return await this.queryEventsSimple(nonTagFilter, limit, signal);
  }

  
  private async queryEventsSimple(
    filter: NostrFilter,
    limit: number,
    signal?: AbortSignal,
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

    console.log("[QUERY] Simple query:", query);
    console.log("[QUERY] Params:", JSON.stringify(params));

    const resultSet = await this.clickhouse.query({
      query,
      query_params: params,
      format: "JSONEachRow",
      abort_signal: signal,
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
   * Query events with tag filters (optimized pattern matching the specified format)
   */
  private async queryEventsWithTags(
    filter: NostrFilter,
    tagFilters: Array<{ name: string; values: string[] }>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<NostrEvent[]> {
    
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    // Add other filter conditions (time filtering handled separately)
    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`e.id IN ({ids:Array(String)})`);
      params.ids = filter.ids;
    }

    if (filter.authors && filter.authors.length > 0) {
      conditions.push(`e.pubkey IN ({authors:Array(String)})`);
      params.authors = filter.authors;
    }

    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`e.kind IN ({kinds:Array(UInt16)})`);
      params.kinds = filter.kinds;
    }

    if (filter.until) {
      conditions.push(`e.created_at <= {until:UInt32}`);
      params.until = filter.until;
    }

    // Tag subquery - always added when tag filters exist
    if (tagFilters.length > 0) {
      const tagConditions: string[] = [];
      
      for (let i = 0; i < tagFilters.length; i++) {
        const { name, values } = tagFilters[i];
        const paramName = `tag_values_${i}`;
        const tagNameParam = `tag_name_${i}`;

        // Use IN for both single and multi values - deduplication
        tagConditions.push(
          `tag_name = {${tagNameParam}:String} AND tag_value_1 IN ({${paramName}:Array(String)})`,
        );
        params[paramName] = values;
        params[tagNameParam] = name;
      }

      // Add tag subquery using PREWHERE pattern for optimal performance
      const tagWhereConditions = tagConditions.join(" AND ");
      conditions.push(`e.id IN (
        SELECT event_id
        FROM event_tags_flat
        PREWHERE created_at >= toUnixTimestamp(now() - INTERVAL 30 DAY)
        WHERE ${tagWhereConditions}
      )`);
    }

    // Always add time filtering as the last condition in the main WHERE clause
    if (filter.since) {
      conditions.push(`e.created_at >= {since:UInt32}`);
      params.since = filter.since;
    } else {
      // Default time filtering for tag queries - always applied
      conditions.push(`e.created_at >= toUnixTimestamp(now() - INTERVAL 30 DAY)`);
    }

    
    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    params.limit = limit;

    
    const query = `
      SELECT e.*
      FROM events_local AS e
      ${whereClause}
      ORDER BY e.created_at DESC
      LIMIT {limit:UInt32}
    `;

    console.log("[QUERY] Tag query:", query);
    console.log("[QUERY] Params:", JSON.stringify(params));

    const resultSet = await this.clickhouse.query({
      query,
      query_params: params,
      format: "JSONEachRow",
      abort_signal: signal,
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
    opts?: { signal?: AbortSignal },
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
      abort_signal: opts?.signal,
    });
  }

  /**
   * Insert a batch of events into ClickHouse
   * Events are expected to be pre-validated
   */
  async eventBatch(
    events: NostrEvent[],
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
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
      abort_signal: opts?.signal,
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
        const events = await this.queryFilter(filter, opts?.signal);
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
        const events = await this.queryFilter(filter, opts?.signal);
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
        const events = await this.queryFilter(filter, opts?.signal);
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
   * Dispose resources
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Migrate database schema (placeholder for future implementation)
   */
  async migrate(): Promise<void> {
    // Initialize ClickHouse tables
    await this.clickhouse.query({
      query: `CREATE TABLE IF NOT EXISTS events_local (
        id String COMMENT '32-byte hex event ID (SHA-256 hash)',
        pubkey String COMMENT '32-byte hex public key of event creator',
        created_at UInt32 COMMENT 'Unix timestamp when event was created',
        kind UInt16 COMMENT 'Event kind (0-65535, see NIP-01)',
        content String COMMENT 'Event content (arbitrary string, format depends on kind)',
        sig String COMMENT '64-byte hex Schnorr signature',
        tags Array(Array(String)) COMMENT 'Nested array of tags',
        indexed_at UInt32 DEFAULT now() COMMENT 'When this event was indexed into Clickhouse',
        relay_source String DEFAULT '' COMMENT 'Source relay URL (e.g., wss://relay.damus.io)',
        INDEX idx_kind kind TYPE minmax GRANULARITY 4,
        INDEX idx_pubkey pubkey TYPE bloom_filter(0.01) GRANULARITY 4
      ) ENGINE = ReplacingMergeTree(indexed_at)
      PARTITION BY toYYYYMM(toDateTime(created_at))
      ORDER BY (created_at, kind, pubkey, id)
      SETTINGS index_granularity = 8192`,
    });

    // Create flattened tag materialized view for fast tag queries
    await this.clickhouse.query({
      query: `CREATE MATERIALIZED VIEW IF NOT EXISTS event_tags_flat
    ENGINE = MergeTree()
    ORDER BY (tag_name, tag_value_1, created_at, event_id)
    PARTITION BY toYYYYMM(toDateTime(created_at))
    AS SELECT
        id as event_id,
        pubkey,
        created_at,
        kind,
        arrayJoin(tags) as tag_array,
        tag_array[1] as tag_name,
        if(length(tag_array) >= 2, tag_array[2], '') as tag_value_1,
        if(length(tag_array) >= 3, tag_array[3], '') as tag_value_2,
        if(length(tag_array) >= 4, tag_array[4], '') as tag_value_3,
        if(length(tag_array) >= 5, tag_array[5], '') as tag_value_4,
        length(tag_array) as tag_length,
        tag_array as tag_full
    FROM events_local`,
    });

    // Create statistics views for monitoring and analytics
    await this.clickhouse.query({
      query: `CREATE VIEW IF NOT EXISTS event_stats AS
    SELECT
        toStartOfDay(toDateTime(created_at)) as date,
        kind,
        count() as event_count,
        uniq(pubkey) as unique_authors,
        avg(length(content)) as avg_content_length,
        sum(length(tags)) as total_tags
    FROM events_local
    GROUP BY date, kind
    ORDER BY date DESC, event_count DESC`,
    });

    await this.clickhouse.query({
      query: `CREATE VIEW IF NOT EXISTS relay_stats AS
    SELECT
        relay_source,
        count() as event_count,
        uniq(id) as unique_events,
        min(toDateTime(created_at)) as earliest_event,
        max(toDateTime(created_at)) as latest_event,
        uniq(pubkey) as unique_authors
    FROM events_local
    WHERE relay_source != ''
    GROUP BY relay_source
    ORDER BY event_count DESC`,
    });

    await this.clickhouse.query({
      query: `CREATE VIEW IF NOT EXISTS tag_stats AS
    SELECT
        tag_name,
        count() as occurrence_count,
        uniq(event_id) as unique_events,
        avg(tag_length) as avg_tag_length
    FROM event_tags_flat
    GROUP BY tag_name
    ORDER BY occurrence_count DESC`,
    });
  }
}
