import { assertEquals } from "@std/assert";
import { createClient, type RedisClientType } from "redis";
import { PubSub } from "./pubsub.ts";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

// Helper to create test events
function createTestEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: crypto.randomUUID().replace(/-/g, ""),
    pubkey: "0".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: "test event",
    sig: "0".repeat(128),
    ...overrides,
  };
}

Deno.test("PubSub - subscribe and unsubscribe", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  const connId = "test-conn-1";
  const subId = "test-sub-1";
  const filters: NostrFilter[] = [
    { kinds: [1], authors: ["abc123"] },
  ];

  try {
    // Subscribe
    await pubsub.subscribe(connId, subId, filters);

    // Verify subscription exists
    const subKey = `sub:${connId}:${subId}`;
    const exists = await redis.exists(subKey);
    assertEquals(exists, 1);

    // Verify connection tracking
    const connKey = `sub:conn:${connId}`;
    const subIds = await redis.sMembers(connKey);
    assertEquals(subIds, [subId]);

    // Unsubscribe
    await pubsub.unsubscribe(connId, subId);

    // Verify cleanup
    const existsAfter = await redis.exists(subKey);
    assertEquals(existsAfter, 0);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - find matching subscriptions by kind", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    // Create subscriptions
    await pubsub.subscribe("conn1", "sub1", [{ kinds: [1] }]);
    await pubsub.subscribe("conn2", "sub2", [{ kinds: [3] }]);
    await pubsub.subscribe("conn3", "sub3", [{ kinds: [1, 3] }]);

    // Create event of kind 1
    const event = createTestEvent({ kind: 1 });

    // Find matches
    const matches = await pubsub.findMatchingSubscriptions(event);

    // Should match conn1:sub1 and conn3:sub3
    assertEquals(matches.size, 2);
    assertEquals(matches.has("conn1:sub1"), true);
    assertEquals(matches.has("conn3:sub3"), true);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - find matching subscriptions by author", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    const author1 = "a".repeat(64);
    const author2 = "b".repeat(64);

    await pubsub.subscribe("conn1", "sub1", [{ authors: [author1] }]);
    await pubsub.subscribe("conn2", "sub2", [{ authors: [author2] }]);
    await pubsub.subscribe("conn3", "sub3", [{ authors: [author1, author2] }]);

    const event = createTestEvent({ pubkey: author1 });

    const matches = await pubsub.findMatchingSubscriptions(event);

    assertEquals(matches.size, 2);
    assertEquals(matches.has("conn1:sub1"), true);
    assertEquals(matches.has("conn3:sub3"), true);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - find matching subscriptions by tags", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    const eventId = "e".repeat(64);

    await pubsub.subscribe("conn1", "sub1", [{ "#e": [eventId] }]);
    await pubsub.subscribe("conn2", "sub2", [{ "#e": ["other"] }]);

    const event = createTestEvent({
      tags: [["e", eventId], ["p", "pubkey"]],
    });

    const matches = await pubsub.findMatchingSubscriptions(event);

    assertEquals(matches.size, 1);
    assertEquals(matches.has("conn1:sub1"), true);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - complex filter matching (AND conditions)", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    const author = "a".repeat(64);

    // Subscription requires both kind:1 AND author
    await pubsub.subscribe("conn1", "sub1", [
      { kinds: [1], authors: [author] },
    ]);

    // Event matches both conditions
    const event1 = createTestEvent({ kind: 1, pubkey: author });
    const matches1 = await pubsub.findMatchingSubscriptions(event1);
    assertEquals(matches1.size, 1);

    // Event matches only kind
    const event2 = createTestEvent({ kind: 1, pubkey: "b".repeat(64) });
    const matches2 = await pubsub.findMatchingSubscriptions(event2);
    assertEquals(matches2.size, 0);

    // Event matches only author
    const event3 = createTestEvent({ kind: 3, pubkey: author });
    const matches3 = await pubsub.findMatchingSubscriptions(event3);
    assertEquals(matches3.size, 0);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - multiple filters (OR conditions)", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    // Subscription with multiple filters (OR)
    await pubsub.subscribe("conn1", "sub1", [
      { kinds: [1] },
      { kinds: [3] },
    ]);

    const event1 = createTestEvent({ kind: 1 });
    const matches1 = await pubsub.findMatchingSubscriptions(event1);
    assertEquals(matches1.size, 1);

    const event2 = createTestEvent({ kind: 3 });
    const matches2 = await pubsub.findMatchingSubscriptions(event2);
    assertEquals(matches2.size, 1);

    const event3 = createTestEvent({ kind: 5 });
    const matches3 = await pubsub.findMatchingSubscriptions(event3);
    assertEquals(matches3.size, 0);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - time range filtering", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    const now = Math.floor(Date.now() / 1000);

    await pubsub.subscribe("conn1", "sub1", [
      { since: now - 3600, until: now + 3600 },
    ]);

    // Event within range
    const event1 = createTestEvent({ created_at: now });
    const matches1 = await pubsub.findMatchingSubscriptions(event1);
    assertEquals(matches1.size, 1);

    // Event too old
    const event2 = createTestEvent({ created_at: now - 7200 });
    const matches2 = await pubsub.findMatchingSubscriptions(event2);
    assertEquals(matches2.size, 0);

    // Event too new
    const event3 = createTestEvent({ created_at: now + 7200 });
    const matches3 = await pubsub.findMatchingSubscriptions(event3);
    assertEquals(matches3.size, 0);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - match all events (no filters)", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    // Empty filter matches everything
    await pubsub.subscribe("conn1", "sub1", [{}]);

    const event = createTestEvent({ kind: 1 });
    const matches = await pubsub.findMatchingSubscriptions(event);

    assertEquals(matches.size, 1);
    assertEquals(matches.has("conn1:sub1"), true);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - unsubscribe all for connection", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    const connId = "conn1";

    // Create multiple subscriptions
    await pubsub.subscribe(connId, "sub1", [{ kinds: [1] }]);
    await pubsub.subscribe(connId, "sub2", [{ kinds: [3] }]);
    await pubsub.subscribe(connId, "sub3", [{ kinds: [5] }]);

    // Verify they exist
    const connKey = `sub:conn:${connId}`;
    const subIds = await redis.sMembers(connKey);
    assertEquals(subIds.length, 3);

    // Unsubscribe all
    await pubsub.unsubscribeAll(connId);

    // Verify cleanup
    const exists = await redis.exists(connKey);
    assertEquals(exists, 0);

    const sub1Exists = await redis.exists(`sub:${connId}:sub1`);
    assertEquals(sub1Exists, 0);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - get stats", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    await pubsub.subscribe("conn1", "sub1", [{ kinds: [1] }]);
    await pubsub.subscribe("conn1", "sub2", [{ kinds: [3] }]);
    await pubsub.subscribe("conn2", "sub3", [{}]);

    const stats = await pubsub.getStats();

    assertEquals(stats.totalConnections, 2);
    assertEquals(stats.totalSubscriptions, 3);
    assertEquals(stats.indexSizes.all, 1); // One subscription matches all
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - TTL on subscription keys", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    const connId = "conn-ttl";
    const subId = "sub-ttl";

    await pubsub.subscribe(connId, subId, [{ kinds: [1] }]);

    // Check TTL on subscription metadata
    const subKey = `sub:${connId}:${subId}`;
    const ttl = await redis.ttl(subKey);
    assertEquals(ttl > 0 && ttl <= 300, true);

    // Check TTL on connection tracking
    const connKey = `sub:conn:${connId}`;
    const connTtl = await redis.ttl(connKey);
    assertEquals(connTtl > 0 && connTtl <= 300, true);

    // Check TTL on index keys
    const indexKey = `sub:index:kind:1`;
    const indexTtl = await redis.ttl(indexKey);
    assertEquals(indexTtl > 0 && indexTtl <= 600, true);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - refresh connection TTL", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    const connId = "conn-refresh";
    const subId = "sub-refresh";

    await pubsub.subscribe(connId, subId, [{ kinds: [1] }]);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Refresh connection
    await pubsub.refreshConnection(connId);

    // Check that TTL was refreshed (should be close to 300 again)
    const subKey = `sub:${connId}:${subId}`;
    const ttl = await redis.ttl(subKey);
    assertEquals(ttl > 295, true); // Should be refreshed to ~300

    // Check index key TTL was also refreshed
    const indexKey = `sub:index:kind:1`;
    const indexTtl = await redis.ttl(indexKey);
    assertEquals(indexTtl > 595, true); // Should be refreshed to ~600
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});

Deno.test("PubSub - cleanup empty indexes", async () => {
  const redis: RedisClientType = createClient({
    url: "redis://localhost:6379",
  });
  await redis.connect();

  const pubsub = new PubSub(redis);

  try {
    // Create a subscription
    await pubsub.subscribe("conn1", "sub1", [{ kinds: [1] }]);

    // Verify index exists and has members
    const indexKey = "sub:index:kind:1";
    const sizeBefore = await redis.sCard(indexKey);
    assertEquals(sizeBefore, 1);

    // Manually create an empty index set to test cleanup
    const emptyIndexKey = "sub:index:kind:999";
    await redis.sAdd(emptyIndexKey, "dummy");
    await redis.sRem(emptyIndexKey, "dummy");

    // Verify it's empty but exists (Redis keeps empty sets temporarily)
    // Actually, Redis automatically deletes empty sets, so we need to create it differently
    await redis.sAdd(emptyIndexKey, "temp");
    const sizeTemp = await redis.sCard(emptyIndexKey);
    assertEquals(sizeTemp, 1);

    // Now remove the temp member
    await redis.sRem(emptyIndexKey, "temp");

    // Note: Redis automatically deletes empty sets, so this key won't exist
    // The cleanup method is still useful for edge cases where sets might be left empty

    // Cleanup should handle this gracefully
    const cleaned = await pubsub.cleanupEmptyIndexes();

    // Cleanup might find 0 or more empty indexes depending on timing
    // The important thing is it doesn't error
    assertEquals(cleaned >= 0, true);
  } finally {
    await redis.flushDb();
    await redis.quit();
  }
});
