import { assertEquals } from "@std/assert";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import { getRelayInformation } from "./relay-info.ts";

// Helper to create a fresh Redis connection
async function setup() {
  const redis: RedisClientType = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();
  return redis;
}

// Clean up test data
async function cleanup(redis: RedisClientType) {
  await redis.del("relay:metadata:name");
  await redis.del("relay:metadata:description");
  await redis.del("relay:metadata:icon");
  await redis.del("relay:allowed:pubkeys");
  await redis.del("relay:allowed:kinds");
  await redis.del("relay:banned:pubkeys");
  await redis.quit();
}

Deno.test("getRelayInformation - basic info", async () => {
  const redis = await setup();

  const info = await getRelayInformation(redis);

  // Check required fields
  assertEquals(typeof info.software, "string");
  assertEquals(typeof info.version, "string");
  assertEquals(Array.isArray(info.supported_nips), true);
  assertEquals(info.supported_nips.includes(1), true);
  assertEquals(info.supported_nips.includes(11), true);
  assertEquals(info.supported_nips.includes(86), true);

  // Check limitations exist
  assertEquals(typeof info.limitation, "object");
  assertEquals(typeof info.limitation?.max_message_length, "number");
  assertEquals(typeof info.limitation?.max_subscriptions, "number");

  await cleanup(redis);
});

Deno.test("getRelayInformation - static config", async () => {
  const redis = await setup();

  const info = await getRelayInformation(redis, {
    name: "Test Relay",
    description: "A test relay",
    icon: "https://example.com/icon.png",
    pubkey: "a".repeat(64),
    contact: "admin@example.com",
  });

  assertEquals(info.name, "Test Relay");
  assertEquals(info.description, "A test relay");
  assertEquals(info.icon, "https://example.com/icon.png");
  assertEquals(info.pubkey, "a".repeat(64));
  assertEquals(info.contact, "admin@example.com");

  await cleanup(redis);
});

Deno.test("getRelayInformation - dynamic metadata from Redis", async () => {
  const redis = await setup();

  // Set metadata in Redis (as NIP-86 would do)
  await redis.set("relay:metadata:name", "Dynamic Name");
  await redis.set("relay:metadata:description", "Dynamic Description");
  await redis.set("relay:metadata:icon", "https://example.com/dynamic.png");

  const info = await getRelayInformation(redis, {
    name: "Static Name",
    description: "Static Description",
    icon: "https://example.com/static.png",
  });

  // Dynamic values should override static
  assertEquals(info.name, "Dynamic Name");
  assertEquals(info.description, "Dynamic Description");
  assertEquals(info.icon, "https://example.com/dynamic.png");

  await cleanup(redis);
});

Deno.test("getRelayInformation - restricted writes detection", async () => {
  const redis = await setup();

  // Initially not restricted
  let info = await getRelayInformation(redis);
  assertEquals(info.limitation?.restricted_writes, false);

  // Add an allowed pubkey
  await redis.hSet("relay:allowed:pubkeys", "a".repeat(64), "trusted");

  info = await getRelayInformation(redis);
  assertEquals(info.limitation?.restricted_writes, true);

  await redis.del("relay:allowed:pubkeys");

  // Add an allowed kind
  await redis.sAdd("relay:allowed:kinds", "1");

  info = await getRelayInformation(redis);
  assertEquals(info.limitation?.restricted_writes, true);

  await redis.del("relay:allowed:kinds");

  // Add a banned pubkey
  await redis.hSet("relay:banned:pubkeys", "b".repeat(64), "spam");

  info = await getRelayInformation(redis);
  assertEquals(info.limitation?.restricted_writes, true);

  await cleanup(redis);
});

Deno.test("getRelayInformation - retention policy", async () => {
  const redis = await setup();

  const info = await getRelayInformation(redis);

  assertEquals(Array.isArray(info.retention), true);
  assertEquals(info.retention!.length > 0, true);

  await cleanup(redis);
});

Deno.test("getRelayInformation - CORS headers not in response", async () => {
  const redis = await setup();

  const info = await getRelayInformation(redis);

  // The function returns the info object, not HTTP headers
  // Headers are added by the server endpoint
  assertEquals(typeof info, "object");
  assertEquals(info.software, "https://github.com/lez/otherstuff-relay");

  await cleanup(redis);
});
