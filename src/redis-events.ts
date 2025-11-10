/**
 * Redis-based event storage wrapper for hot events
 * Provides fast access to recent events alongside ClickHouse persistence
 */
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { matchFilters } from "nostr-tools";

export class RedisEvents {
  public redis: ReturnType<typeof createRedisClient>;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.redis = createRedisClient({
      url: config.redisUrl,
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (error) {
      // Ignore errors during cleanup
      console.debug("Redis close error (ignored):", error);
    }
  }

  /**
   * Store an event in Redis for fast access
   * Uses hash for O(1) lookup by ID
   */
  async storeEvent(event: NostrEvent): Promise<void> {
    const key = `nostr:event:${event.id}`;
    await this.redis.hSet(key, {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at.toString(),
      kind: event.kind.toString(),
      content: event.content,
      sig: event.sig,
      tags: JSON.stringify(event.tags),
    });
    
    // Set TTL to automatically expire old events
    await this.redis.expire(key, this.config.hotEventsTtl);
    
    // Add to sorted set for time-based queries
    await this.redis.zAdd(
      "nostr:events:by_time",
      {
        score: event.created_at,
        value: event.id,
      }
    );
    
    // Trim sorted set to keep only recent events (prevent unbounded growth)
    const cutoffTime = Math.floor(Date.now() / 1000) - this.config.hotEventsTtl;
    await this.redis.zRemRangeByScore("nostr:events:by_time", 0, cutoffTime);
    
    // Index event for fast filtering
    await this.indexEvent(event);
  }

  /**
   * Get a specific event by ID
   */
  async getEvent(id: string): Promise<NostrEvent | null> {
    const key = `nostr:event:${id}`;
    const eventHash = await this.redis.hGetAll(key);
    
    if (!eventHash || !eventHash.id) {
      return null;
    }

    try {
      return {
        id: eventHash.id,
        pubkey: eventHash.pubkey,
        created_at: parseInt(eventHash.created_at),
        kind: parseInt(eventHash.kind),
        content: eventHash.content,
        sig: eventHash.sig,
        tags: JSON.parse(eventHash.tags || "[]"),
      };
    } catch (error) {
      console.error("Failed to parse event from Redis:", error);
      return null;
    }
  }

  /**
   * Query events from Redis based on filters
   * Returns recent events that match the filters
   */
  async queryEvents(filters: NostrFilter[]): Promise<NostrEvent[]> {
    const allEvents: NostrEvent[] = [];

    for (const filter of filters) {
      const events = await this.queryFilter(filter);
      allEvents.push(...events);
    }

    // Remove duplicates (by ID) and apply limit
    const uniqueEvents = Array.from(
      new Map(allEvents.map(event => [event.id, event])).values()
    );

    // Apply overall limit if specified in any filter
    const overallLimit = filters.reduce(
      (max, filter) => Math.max(max, filter.limit || 0),
      0
    );

    if (overallLimit > 0) {
      return uniqueEvents.slice(0, overallLimit);
    }

    return uniqueEvents;
  }

  /**
   * Query events for a single filter
   */
  private async queryFilter(filter: NostrFilter): Promise<NostrEvent[]> {
    // Get candidate event IDs from time range
    let eventIds: string[];

    if (filter.since || filter.until) {
      const min = filter.since || 0;
      const max = filter.until || Math.floor(Date.now() / 1000);
      eventIds = await this.redis.zRange("nostr:events:by_time", min, max);
    } else {
      // Get all recent events (limited to prevent memory issues)
      eventIds = await this.redis.zRange(
        "nostr:events:by_time",
        0,
        Math.floor(Date.now() / 1000),
        { BY: "SCORE" }
      );
      
      // Limit to prevent memory issues
      if (eventIds.length > 10000) {
        eventIds = eventIds.slice(0, 10000);
      }
    }

    // Apply fast filters before fetching full events
    if (filter.ids) {
      eventIds = eventIds.filter(id => filter.ids!.includes(id));
    }

    // Batch check author filters
    if (filter.authors && filter.authors.length > 0) {
      const authorPromises = filter.authors.map(author => 
        this.redis.sMembers(`nostr:events:by_author:${author}`)
      );
      const authorResults = await Promise.all(authorPromises);
      const validAuthorIds = new Set(authorResults.flat());
      eventIds = eventIds.filter(id => validAuthorIds.has(id));
    }

    // Batch check kind filters
    if (filter.kinds && filter.kinds.length > 0) {
      const kindPromises = filter.kinds.map(kind => 
        this.redis.sMembers(`nostr:events:by_kind:${kind}`)
      );
      const kindResults = await Promise.all(kindPromises);
      const validKindIds = new Set(kindResults.flat());
      eventIds = eventIds.filter(id => validKindIds.has(id));
    }

    // Fetch full events and apply remaining filters (including tag filters)
    const events: NostrEvent[] = [];
    for (const id of eventIds) {
      const event = await this.getEvent(id);
      if (event && matchFilters([filter], event)) {
        events.push(event);
      }
    }

    // Apply limit
    if (filter.limit && filter.limit > 0) {
      return events.slice(0, filter.limit);
    }

    return events;
  }

  /**
   * Store event indices for fast filtering
   */
  private async indexEvent(event: NostrEvent): Promise<void> {
    // Index by author
    await this.redis.sAdd(`nostr:events:by_author:${event.pubkey}`, event.id);
    await this.redis.expire(`nostr:events:by_author:${event.pubkey}`, this.config.hotEventsTtl);

    // Index by kind
    await this.redis.sAdd(`nostr:events:by_kind:${event.kind}`, event.id);
    await this.redis.expire(`nostr:events:by_kind:${event.kind}`, this.config.hotEventsTtl);

    // Index by tags
    for (const tag of event.tags) {
      if (tag.length >= 2) {
        const [tagName, tagValue] = tag;
        await this.redis.sAdd(`nostr:events:by_tag:${tagName}:${tagValue}`, event.id);
        await this.redis.expire(`nostr:events:by_tag:${tagName}:${tagValue}`, this.config.hotEventsTtl);
      }
    }
  }

  /**
   * Remove event indices (called automatically when events expire)
   */
  private async unindexEvent(event: NostrEvent): Promise<void> {
    // Remove from author index
    await this.redis.sRem(`nostr:events:by_author:${event.pubkey}`, event.id);

    // Remove from kind index
    await this.redis.sRem(`nostr:events:by_kind:${event.kind}`, event.id);

    // Remove from tag indices
    for (const tag of event.tags) {
      if (tag.length >= 2) {
        const [tagName, tagValue] = tag;
        await this.redis.sRem(`nostr:events:by_tag:${tagName}:${tagValue}`, event.id);
      }
    }
  }
}