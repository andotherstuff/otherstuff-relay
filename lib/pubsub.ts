/**
 * PubSub system for NIP-01 realtime subscriptions with inverted indexes
 *
 * This module implements an efficient subscription matching system using inverted indexes
 * stored in Redis. When a new event arrives, we can quickly find all matching subscriptions
 * without iterating through every subscription and filter.
 *
 * Architecture:
 * - Each subscription has multiple filters (ORed together)
 * - Each filter has multiple conditions (ANDed together)
 * - Inverted indexes map event attributes to subscription IDs
 * - When an event arrives, we find candidate subscriptions from indexes
 * - Then verify the full filter match for candidates
 *
 * Redis Keys:
 * - `sub:{connId}:{subId}` - Subscription metadata and filters (hash)
 * - `sub:index:kind:{kind}` - Set of subIds interested in this kind
 * - `sub:index:author:{pubkey}` - Set of subIds interested in this author
 * - `sub:index:tag:{tagName}:{value}` - Set of subIds interested in this tag value
 * - `sub:index:all` - Set of subIds with no filters (match everything)
 * - `sub:conn:{connId}` - Set of subIds for a connection (for cleanup)
 */

import type { RedisClientType } from "redis";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Subscription metadata
 */
export interface Subscription {
  connId: string;
  subId: string;
  filters: NostrFilter[];
  createdAt: number;
}

/**
 * PubSub manager for Nostr subscriptions
 */
export class PubSub {
  constructor(private redis: RedisClientType) {}

  /**
   * Subscribe to events matching the given filters
   * Creates inverted indexes for efficient event matching
   */
  async subscribe(
    connId: string,
    subId: string,
    filters: NostrFilter[],
  ): Promise<void> {
    const subKey = `sub:${connId}:${subId}`;
    const connKey = `sub:conn:${connId}`;
    const subscription: Subscription = {
      connId,
      subId,
      filters,
      createdAt: Date.now(),
    };

    // Use pipeline for atomic operations
    const pipeline = this.redis.multi();

    // Store subscription metadata
    pipeline.hSet(subKey, {
      connId,
      subId,
      filters: JSON.stringify(filters),
      createdAt: subscription.createdAt.toString(),
    });

    // Add to connection's subscription set
    pipeline.sAdd(connKey, subId);

    // Set TTL on subscription (5 minutes, will be refreshed by connection)
    pipeline.expire(subKey, 300);
    pipeline.expire(connKey, 300);

    // Build inverted indexes for each filter
    for (const filter of filters) {
      this.indexFilter(pipeline, connId, subId, filter);
    }

    await pipeline.exec();
  }

  /**
   * Build inverted indexes for a single filter
   */
  private indexFilter(
    pipeline: ReturnType<RedisClientType["multi"]>,
    connId: string,
    subId: string,
    filter: NostrFilter,
  ): void {
    const indexKey = `${connId}:${subId}`;
    const indexKeys: string[] = []; // Track all index keys for TTL setting

    // Check if filter matches everything (no conditions)
    const hasConditions = filter.ids || filter.authors || filter.kinds ||
      filter.since || filter.until || this.hasTagFilters(filter);

    if (!hasConditions) {
      // This subscription matches all events
      const key = "sub:index:all";
      pipeline.sAdd(key, indexKey);
      indexKeys.push(key);
    } else {
      // Index by kind
      if (filter.kinds && filter.kinds.length > 0) {
        for (const kind of filter.kinds) {
          const key = `sub:index:kind:${kind}`;
          pipeline.sAdd(key, indexKey);
          indexKeys.push(key);
        }
      } else {
        // No kind filter means match all kinds
        const key = "sub:index:kind:*";
        pipeline.sAdd(key, indexKey);
        indexKeys.push(key);
      }

      // Index by author
      if (filter.authors && filter.authors.length > 0) {
        for (const author of filter.authors) {
          const key = `sub:index:author:${author}`;
          pipeline.sAdd(key, indexKey);
          indexKeys.push(key);
        }
      } else {
        // No author filter means match all authors
        const key = "sub:index:author:*";
        pipeline.sAdd(key, indexKey);
        indexKeys.push(key);
      }

      // Index by event IDs (less common, but important for specific event queries)
      if (filter.ids && filter.ids.length > 0) {
        for (const id of filter.ids) {
          const key = `sub:index:id:${id}`;
          pipeline.sAdd(key, indexKey);
          indexKeys.push(key);
        }
      }

      // Index by tags (e, p, a, etc.)
      for (const [key, value] of Object.entries(filter)) {
        if (key.startsWith("#") && Array.isArray(value) && value.length > 0) {
          const tagName = key.slice(1); // Remove '#' prefix
          for (const tagValue of value) {
            const indexKey_ = `sub:index:tag:${tagName}:${tagValue}`;
            pipeline.sAdd(indexKey_, indexKey);
            indexKeys.push(indexKey_);
          }
        }
      }
    }

    // Set TTL on all index keys (600 seconds = 10 minutes)
    // We use a longer TTL than subscriptions (300s) to handle cleanup delays
    for (const key of indexKeys) {
      pipeline.expire(key, 600);
    }
  }

  /**
   * Check if filter has any tag conditions
   */
  private hasTagFilters(filter: NostrFilter): boolean {
    for (const key of Object.keys(filter)) {
      if (key.startsWith("#")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Unsubscribe from a subscription
   * Removes all inverted indexes for this subscription
   */
  async unsubscribe(connId: string, subId: string): Promise<void> {
    const subKey = `sub:${connId}:${subId}`;
    const connKey = `sub:conn:${connId}`;
    const indexKey = `${connId}:${subId}`;

    // Get subscription metadata to clean up indexes
    const subData = await this.redis.hGetAll(subKey);

    if (!subData.filters) {
      // Subscription doesn't exist, nothing to clean up
      return;
    }

    const filters: NostrFilter[] = JSON.parse(subData.filters);
    const pipeline = this.redis.multi();

    // Remove from all inverted indexes
    pipeline.sRem("sub:index:all", indexKey);
    pipeline.sRem("sub:index:kind:*", indexKey);
    pipeline.sRem("sub:index:author:*", indexKey);

    for (const filter of filters) {
      // Remove from kind indexes
      if (filter.kinds) {
        for (const kind of filter.kinds) {
          pipeline.sRem(`sub:index:kind:${kind}`, indexKey);
        }
      }

      // Remove from author indexes
      if (filter.authors) {
        for (const author of filter.authors) {
          pipeline.sRem(`sub:index:author:${author}`, indexKey);
        }
      }

      // Remove from ID indexes
      if (filter.ids) {
        for (const id of filter.ids) {
          pipeline.sRem(`sub:index:id:${id}`, indexKey);
        }
      }

      // Remove from tag indexes
      for (const [key, value] of Object.entries(filter)) {
        if (key.startsWith("#") && Array.isArray(value)) {
          const tagName = key.slice(1);
          for (const tagValue of value) {
            pipeline.sRem(`sub:index:tag:${tagName}:${tagValue}`, indexKey);
          }
        }
      }
    }

    // Remove subscription metadata
    pipeline.del(subKey);
    pipeline.sRem(connKey, subId);

    await pipeline.exec();
  }

  /**
   * Remove all subscriptions for a connection
   * Called when a WebSocket connection closes
   */
  async unsubscribeAll(connId: string): Promise<void> {
    const connKey = `sub:conn:${connId}`;

    // Get all subscription IDs for this connection
    const subIds = await this.redis.sMembers(connKey);

    // Unsubscribe from each
    for (const subId of subIds) {
      await this.unsubscribe(connId, subId);
    }

    // Clean up connection key
    await this.redis.del(connKey);
  }

  /**
   * Find all subscriptions that match an event using inverted indexes
   * Returns a map of connId:subId strings to their full subscription data
   */
  async findMatchingSubscriptions(
    event: NostrEvent,
  ): Promise<Map<string, Subscription>> {
    const candidates = new Set<string>();

    // Get subscriptions from inverted indexes
    const pipeline = this.redis.multi();

    // 1. Subscriptions matching all events
    pipeline.sMembers("sub:index:all");

    // 2. Subscriptions matching this kind
    pipeline.sMembers(`sub:index:kind:${event.kind}`);
    pipeline.sMembers("sub:index:kind:*");

    // 3. Subscriptions matching this author
    pipeline.sMembers(`sub:index:author:${event.pubkey}`);
    pipeline.sMembers("sub:index:author:*");

    // 4. Subscriptions matching this event ID
    pipeline.sMembers(`sub:index:id:${event.id}`);

    // 5. Subscriptions matching tags
    for (const tag of event.tags) {
      if (tag.length >= 2) {
        const tagName = tag[0];
        const tagValue = tag[1];
        pipeline.sMembers(`sub:index:tag:${tagName}:${tagValue}`);
      }
    }

    const results = await pipeline.exec();

    // Collect all candidate subscription IDs
    if (results) {
      for (const result of results) {
        if (result && Array.isArray(result)) {
          for (const indexKey of result) {
            if (typeof indexKey === "string") {
              candidates.add(indexKey);
            }
          }
        }
      }
    }

    // Now fetch subscription metadata for all candidates and verify full filter match
    const matchingSubscriptions = new Map<string, Subscription>();

    for (const indexKey of candidates) {
      // Split on first colon only, since subId can contain colons
      const colonIndex = indexKey.indexOf(":");
      if (colonIndex === -1) {
        console.error(`Invalid indexKey format: ${indexKey}`);
        continue;
      }

      const connId = indexKey.slice(0, colonIndex);
      const subId = indexKey.slice(colonIndex + 1);
      const subKey = `sub:${connId}:${subId}`;

      const subData = await this.redis.hGetAll(subKey);

      if (!subData.filters) {
        continue; // Subscription was deleted
      }

      const subscription: Subscription = {
        connId,
        subId,
        filters: JSON.parse(subData.filters),
        createdAt: parseInt(subData.createdAt),
      };

      // Verify that the event matches at least one filter
      if (this.eventMatchesSubscription(event, subscription)) {
        matchingSubscriptions.set(indexKey, subscription);
      }
    }

    return matchingSubscriptions;
  }

  /**
   * Check if an event matches a subscription's filters
   * A subscription matches if the event matches ANY of its filters (OR)
   */
  private eventMatchesSubscription(
    event: NostrEvent,
    subscription: Subscription,
  ): boolean {
    for (const filter of subscription.filters) {
      if (this.eventMatchesFilter(event, filter)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if an event matches a single filter
   * All conditions in a filter must match (AND)
   */
  private eventMatchesFilter(
    event: NostrEvent,
    filter: NostrFilter,
  ): boolean {
    // Check IDs
    if (filter.ids && filter.ids.length > 0) {
      if (!filter.ids.includes(event.id)) {
        return false;
      }
    }

    // Check authors
    if (filter.authors && filter.authors.length > 0) {
      if (!filter.authors.includes(event.pubkey)) {
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
    if (filter.since !== undefined) {
      if (event.created_at < filter.since) {
        return false;
      }
    }

    // Check until
    if (filter.until !== undefined) {
      if (event.created_at > filter.until) {
        return false;
      }
    }

    // Check tag filters
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tagName = key.slice(1);
        const eventTagValues = event.tags
          .filter((tag) => tag[0] === tagName)
          .map((tag) => tag[1])
          .filter((v) => v !== undefined);

        // At least one value must match
        const hasMatch = values.some((filterValue) =>
          eventTagValues.includes(filterValue)
        );

        if (!hasMatch) {
          return false;
        }
      }
    }

    // Check search (NIP-50) - simplified, just check if content contains search terms
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      const contentLower = event.content.toLowerCase();

      // Remove sort: prefix if present
      const cleanSearch = searchLower.replace(/^sort:\w+\s*/, "").trim();

      if (cleanSearch && !contentLower.includes(cleanSearch)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Refresh TTL for a connection's subscriptions
   * Called periodically to keep active subscriptions alive
   */
  async refreshConnection(connId: string): Promise<void> {
    const connKey = `sub:conn:${connId}`;

    // Get all subscription IDs for this connection
    const subIds = await this.redis.sMembers(connKey);

    if (subIds.length === 0) {
      return;
    }

    const pipeline = this.redis.multi();
    const indexKeysToRefresh = new Set<string>();

    // Refresh TTL on connection key
    pipeline.expire(connKey, 300);

    // Refresh TTL on each subscription and collect index keys
    for (const subId of subIds) {
      const subKey = `sub:${connId}:${subId}`;
      pipeline.expire(subKey, 300);

      // Get subscription filters to find index keys
      const subData = await this.redis.hGetAll(subKey);
      if (subData.filters) {
        const filters: NostrFilter[] = JSON.parse(subData.filters);

        // Collect all index keys for this subscription
        for (const filter of filters) {
          this.collectIndexKeys(connId, subId, filter, indexKeysToRefresh);
        }
      }
    }

    // Refresh TTL on all index keys (600 seconds)
    for (const indexKey of indexKeysToRefresh) {
      pipeline.expire(indexKey, 600);
    }

    await pipeline.exec();
  }

  /**
   * Collect all index keys for a subscription filter
   * Helper method for refreshConnection
   */
  private collectIndexKeys(
    _connId: string,
    _subId: string,
    filter: NostrFilter,
    indexKeys: Set<string>,
  ): void {
    // Check if filter matches everything (no conditions)
    const hasConditions = filter.ids || filter.authors || filter.kinds ||
      filter.since || filter.until || this.hasTagFilters(filter);

    if (!hasConditions) {
      indexKeys.add("sub:index:all");
      return;
    }

    // Index by kind
    if (filter.kinds && filter.kinds.length > 0) {
      for (const kind of filter.kinds) {
        indexKeys.add(`sub:index:kind:${kind}`);
      }
    } else {
      indexKeys.add("sub:index:kind:*");
    }

    // Index by author
    if (filter.authors && filter.authors.length > 0) {
      for (const author of filter.authors) {
        indexKeys.add(`sub:index:author:${author}`);
      }
    } else {
      indexKeys.add("sub:index:author:*");
    }

    // Index by event IDs
    if (filter.ids && filter.ids.length > 0) {
      for (const id of filter.ids) {
        indexKeys.add(`sub:index:id:${id}`);
      }
    }

    // Index by tags
    for (const [key, value] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(value) && value.length > 0) {
        const tagName = key.slice(1);
        for (const tagValue of value) {
          indexKeys.add(`sub:index:tag:${tagName}:${tagValue}`);
        }
      }
    }
  }

  /**
   * Clean up empty index sets
   * Called periodically to remove index keys that have no members
   */
  async cleanupEmptyIndexes(): Promise<number> {
    let cleaned = 0;
    const pattern = "sub:index:*";
    const indexKeys = await this.redis.keys(pattern);

    for (const key of indexKeys) {
      const size = await this.redis.sCard(key);
      if (size === 0) {
        await this.redis.del(key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get statistics about the subscription system
   */
  async getStats(): Promise<{
    totalSubscriptions: number;
    totalConnections: number;
    indexSizes: Record<string, number>;
  }> {
    const pattern = "sub:conn:*";
    const connKeys: string[] = [];

    // Scan for all connection keys using KEYS (simpler for now)
    // In production, you'd want to use SCAN to avoid blocking
    const keys = await this.redis.keys(pattern);
    connKeys.push(...keys);

    const totalConnections = connKeys.length;
    let totalSubscriptions = 0;

    // Count total subscriptions
    for (const connKey of connKeys) {
      const count = await this.redis.sCard(connKey);
      totalSubscriptions += count;
    }

    // Get sizes of various indexes
    const indexSizes: Record<string, number> = {
      all: await this.redis.sCard("sub:index:all"),
      "kind:*": await this.redis.sCard("sub:index:kind:*"),
      "author:*": await this.redis.sCard("sub:index:author:*"),
    };

    return {
      totalSubscriptions,
      totalConnections,
      indexSizes,
    };
  }
}
