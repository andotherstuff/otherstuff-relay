/**
 * Tests for the broadcast indexing system
 */

import { assertEquals } from "@std/assert";
import { getEventIndexKeys, getFilterIndexKeys } from "./broadcast.ts";
import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

Deno.test("getFilterIndexKeys - kind filter", () => {
  const filter: NostrFilter = { kinds: [1, 6, 7] };
  const keys = getFilterIndexKeys(filter);

  assertEquals(
    keys.sort(),
    [
      "nostr:subs:by-kind:1",
      "nostr:subs:by-kind:6",
      "nostr:subs:by-kind:7",
    ].sort(),
  );
});

Deno.test("getFilterIndexKeys - author filter", () => {
  const filter: NostrFilter = { authors: ["abc123", "def456"] };
  const keys = getFilterIndexKeys(filter);

  assertEquals(
    keys.sort(),
    [
      "nostr:subs:by-author:abc123",
      "nostr:subs:by-author:def456",
    ].sort(),
  );
});

Deno.test("getFilterIndexKeys - tag filter", () => {
  const filter: NostrFilter = { "#p": ["user1", "user2"], "#e": ["event1"] };
  const keys = getFilterIndexKeys(filter);

  assertEquals(
    keys.sort(),
    [
      "nostr:subs:by-tag:p:user1",
      "nostr:subs:by-tag:p:user2",
      "nostr:subs:by-tag:e:event1",
    ].sort(),
  );
});

Deno.test("getFilterIndexKeys - combined filters", () => {
  const filter: NostrFilter = {
    kinds: [1],
    authors: ["abc123"],
    "#p": ["user1"],
  };
  const keys = getFilterIndexKeys(filter);

  assertEquals(
    keys.sort(),
    [
      "nostr:subs:by-kind:1",
      "nostr:subs:by-author:abc123",
      "nostr:subs:by-tag:p:user1",
    ].sort(),
  );
});

Deno.test("getFilterIndexKeys - wildcard (empty filter)", () => {
  const filter: NostrFilter = {};
  const keys = getFilterIndexKeys(filter);

  assertEquals(keys, ["nostr:subs:wildcard"]);
});

Deno.test("getFilterIndexKeys - time-based only (wildcard)", () => {
  const filter: NostrFilter = { since: 1000000, until: 2000000 };
  const keys = getFilterIndexKeys(filter);

  assertEquals(keys, ["nostr:subs:wildcard"]);
});

Deno.test("getEventIndexKeys - basic event", () => {
  const event: NostrEvent = {
    id: "event1",
    pubkey: "author1",
    created_at: 1000000,
    kind: 1,
    tags: [],
    content: "Hello world",
    sig: "sig1",
  };
  const keys = getEventIndexKeys(event);

  assertEquals(
    keys.sort(),
    [
      "nostr:subs:wildcard",
      "nostr:subs:by-kind:1",
      "nostr:subs:by-author:author1",
    ].sort(),
  );
});

Deno.test("getEventIndexKeys - event with tags", () => {
  const event: NostrEvent = {
    id: "event1",
    pubkey: "author1",
    created_at: 1000000,
    kind: 1,
    tags: [
      ["p", "user1"],
      ["e", "event0"],
      ["t", "bitcoin"],
    ],
    content: "Hello world",
    sig: "sig1",
  };
  const keys = getEventIndexKeys(event);

  assertEquals(
    keys.sort(),
    [
      "nostr:subs:wildcard",
      "nostr:subs:by-kind:1",
      "nostr:subs:by-author:author1",
      "nostr:subs:by-tag:p:user1",
      "nostr:subs:by-tag:e:event0",
      "nostr:subs:by-tag:t:bitcoin",
    ].sort(),
  );
});

Deno.test("getEventIndexKeys - ignores uncommon tags", () => {
  const event: NostrEvent = {
    id: "event1",
    pubkey: "author1",
    created_at: 1000000,
    kind: 1,
    tags: [
      ["p", "user1"],
      ["custom", "value"], // Should be ignored
      ["xyz", "abc"], // Should be ignored
    ],
    content: "Hello world",
    sig: "sig1",
  };
  const keys = getEventIndexKeys(event);

  // Should only include wildcard, kind, author, and p tag
  assertEquals(
    keys.sort(),
    [
      "nostr:subs:wildcard",
      "nostr:subs:by-kind:1",
      "nostr:subs:by-author:author1",
      "nostr:subs:by-tag:p:user1",
    ].sort(),
  );
});

Deno.test("getEventIndexKeys - handles all common tags", () => {
  const event: NostrEvent = {
    id: "event1",
    pubkey: "author1",
    created_at: 1000000,
    kind: 30023,
    tags: [
      ["e", "event0"],
      ["p", "user1"],
      ["a", "30023:author2:article1"],
      ["t", "nostr"],
      ["d", "my-article"],
      ["r", "https://example.com"],
      ["g", "geohash123"],
    ],
    content: "Article content",
    sig: "sig1",
  };
  const keys = getEventIndexKeys(event);

  assertEquals(
    keys.sort(),
    [
      "nostr:subs:wildcard",
      "nostr:subs:by-kind:30023",
      "nostr:subs:by-author:author1",
      "nostr:subs:by-tag:e:event0",
      "nostr:subs:by-tag:p:user1",
      "nostr:subs:by-tag:a:30023:author2:article1",
      "nostr:subs:by-tag:t:nostr",
      "nostr:subs:by-tag:d:my-article",
      "nostr:subs:by-tag:r:https://example.com",
      "nostr:subs:by-tag:g:geohash123",
    ].sort(),
  );
});
