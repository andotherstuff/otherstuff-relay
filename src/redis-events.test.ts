/**
 * Test RedisEvents functionality
 */
import { assertEquals, assertExists } from "@std/assert";
import { RedisEvents } from "./redis-events.ts";
import { Config } from "./config.ts";
import type { NostrEvent } from "@nostrify/nostrify";

// Mock config for testing
const testConfig = new Config({
  get: (key: string) => {
    switch (key) {
      case "REDIS_URL":
        return "redis://localhost:6379/1"; // Use database 1 for testing
      case "HOT_EVENTS_TTL":
        return "60"; // 1 minute TTL for tests
      default:
        return undefined;
    }
  },
});

async function cleanupRedis(redisEvents: RedisEvents, eventIds: string[], pubkeys: string[], kinds: number[]) {
  for (const id of eventIds) {
    try {
      await redisEvents.redis.del(`nostr:event:${id}`);
      await redisEvents.redis.zRem("nostr:events:by_time", id);
    } catch (_e) {
      // Ignore cleanup errors
    }
  }
  
  for (const pubkey of pubkeys) {
    try {
      await redisEvents.redis.del(`nostr:events:by_author:${pubkey}`);
    } catch (_e) {
      // Ignore cleanup errors
    }
  }
  
  for (const kind of kinds) {
    try {
      await redisEvents.redis.del(`nostr:events:by_kind:${kind}`);
    } catch (_e) {
      // Ignore cleanup errors
    }
  }
}

Deno.test("RedisEvents - store and retrieve event", async () => {
  const redisEvents = new RedisEvents(testConfig);
  await redisEvents.connect();

  try {
    const testEvent: NostrEvent = {
      id: "test123",
      pubkey: "testpubkey",
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      content: "Hello, Redis!",
      tags: [["t", "test"]],
      sig: "testsignature",
    };

    // Store the event
    await redisEvents.storeEvent(testEvent);

    // Retrieve the event
    const retrieved = await redisEvents.getEvent("test123");
    assertExists(retrieved);
    assertEquals(retrieved.id, testEvent.id);
    assertEquals(retrieved.content, testEvent.content);
    assertEquals(retrieved.kind, testEvent.kind);

    // Clean up
    await cleanupRedis(redisEvents, ["test123"], ["testpubkey"], [1]);

  } finally {
    await redisEvents.close();
  }
});

Deno.test("RedisEvents - query by filter", async () => {
  const redisEvents = new RedisEvents(testConfig);
  await redisEvents.connect();

  try {
    const testEvent: NostrEvent = {
      id: "test456",
      pubkey: "testpubkey2",
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      content: "Test query",
      tags: [["t", "querytest"]],
      sig: "testsignature2",
    };

    // Store the event
    await redisEvents.storeEvent(testEvent);

    // Query by kind
    const results = await redisEvents.queryEvents([{ kinds: [1] }]);
    const found = results.find(e => e.id === "test456");
    assertExists(found);
    assertEquals(found.content, "Test query");

    // Query by author
    const authorResults = await redisEvents.queryEvents([{ authors: ["testpubkey2"] }]);
    const foundByAuthor = authorResults.find(e => e.id === "test456");
    assertExists(foundByAuthor);

    // Clean up
    await cleanupRedis(redisEvents, ["test456"], ["testpubkey2"], [1]);

  } finally {
    await redisEvents.close();
  }
});

Deno.test("RedisEvents - query with tag filter", async () => {
  const redisEvents = new RedisEvents(testConfig);
  await redisEvents.connect();

  try {
    const testEvent: NostrEvent = {
      id: "test789",
      pubkey: "testpubkey3",
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      content: "Test tag query",
      tags: [["p", "targetpubkey"], ["e", "targetevent"]],
      sig: "testsignature3",
    };

    // Store the event
    await redisEvents.storeEvent(testEvent);

    // Query by tag
    const results = await redisEvents.queryEvents([{ "#p": ["targetpubkey"] }]);
    const found = results.find(e => e.id === "test789");
    assertExists(found);
    assertEquals(found.content, "Test tag query");

    // Clean up
    await cleanupRedis(redisEvents, ["test789"], ["testpubkey3"], [1]);

  } finally {
    await redisEvents.close();
  }
});