import type { Client } from "@opensearch-project/opensearch";
import {
  NIP50,
  NostrEvent,
  NostrFilter,
  NostrRelayCLOSED,
  NostrRelayCOUNT,
  NostrRelayEOSE,
  NostrRelayEVENT,
  NRelay,
} from "@nostrify/nostrify";

/**
 * OpenSearch aggregation bucket type
 */
interface AggregationBucket {
  key: string;
  doc_count: number;
  [key: string]: unknown;
}

/**
 * OpenSearch terms aggregation response
 */
interface TermsAggregation {
  buckets: AggregationBucket[];
}

/**
 * OpenSearch aggregation response structure
 */
interface AggregationResponse {
  [key: string]: TermsAggregation;
}

/**
 * Nested aggregation bucket for controversial events
 */
interface NestedAggregationBucket extends AggregationBucket {
  reaction_kinds?: {
    reactions?: TermsAggregation;
  };
}

/**
 * OpenSearch search hit
 */
interface SearchHit<T> {
  _source: T;
}

/**
 * OpenSearch document structure for Nostr events
 */
interface NostrEventDocument {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  sig: string;
  tags: string[][];
  indexed_at: number;
  // Flattened tag fields for fast filtering
  tag_e?: string[];
  tag_p?: string[];
  tag_a?: string[];
  tag_d?: string[];
  tag_t?: string[];
  tag_r?: string[];
  tag_g?: string[];
  // Generic tag storage for all other tags
  tags_flat?: Array<{ name: string; value: string }>;
}

/**
 * OpenSearch-backed Nostr relay implementation
 * Handles event storage and querying with full-text search support (NIP-50)
 * Expects events to be pre-validated before insertion
 */
export class OpenSearchRelay implements NRelay, AsyncDisposable {
  private indexName: string;

  constructor(
    private client: Client,
    indexName?: string,
  ) {
    this.indexName = indexName || "nostr-events";
  }

  /**
   * Extract tag values for indexing
   */
  private extractTagValues(tags: string[][], tagName: string): string[] {
    return tags
      .filter((tag) => tag[0] === tagName && tag.length >= 2)
      .map((tag) => tag[1]);
  }

  /**
   * Convert NostrEvent to OpenSearch document
   */
  private eventToDocument(event: NostrEvent): NostrEventDocument {
    const doc: NostrEventDocument = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      content: event.content,
      sig: event.sig,
      tags: event.tags,
      indexed_at: Math.floor(Date.now() / 1000),
    };

    // Index common tags for fast filtering
    const eValues = this.extractTagValues(event.tags, "e");
    if (eValues.length > 0) doc.tag_e = eValues;

    const pValues = this.extractTagValues(event.tags, "p");
    if (pValues.length > 0) doc.tag_p = pValues;

    const aValues = this.extractTagValues(event.tags, "a");
    if (aValues.length > 0) doc.tag_a = aValues;

    const dValues = this.extractTagValues(event.tags, "d");
    if (dValues.length > 0) doc.tag_d = dValues;

    const tValues = this.extractTagValues(event.tags, "t");
    if (tValues.length > 0) doc.tag_t = tValues;

    const rValues = this.extractTagValues(event.tags, "r");
    if (rValues.length > 0) doc.tag_r = rValues;

    const gValues = this.extractTagValues(event.tags, "g");
    if (gValues.length > 0) doc.tag_g = gValues;

    // Index all other tags in a flattened structure for generic queries
    const commonTags = new Set(["e", "p", "a", "d", "t", "r", "g"]);
    const otherTags = event.tags
      .filter((tag) => tag.length >= 2 && !commonTags.has(tag[0]))
      .map((tag) => ({ name: tag[0], value: tag[1] }));

    if (otherTags.length > 0) {
      doc.tags_flat = otherTags;
    }

    return doc;
  }

  /**
   * Convert OpenSearch document back to NostrEvent
   */
  private documentToEvent(doc: NostrEventDocument): NostrEvent {
    return {
      id: doc.id,
      pubkey: doc.pubkey,
      created_at: doc.created_at,
      kind: doc.kind,
      tags: doc.tags,
      content: doc.content,
      sig: doc.sig,
    };
  }

  /**
   * Build OpenSearch query from Nostr filter
   */
  private buildQuery(filter: NostrFilter): Record<string, unknown> {
    const must: Record<string, unknown>[] = [];
    const should: Record<string, unknown>[] = [];

    // ID filter
    if (filter.ids && filter.ids.length > 0) {
      must.push({ terms: { id: filter.ids } });
    }

    // Author filter
    if (filter.authors && filter.authors.length > 0) {
      must.push({ terms: { pubkey: filter.authors } });
    }

    // Kind filter
    if (filter.kinds && filter.kinds.length > 0) {
      must.push({ terms: { kind: filter.kinds } });
    }

    // Time range filters
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since) range.gte = filter.since;
      if (filter.until) range.lte = filter.until;
      must.push({ range: { created_at: range } });
    }

    // Tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);

        // Use optimized fields for common tags
        const commonTags = new Set(["e", "p", "a", "d", "t", "r", "g"]);
        if (commonTags.has(tagName)) {
          must.push({ terms: { [`tag_${tagName}`]: values } });
        } else {
          // Use nested query for other tags
          must.push({
            nested: {
              path: "tags_flat",
              query: {
                bool: {
                  must: [
                    { term: { "tags_flat.name": tagName } },
                    { terms: { "tags_flat.value": values } },
                  ],
                },
              },
            },
          });
        }
      }
    }

    // Full-text search (NIP-50)
    if (filter.search) {
      const tokens = NIP50.parseInput(filter.search);
      const searchText = tokens.filter((t) => typeof t === "string").join(" ");

      // Use match query with boosting for better relevance if there's search text
      if (searchText.trim()) {
        must.push({
          match: {
            content: {
              query: searchText,
              operator: "and",
              fuzziness: "AUTO",
            },
          },
        });
      }
    }

    const query: Record<string, unknown> = {
      bool: {},
    };

    if (must.length > 0) {
      (query.bool as Record<string, unknown>).must = must;
    }
    if (should.length > 0) {
      (query.bool as Record<string, unknown>).should = should;
    }

    // If no conditions, match all
    if (must.length === 0 && should.length === 0) {
      return { match_all: {} };
    }

    return query;
  }

  /**
   * Parse NIP-50 search extensions from search string
   */
  private parseSearchExtensions(search: string): {
    sortType?: "hot" | "top" | "controversial" | "rising";
    searchText: string;
    hasMultipleSorts: boolean;
  } {
    const tokens = NIP50.parseInput(search);
    const sortTokens = tokens.filter((t) =>
      typeof t === "object" && t.key === "sort"
    );
    const searchText = tokens.filter((t) => typeof t === "string").join(" ");

    // If multiple sort tokens exist, mark it as invalid
    if (sortTokens.length > 1) {
      return { hasMultipleSorts: true, searchText: "" };
    }

    // Get the sort type if present
    let sortType: "hot" | "top" | "controversial" | "rising" | undefined;
    if (sortTokens.length === 1) {
      const token = sortTokens[0] as { key: string; value: string };
      const value = token.value.toLowerCase();
      if (
        value === "hot" || value === "top" || value === "controversial" ||
        value === "rising"
      ) {
        sortType = value;
      }
    }

    return { sortType, searchText, hasMultipleSorts: false };
  }

  /**
   * Query events from OpenSearch based on a single filter
   */
  private async queryFilter(
    filter: NostrFilter,
    _signal?: AbortSignal,
  ): Promise<NostrEvent[]> {
    // If limit is 0, skip the query (realtime-only subscription)
    if (filter.limit === 0) {
      return [];
    }

    // Parse search extensions if present
    let sortType: "hot" | "top" | "controversial" | "rising" | undefined;
    let hasFullTextSearch = false;

    if (filter.search) {
      const { sortType: parsedSort, searchText, hasMultipleSorts } = this
        .parseSearchExtensions(filter.search);

      // If multiple sort tokens exist, return 0 events
      if (hasMultipleSorts) {
        return [];
      }

      sortType = parsedSort;
      hasFullTextSearch = searchText.trim().length > 0;
    }

    // Default to 500, cap at 5000
    const limit = Math.min(filter.limit || 500, 5000);

    // For sort extensions, use aggregation-based queries
    if (sortType) {
      return await this.querySorted(filter, sortType, limit);
    }

    const query = this.buildQuery(filter);

    // For NIP-50 search queries with text, sort by relevance score first, then by created_at
    // For regular queries, sort by created_at only (newest first)
    const sort = hasFullTextSearch
      ? [{ _score: { order: "desc" as const } }, {
        created_at: { order: "desc" as const },
      }]
      : [{ created_at: { order: "desc" as const } }];

    try {
      const response = await this.client.search({
        index: this.indexName,
        body: {
          query,
          sort,
          size: limit,
          _source: [
            "id",
            "pubkey",
            "created_at",
            "kind",
            "tags",
            "content",
            "sig",
          ],
        },
      });

      const hits = response.body.hits.hits;
      return hits.map((hit) =>
        this.documentToEvent(hit._source as NostrEventDocument)
      );
    } catch (error) {
      console.error("OpenSearch query failed:", error);
      throw error;
    }
  }

  /**
   * Query events with special sorting (hot, top, controversial, rising)
   */
  private async querySorted(
    filter: NostrFilter,
    sortType: "hot" | "top" | "controversial" | "rising",
    limit: number,
  ): Promise<NostrEvent[]> {
    const must: Record<string, unknown>[] = [];

    // Apply basic filters (everything except search)
    if (filter.ids && filter.ids.length > 0) {
      must.push({ terms: { id: filter.ids } });
    }
    if (filter.authors && filter.authors.length > 0) {
      must.push({ terms: { pubkey: filter.authors } });
    }
    if (filter.kinds && filter.kinds.length > 0) {
      must.push({ terms: { kind: filter.kinds } });
    }
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since) range.gte = filter.since;
      if (filter.until) range.lte = filter.until;
      must.push({ range: { created_at: range } });
    }

    // Tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        const commonTags = new Set(["e", "p", "a", "d", "t", "r", "g"]);
        if (commonTags.has(tagName)) {
          must.push({ terms: { [`tag_${tagName}`]: values } });
        } else {
          must.push({
            nested: {
              path: "tags_flat",
              query: {
                bool: {
                  must: [
                    { term: { "tags_flat.name": tagName } },
                    { terms: { "tags_flat.value": values } },
                  ],
                },
              },
            },
          });
        }
      }
    }

    // Full-text search if present
    if (filter.search) {
      const { searchText } = this.parseSearchExtensions(filter.search);
      if (searchText.trim()) {
        must.push({
          match: {
            content: {
              query: searchText,
              operator: "and",
              fuzziness: "AUTO",
            },
          },
        });
      }
    }

    const baseQuery = must.length > 0 ? { bool: { must } } : { match_all: {} };

    try {
      switch (sortType) {
        case "top":
          return await this.queryTop(baseQuery, filter, limit);
        case "hot":
          return await this.queryHot(baseQuery, filter, limit);
        case "controversial":
          return await this.queryControversial(baseQuery, filter, limit);
        case "rising":
          return await this.queryRising(baseQuery, filter, limit);
        default:
          return [];
      }
    } catch (error) {
      console.error(`Query failed for sort:${sortType}:`, error);
      return [];
    }
  }

  /**
   * Query top events (most referenced)
   */
  private async queryTop(
    baseQuery: Record<string, unknown>,
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    // Build aggregation query for events that reference others
    const aggMust: Record<string, unknown>[] = [
      { exists: { field: "tag_e" } },
    ];

    // Apply time range to referencing events if specified
    if (filter.since || filter.until) {
      const range: Record<string, number> = {};
      if (filter.since) range.gte = filter.since;
      if (filter.until) range.lte = filter.until;
      aggMust.push({ range: { created_at: range } });
    }

    // First, find events with most references using aggregation
    const aggsResponse = await this.client.search({
      index: this.indexName,
      body: {
        size: 0,
        query: {
          bool: {
            must: aggMust,
          },
        },
        aggs: {
          top_events: {
            terms: {
              field: "tag_e",
              size: Math.max(limit * 10, 1000), // Get many candidates for filtering
              order: { _count: "desc" },
            },
          },
        },
      },
    });

    const aggregations = aggsResponse.body.aggregations as
      | AggregationResponse
      | undefined;
    const buckets = aggregations?.top_events?.buckets || [];

    if (buckets.length === 0) {
      return [];
    }

    const eventIds = buckets.map((b) => b.key);

    // Fetch the actual events and apply remaining filters
    const fetchQuery: Record<string, unknown> = {
      bool: {
        must: [
          { terms: { id: eventIds } },
          baseQuery,
        ],
      },
    };

    const eventsResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: fetchQuery,
        size: Math.min(eventIds.length, 5000), // Fetch all candidates, up to 5000
        _source: [
          "id",
          "pubkey",
          "created_at",
          "kind",
          "tags",
          "content",
          "sig",
        ],
      },
    });

    // Create a reference count map
    const refCountMap = new Map<string, number>(
      buckets.map((b) => [b.key, b.doc_count]),
    );

    // Sort by reference count
    const events = eventsResponse.body.hits.hits
      .filter((hit) => hit._source !== undefined)
      .map((hit) => this.documentToEvent(hit._source as NostrEventDocument))
      .sort((a, b) => {
        const aCount = refCountMap.get(a.id) || 0;
        const bCount = refCountMap.get(b.id) || 0;
        return bCount - aCount;
      });

    return events.slice(0, limit);
  }

  /**
   * Query hot events (recent + referenced)
   * Hot score = reference_count * recency_factor
   * Recency factor decays exponentially with age
   */
  private async queryHot(
    baseQuery: Record<string, unknown>,
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const timeWindow = 7 * 24 * 60 * 60; // 7 days in seconds

    // Find events with references in recent time window
    const since = filter.since || (now - timeWindow);
    const until = filter.until || now;

    const aggsResponse = await this.client.search({
      index: this.indexName,
      body: {
        size: 0,
        query: {
          bool: {
            must: [
              { exists: { field: "tag_e" } },
              { range: { created_at: { gte: since, lte: until } } },
            ],
          },
        },
        aggs: {
          hot_events: {
            terms: {
              field: "tag_e",
              size: limit * 2,
              order: { _count: "desc" },
            },
          },
        },
      },
    });

    const aggregations = aggsResponse.body.aggregations as
      | AggregationResponse
      | undefined;
    const buckets = aggregations?.hot_events?.buckets || [];

    if (buckets.length === 0) {
      return [];
    }

    const eventIds = buckets.map((b) => b.key);

    // Fetch the actual events
    const fetchQuery: Record<string, unknown> = {
      bool: {
        must: [
          { terms: { id: eventIds } },
          baseQuery,
        ],
      },
    };

    const eventsResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: fetchQuery,
        size: Math.min(eventIds.length, 5000), // Fetch all candidates, up to 5000
        _source: [
          "id",
          "pubkey",
          "created_at",
          "kind",
          "tags",
          "content",
          "sig",
        ],
      },
    });

    // Calculate hot scores
    const refCountMap = new Map<string, number>(
      buckets.map((b) => [b.key, b.doc_count]),
    );

    const events = eventsResponse.body.hits.hits
      .filter((hit) => hit._source !== undefined)
      .map((hit) => {
        const event = this.documentToEvent(hit._source as NostrEventDocument);
        const refCount = refCountMap.get(event.id) || 0;
        const ageInSeconds = now - event.created_at;
        const ageInHours = ageInSeconds / 3600;

        // Hot score with exponential decay (half-life of 24 hours)
        const decayFactor = Math.pow(0.5, ageInHours / 24);
        const hotScore = refCount * decayFactor;

        return { event, hotScore };
      })
      .sort((a, b) => b.hotScore - a.hotScore)
      .map((item) => item.event)
      .slice(0, limit);

    return events;
  }

  /**
   * Query controversial events (high engagement with mixed reactions)
   * Controversial score = min(positive, negative) * total_engagement
   * This rewards events with balanced but high engagement
   */
  private async queryControversial(
    baseQuery: Record<string, unknown>,
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const timeWindow = 7 * 24 * 60 * 60; // 7 days
    const since = filter.since || (now - timeWindow);
    const until = filter.until || now;

    // Get events with both positive (kind 7 with +) and negative (kind 7 with -) reactions
    const aggsResponse = await this.client.search({
      index: this.indexName,
      body: {
        size: 0,
        query: {
          bool: {
            must: [
              { exists: { field: "tag_e" } },
              { range: { created_at: { gte: since, lte: until } } },
            ],
          },
        },
        aggs: {
          referenced_events: {
            terms: {
              field: "tag_e",
              size: limit * 3,
            },
            aggs: {
              reaction_kinds: {
                filter: {
                  term: { kind: 7 }, // Reactions
                },
                aggs: {
                  reactions: {
                    terms: {
                      field: "content.keyword",
                      size: 10,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const aggregations = aggsResponse.body.aggregations as
      | AggregationResponse
      | undefined;
    const buckets = (aggregations?.referenced_events?.buckets ||
      []) as NestedAggregationBucket[];

    // Calculate controversy scores
    const controversyScores: Array<{ eventId: string; score: number }> = [];

    for (const bucket of buckets) {
      const eventId = bucket.key;
      const reactionBuckets = bucket.reaction_kinds?.reactions?.buckets || [];

      let positive = 0;
      let negative = 0;

      for (const reactionBucket of reactionBuckets) {
        const reaction = reactionBucket.key;
        const count = reactionBucket.doc_count;

        if (reaction === "+" || reaction === "❤️" || reaction === "🤙") {
          positive += count;
        } else if (reaction === "-" || reaction === "👎") {
          negative += count;
        }
      }

      const total = positive + negative;
      if (total > 0) {
        // Controversy = min(pos, neg) * sqrt(total)
        // This rewards balanced reactions with high total engagement
        const score = Math.min(positive, negative) * Math.sqrt(total);
        controversyScores.push({ eventId, score });
      }
    }

    // Sort by controversy score
    controversyScores.sort((a, b) => b.score - a.score);

    if (controversyScores.length === 0) {
      return [];
    }

    // Get all event IDs (don't slice yet - we need to apply baseQuery filters first)
    const topEventIds = controversyScores.map((item) => item.eventId);

    // Fetch the actual events
    const fetchQuery: Record<string, unknown> = {
      bool: {
        must: [
          { terms: { id: topEventIds } },
          baseQuery,
        ],
      },
    };

    const eventsResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: fetchQuery,
        size: Math.min(topEventIds.length, 5000), // Fetch all candidates, up to 5000
        _source: [
          "id",
          "pubkey",
          "created_at",
          "kind",
          "tags",
          "content",
          "sig",
        ],
      },
    });

    // Maintain the sort order
    const eventMap = new Map(
      eventsResponse.body.hits.hits
        .filter((hit) => hit._source !== undefined)
        .map((hit) => [
          (hit._source as NostrEventDocument).id,
          this.documentToEvent(hit._source as NostrEventDocument),
        ]),
    );

    // Return events in controversy score order, limited to requested limit
    return topEventIds
      .map((id) => eventMap.get(id))
      .filter((e): e is NostrEvent => e !== undefined)
      .slice(0, limit);
  }

  /**
   * Query rising events (recently created, gaining engagement quickly)
   * Rising score = reference_count / age_in_hours
   */
  private async queryRising(
    baseQuery: Record<string, unknown>,
    filter: NostrFilter,
    limit: number,
  ): Promise<NostrEvent[]> {
    const now = Math.floor(Date.now() / 1000);
    const timeWindow = 48 * 60 * 60; // 48 hours for rising events

    const since = filter.since || (now - timeWindow);
    const until = filter.until || now;

    // Find recently referenced events
    const aggsResponse = await this.client.search({
      index: this.indexName,
      body: {
        size: 0,
        query: {
          bool: {
            must: [
              { exists: { field: "tag_e" } },
              { range: { created_at: { gte: since, lte: until } } },
            ],
          },
        },
        aggs: {
          rising_events: {
            terms: {
              field: "tag_e",
              size: limit * 2,
              order: { _count: "desc" },
            },
          },
        },
      },
    });

    const aggregations = aggsResponse.body.aggregations as
      | AggregationResponse
      | undefined;
    const buckets = aggregations?.rising_events?.buckets || [];

    if (buckets.length === 0) {
      return [];
    }

    const eventIds = buckets.map((b) => b.key);

    // Fetch the actual events
    const fetchQuery: Record<string, unknown> = {
      bool: {
        must: [
          { terms: { id: eventIds } },
          baseQuery,
        ],
      },
    };

    const eventsResponse = await this.client.search({
      index: this.indexName,
      body: {
        query: fetchQuery,
        size: Math.min(eventIds.length, 5000), // Fetch all candidates, up to 5000
        _source: [
          "id",
          "pubkey",
          "created_at",
          "kind",
          "tags",
          "content",
          "sig",
        ],
      },
    });

    // Calculate rising scores
    const refCountMap = new Map<string, number>(
      buckets.map((b) => [b.key, b.doc_count]),
    );

    const events = eventsResponse.body.hits.hits
      .filter((hit) => hit._source !== undefined)
      .map((hit) => {
        const event = this.documentToEvent(hit._source as NostrEventDocument);
        const refCount = refCountMap.get(event.id) || 0;
        const ageInSeconds = now - event.created_at;
        const ageInHours = Math.max(ageInSeconds / 3600, 0.1); // Minimum 0.1 hours

        // Rising score = references per hour
        const risingScore = refCount / ageInHours;

        return { event, risingScore };
      })
      .sort((a, b) => b.risingScore - a.risingScore)
      .map((item) => item.event)
      .slice(0, limit);

    return events;
  }

  /**
   * Insert a single event into OpenSearch
   * Events are expected to be pre-validated
   */
  async event(
    event: NostrEvent,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const doc = this.eventToDocument(event);

    await this.client.index({
      index: this.indexName,
      id: event.id,
      body: doc,
      refresh: false, // Don't refresh immediately for better performance
      // @ts-ignore: signal not in types but supported by underlying HTTP client
      signal: opts?.signal,
    });
  }

  /**
   * Insert a batch of events into OpenSearch using bulk API
   * Events are expected to be pre-validated
   * This is highly optimized for throughput
   */
  async eventBatch(
    events: NostrEvent[],
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    if (events.length === 0) return;

    // Build bulk request body
    const body: Array<Record<string, unknown> | NostrEventDocument> = [];

    for (const event of events) {
      const doc = this.eventToDocument(event);

      // Index operation (upsert)
      body.push({
        index: {
          _index: this.indexName,
          _id: event.id,
        },
      });
      body.push(doc);
    }

    try {
      const response = await this.client.bulk({
        body,
        refresh: false, // Don't refresh immediately for better performance
        // @ts-ignore: signal not in types but supported by underlying HTTP client
        signal: opts?.signal,
      });

      if (response.body.errors) {
        const erroredDocuments = response.body.items.filter(
          (item: Record<string, unknown>) =>
            (item.index as Record<string, unknown>)?.error,
        );
        console.error(
          `Bulk insert had ${erroredDocuments.length} errors:`,
          erroredDocuments.slice(0, 5),
        );
      }
    } catch (error) {
      console.error("Bulk insert failed:", error);
      throw error;
    }
  }

  /**
   * Query events from OpenSearch
   */
  async query(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrEvent[]> {
    const allEvents: NostrEvent[] = [];
    const seenIds = new Set<string>();

    for (const filter of filters) {
      if (opts?.signal?.aborted) {
        break;
      }
      try {
        const events = await this.queryFilter(filter, opts?.signal);

        // Deduplicate events across filters
        for (const event of events) {
          if (!seenIds.has(event.id)) {
            seenIds.add(event.id);
            allEvents.push(event);
          }
        }
      } catch (error) {
        console.error("Query failed for filter:", filter, error);
      }
    }

    // Sort by created_at descending (newest first)
    allEvents.sort((a, b) => b.created_at - a.created_at);

    return allEvents;
  }

  /**
   * Stream events from OpenSearch
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
        const query = this.buildQuery(filter);

        const response = await this.client.count({
          index: this.indexName,
          body: { query },
        });

        total += response.body.count;
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
   * Force refresh the index (for testing)
   */
  async refresh(): Promise<void> {
    await this.client.indices.refresh({
      index: this.indexName,
    });
  }

  /**
   * Close the OpenSearch connection
   */
  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Dispose resources
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Initialize OpenSearch index with optimized mappings
   */
  async migrate(): Promise<void> {
    try {
      // Check if index exists
      const indexExists = await this.client.indices.exists({
        index: this.indexName,
      });

      if (indexExists.body) {
        console.log(`Index ${this.indexName} already exists`);
        return;
      }

      // Create index with optimized mappings
      await this.client.indices.create({
        index: this.indexName,
        body: {
          settings: {
            number_of_shards: 3,
            number_of_replicas: 1,
            refresh_interval: "5s", // Batch refreshes for better write performance
            "index.mapping.total_fields.limit": 2000,
            analysis: {
              analyzer: {
                nostr_content_analyzer: {
                  type: "standard",
                  stopwords: "_none_", // Don't remove stop words for Nostr content
                },
              },
            },
          },
          mappings: {
            dynamic: "strict",
            properties: {
              id: {
                type: "keyword",
              },
              pubkey: {
                type: "keyword",
              },
              created_at: {
                type: "long",
              },
              kind: {
                type: "integer",
              },
              content: {
                type: "text",
                analyzer: "nostr_content_analyzer",
                // Also store as keyword for exact matching if needed
                fields: {
                  keyword: {
                    type: "keyword",
                    ignore_above: 256,
                  },
                },
              },
              sig: {
                type: "keyword",
              },
              tags: {
                type: "keyword",
                // Store full tag arrays
              },
              indexed_at: {
                type: "long",
              },
              // Optimized tag fields for common tags
              tag_e: {
                type: "keyword",
              },
              tag_p: {
                type: "keyword",
              },
              tag_a: {
                type: "keyword",
              },
              tag_d: {
                type: "keyword",
              },
              tag_t: {
                type: "keyword",
              },
              tag_r: {
                type: "keyword",
              },
              tag_g: {
                type: "keyword",
              },
              // Nested structure for all other tags
              tags_flat: {
                type: "nested",
                properties: {
                  name: {
                    type: "keyword",
                  },
                  value: {
                    type: "keyword",
                  },
                },
              },
            },
          },
        },
      });

      console.log(`✅ Created index ${this.indexName} with optimized mappings`);
    } catch (error) {
      console.error("Failed to create index:", error);
      throw error;
    }
  }
}
