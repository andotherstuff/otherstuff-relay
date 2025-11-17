import { assertEquals } from "@std/assert";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import { RelayManagement } from "./management.ts";
import type { NostrFilter, NRelay } from "@nostrify/nostrify";

// Helper to create a fresh Redis connection and management instance
async function setup() {
  const redis: RedisClientType = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();
  const management = new RelayManagement(redis);
  return { redis, management };
}

// Clean up test data
async function cleanup(redis: RedisClientType) {
  await redis.del("relay:banned:pubkeys");
  await redis.del("relay:allowed:pubkeys");
  await redis.del("relay:banned:events");
  await redis.del("relay:allowed:kinds");
  await redis.del("relay:blocked:ips");
  await redis.del("relay:metadata:name");
  await redis.del("relay:metadata:description");
  await redis.del("relay:metadata:icon");
  await redis.quit();
}

Deno.test("RelayManagement - ban and list pubkeys", async () => {
  const { redis, management } = await setup();

  const pubkey1 = "a".repeat(64);
  const pubkey2 = "b".repeat(64);

  // Record bans (without relay, so no deletion)
  await management.recordBanPubkey(pubkey1, "spam");
  await management.recordBanPubkey(pubkey2);

  // Check if banned
  assertEquals(await management.isPubkeyBanned(pubkey1), true);
  assertEquals(await management.isPubkeyBanned(pubkey2), true);
  assertEquals(await management.isPubkeyBanned("c".repeat(64)), false);

  // List banned pubkeys
  const banned = await management.listBannedPubkeys();
  assertEquals(banned.length, 2);
  assertEquals(
    banned.find((b) => b.pubkey === pubkey1)?.reason,
    "spam",
  );
  assertEquals(
    banned.find((b) => b.pubkey === pubkey2)?.reason,
    undefined,
  );

  await cleanup(redis);
});

Deno.test("RelayManagement - allow pubkeys (allowlist)", async () => {
  const { redis, management } = await setup();

  const pubkey1 = "a".repeat(64);
  const pubkey2 = "b".repeat(64);
  const pubkey3 = "c".repeat(64);

  // Initially, all pubkeys are allowed (empty allowlist)
  assertEquals(await management.isPubkeyAllowed(pubkey1), true);
  assertEquals(await management.isPubkeyAllowed(pubkey2), true);

  // Add to allowlist
  await management.allowPubkey(pubkey1, "trusted");
  await management.allowPubkey(pubkey2);

  // Now only allowlisted pubkeys are allowed
  assertEquals(await management.isPubkeyAllowed(pubkey1), true);
  assertEquals(await management.isPubkeyAllowed(pubkey2), true);
  assertEquals(await management.isPubkeyAllowed(pubkey3), false);

  // List allowed pubkeys
  const allowed = await management.listAllowedPubkeys();
  assertEquals(allowed.length, 2);

  await cleanup(redis);
});

Deno.test("RelayManagement - ban and allow events", async () => {
  const { redis, management } = await setup();

  const eventId1 = "1".repeat(64);
  const eventId2 = "2".repeat(64);

  // Record bans (without relay, so no deletion)
  await management.recordBanEvent(eventId1, "illegal content");
  await management.recordBanEvent(eventId2);

  // Check if banned
  assertEquals(await management.isEventBanned(eventId1), true);
  assertEquals(await management.isEventBanned(eventId2), true);

  // List banned events
  const banned = await management.listBannedEvents();
  assertEquals(banned.length, 2);

  // Allow event (remove from ban list)
  await management.allowEvent(eventId1);
  assertEquals(await management.isEventBanned(eventId1), false);
  assertEquals(await management.isEventBanned(eventId2), true);

  await cleanup(redis);
});

Deno.test("RelayManagement - allow and disallow kinds", async () => {
  const { redis, management } = await setup();

  // Initially, all kinds are allowed (empty allowlist)
  assertEquals(await management.isKindAllowed(1), true);
  assertEquals(await management.isKindAllowed(7), true);

  // Add kinds to allowlist
  await management.allowKind(1);
  await management.allowKind(7);

  // Now only allowlisted kinds are allowed
  assertEquals(await management.isKindAllowed(1), true);
  assertEquals(await management.isKindAllowed(7), true);
  assertEquals(await management.isKindAllowed(3), false);

  // List allowed kinds
  const allowed = await management.listAllowedKinds();
  assertEquals(allowed.length, 2);
  assertEquals(allowed.includes(1), true);
  assertEquals(allowed.includes(7), true);

  // Disallow a kind
  await management.disallowKind(7);
  assertEquals(await management.isKindAllowed(7), false);

  await cleanup(redis);
});

Deno.test("RelayManagement - block and unblock IPs", async () => {
  const { redis, management } = await setup();

  const ip1 = "192.168.1.1";
  const ip2 = "10.0.0.1";

  // Block IPs
  await management.blockIP(ip1, "abuse");
  await management.blockIP(ip2);

  // Check if blocked
  assertEquals(await management.isIPBlocked(ip1), true);
  assertEquals(await management.isIPBlocked(ip2), true);
  assertEquals(await management.isIPBlocked("127.0.0.1"), false);

  // List blocked IPs
  const blocked = await management.listBlockedIPs();
  assertEquals(blocked.length, 2);

  // Unblock IP
  await management.unblockIP(ip1);
  assertEquals(await management.isIPBlocked(ip1), false);
  assertEquals(await management.isIPBlocked(ip2), true);

  await cleanup(redis);
});

Deno.test("RelayManagement - relay metadata", async () => {
  const { redis, management } = await setup();

  // Set metadata
  await management.setRelayName("Test Relay");
  await management.setRelayDescription("A test relay for unit tests");
  await management.setRelayIcon("https://example.com/icon.png");

  // Get metadata
  assertEquals(await management.getRelayName(), "Test Relay");
  assertEquals(
    await management.getRelayDescription(),
    "A test relay for unit tests",
  );
  assertEquals(await management.getRelayIcon(), "https://example.com/icon.png");

  await cleanup(redis);
});

Deno.test("RelayManagement - supported methods", async () => {
  const { redis, management } = await setup();

  const methods = management.getSupportedMethods();

  // Check that all required methods are present
  const requiredMethods = [
    "supportedmethods",
    "banpubkey",
    "listbannedpubkeys",
    "allowpubkey",
    "listallowedpubkeys",
    "banevent",
    "allowevent",
    "listbannedevents",
    "allowkind",
    "disallowkind",
    "listallowedkinds",
    "blockip",
    "unblockip",
    "listblockedips",
    "changerelayname",
    "changerelaydescription",
    "changerelayicon",
  ];

  for (const method of requiredMethods) {
    assertEquals(
      methods.includes(method),
      true,
      `Missing method: ${method}`,
    );
  }

  await cleanup(redis);
});

Deno.test("RelayManagement - banPubkey calls relay.remove()", async () => {
  const redis: RedisClientType = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();

  // Mock relay that tracks remove() calls
  const removeCalls: NostrFilter[][] = [];
  const mockRelay: Partial<NRelay> = {
    remove: (filters: NostrFilter[]) => {
      removeCalls.push(filters);
      return Promise.resolve();
    },
  };

  const management = new RelayManagement(redis, mockRelay as NRelay);

  const pubkey = "a".repeat(64);
  await management.banPubkey(pubkey, "spam");

  // Verify remove was called with correct filter
  assertEquals(removeCalls.length, 1);
  assertEquals(removeCalls[0], [{ authors: [pubkey] }]);

  await cleanup(redis);
});

Deno.test("RelayManagement - banEvent calls relay.remove()", async () => {
  const redis: RedisClientType = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();

  // Mock relay that tracks remove() calls
  const removeCalls: NostrFilter[][] = [];
  const mockRelay: Partial<NRelay> = {
    remove: (filters: NostrFilter[]) => {
      removeCalls.push(filters);
      return Promise.resolve();
    },
  };

  const management = new RelayManagement(redis, mockRelay as NRelay);

  const eventId = "1".repeat(64);
  await management.banEvent(eventId, "illegal");

  // Verify remove was called with correct filter
  assertEquals(removeCalls.length, 1);
  assertEquals(removeCalls[0], [{ ids: [eventId] }]);

  await cleanup(redis);
});

Deno.test("RelayManagement - banPubkey throws without relay", async () => {
  const redis: RedisClientType = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();

  const management = new RelayManagement(redis); // No relay provided

  const pubkey = "a".repeat(64);

  try {
    await management.banPubkey(pubkey, "spam");
    throw new Error("Should have thrown an error");
  } catch (error) {
    assertEquals(
      (error as Error).message,
      "Cannot ban pubkey: relay not available for deletion. " +
        "Use RelayManagement with a relay instance, or call recordBanPubkey() to only record the ban.",
    );
  }

  await cleanup(redis);
});

Deno.test("RelayManagement - banEvent throws without relay", async () => {
  const redis: RedisClientType = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();

  const management = new RelayManagement(redis); // No relay provided

  const eventId = "1".repeat(64);

  try {
    await management.banEvent(eventId, "illegal");
    throw new Error("Should have thrown an error");
  } catch (error) {
    assertEquals(
      (error as Error).message,
      "Cannot ban event: relay not available for deletion. " +
        "Use RelayManagement with a relay instance, or call recordBanEvent() to only record the ban.",
    );
  }

  await cleanup(redis);
});
