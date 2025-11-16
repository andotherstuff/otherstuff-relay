/**
 * Efficient event broadcasting system using Redis indexing
 *
 * Instead of looping through all subscriptions to find matches,
 * we use inverted indexes where events are routed based on their properties.
 *
 * Architecture:
 * 1. Each subscription is indexed by its filter criteria (kind, author, tags)
 * 2. When an event arrives, we query the indexes to find matching subscriptions
 * 3. Only matched subscriptions receive the event
 *
 * Index Structure:
 * - nostr:subs:by-kind:{kind} -> Set of "connId:subId"
 * - nostr:subs:by-author:{pubkey} -> Set of "connId:subId"
 * - nostr:subs:by-tag:{tagName}:{tagValue} -> Set of "connId:subId"
 * - nostr:subs:wildcard -> Set of "connId:subId" (subscriptions with no specific filters)
 */

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import { matchFilter } from "nostr-tools";

// Use a flexible type for Redis client to avoid type conflicts
// deno-lint-ignore no-explicit-any
type RedisClient = any;

/**
 * Index keys for a filter
 * Returns Redis set keys where this subscription should be indexed
 */
export function getFilterIndexKeys(filter: NostrFilter): string[] {
  const keys: string[] = [];

  // Index by kinds
  if (filter.kinds && filter.kinds.length > 0) {
    for (const kind of filter.kinds) {
      keys.push(`nostr:subs:by-kind:${kind}`);
    }
  }

  // Index by authors
  if (filter.authors && filter.authors.length > 0) {
    for (const author of filter.authors) {
      keys.push(`nostr:subs:by-author:${author}`);
    }
  }

  // Index by tags (e, p, a, t, d, r, g)
  const tagKeys = Object.keys(filter).filter((key) => key.startsWith("#"));
  for (const tagKey of tagKeys) {
    const tagName = tagKey.slice(1); // Remove the '#'
    const tagValues = filter[tagKey as keyof NostrFilter] as
      | string[]
      | undefined;

    if (tagValues && tagValues.length > 0) {
      for (const value of tagValues) {
        keys.push(`nostr:subs:by-tag:${tagName}:${value}`);
      }
    }
  }

  // If no specific filters, add to wildcard index
  if (keys.length === 0) {
    keys.push("nostr:subs:wildcard");
  }

  return keys;
}

/**
 * Get index keys to query for an event
 * Returns Redis set keys that might contain matching subscriptions
 */
export function getEventIndexKeys(event: NostrEvent): string[] {
  const keys: string[] = [];

  // Always check wildcard subscriptions
  keys.push("nostr:subs:wildcard");

  // Check kind-specific subscriptions
  keys.push(`nostr:subs:by-kind:${event.kind}`);

  // Check author-specific subscriptions
  keys.push(`nostr:subs:by-author:${event.pubkey}`);

  // Check tag-specific subscriptions
  const commonTags = ["e", "p", "a", "t", "d", "r", "g"];

  for (const tag of event.tags) {
    if (tag.length >= 2) {
      const tagName = tag[0];
      const tagValue = tag[1];

      if (commonTags.includes(tagName)) {
        keys.push(`nostr:subs:by-tag:${tagName}:${tagValue}`);
      }
    }
  }

  return keys;
}

/**
 * Add a subscription to the broadcast indexes
 */
export async function indexSubscription(
  redis: RedisClient,
  connId: string,
  subId: string,
  filters: NostrFilter[],
): Promise<void> {
  const subKey = `${connId}:${subId}`;
  const indexKeys = new Set<string>();

  // Get all index keys for all filters
  for (const filter of filters) {
    const keys = getFilterIndexKeys(filter);
    keys.forEach((key) => indexKeys.add(key));
  }

  // Add subscription to all relevant indexes
  const pipeline = redis.multi();
  for (const indexKey of indexKeys) {
    pipeline.sAdd(indexKey, subKey);
  }
  await pipeline.exec();
}

/**
 * Remove a subscription from the broadcast indexes
 */
export async function unindexSubscription(
  redis: RedisClient,
  connId: string,
  subId: string,
  filters: NostrFilter[],
): Promise<void> {
  const subKey = `${connId}:${subId}`;
  const indexKeys = new Set<string>();

  // Get all index keys for all filters
  for (const filter of filters) {
    const keys = getFilterIndexKeys(filter);
    keys.forEach((key) => indexKeys.add(key));
  }

  // Remove subscription from all indexes
  const pipeline = redis.multi();
  for (const indexKey of indexKeys) {
    pipeline.sRem(indexKey, subKey);
  }
  await pipeline.exec();
}

/**
 * Remove all subscriptions for a connection from indexes
 */
export async function cleanupConnection(
  redis: RedisClient,
  connId: string,
): Promise<void> {
  // Get all index keys
  const indexKeys = await redis.keys("nostr:subs:by-*");
  indexKeys.push("nostr:subs:wildcard");

  // Remove all entries matching this connId
  // We need to fetch members first, then remove in a pipeline
  const toRemove: Array<{ indexKey: string; member: string }> = [];
  
  for (const indexKey of indexKeys) {
    // Get all members and filter by connId prefix
    const members = await redis.sMembers(indexKey);
    for (const member of members) {
      if (member.startsWith(`${connId}:`)) {
        toRemove.push({ indexKey, member });
      }
    }
  }

  // Now remove all in a pipeline
  if (toRemove.length > 0) {
    const pipeline = redis.multi();
    for (const { indexKey, member } of toRemove) {
      pipeline.sRem(indexKey, member);
    }
    await pipeline.exec();
  }
}

/**
 * Find matching subscriptions for an event
 * Returns a map of connId:subId -> filters
 */
export async function findMatchingSubscriptions(
  redis: RedisClient,
  event: NostrEvent,
): Promise<Map<string, NostrFilter[]>> {
  const indexKeys = getEventIndexKeys(event);

  // Get all potentially matching subscription keys using SUNION
  const subKeys = await redis.sUnion(indexKeys);

  if (subKeys.length === 0) {
    return new Map();
  }

  // Fetch the actual filters for each subscription
  const matches = new Map<string, NostrFilter[]>();

  for (const subKey of subKeys) {
    const [connId, subId] = subKey.split(":");
    const filtersJson = await redis.hGet(`nostr:subs:${connId}`, subId);

    if (filtersJson) {
      try {
        const filters = JSON.parse(filtersJson) as NostrFilter[];

        // Verify the event actually matches at least one filter
        let matched = false;
        for (const filter of filters) {
          if (matchFilter(filter, event)) {
            matched = true;
            break;
          }
        }

        if (matched) {
          matches.set(subKey, filters);
        }
      } catch (error) {
        console.error(`Failed to parse filters for ${subKey}:`, error);
      }
    }
  }

  return matches;
}
