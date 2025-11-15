import { assertEquals } from "@std/assert";
import { Client } from "@opensearch-project/opensearch";
import { OpenSearchRelay } from "./opensearch.ts";
import { Config } from "./config.ts";
import { genEvent } from "@nostrify/nostrify/test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { NostrEvent } from "@nostrify/nostrify";

// Setup and teardown
async function setupRelay(): Promise<OpenSearchRelay> {
  const config = new Config(Deno.env);

  interface OpenSearchConfig {
    node: string;
    auth?: {
      username: string;
      password: string;
    };
  }

  const opensearchConfig: OpenSearchConfig = {
    node: config.opensearchUrl,
  };

  if (config.opensearchUsername && config.opensearchPassword) {
    opensearchConfig.auth = {
      username: config.opensearchUsername,
      password: config.opensearchPassword,
    };
  }

  const opensearch = new Client(opensearchConfig);

  const relay = new OpenSearchRelay(opensearch);

  // Run migrations to ensure index exists
  await relay.migrate();

  // Clean up test data
  try {
    await opensearch.deleteByQuery({
      index: "nostr-events",
      body: {
        query: {
          match_all: {},
        },
      },
      refresh: true,
    });
  } catch {
    // Index might not exist yet
  }

  return relay;
}

Deno.test({
  name: "OpenSearchRelay - migrate creates index",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using _relay = await setupRelay();

    const config = new Config(Deno.env);

    interface OpenSearchConfig {
      node: string;
      auth?: {
        username: string;
        password: string;
      };
    }

    const opensearchConfig: OpenSearchConfig = { node: config.opensearchUrl };
    if (config.opensearchUsername && config.opensearchPassword) {
      opensearchConfig.auth = {
        username: config.opensearchUsername,
        password: config.opensearchPassword,
      };
    }
    const opensearch = new Client(opensearchConfig);

    const indexExists = await opensearch.indices.exists({
      index: "nostr-events",
    });

    assertEquals(indexExists.body, true, "nostr-events index should exist");
  },
});

Deno.test({
  name: "OpenSearchRelay - event() inserts a single event",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const testEvent = genEvent({ kind: 1, content: "Test metadata event" });

    await relay.event(testEvent);

    // Wait for index refresh
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query to verify insertion
    const events = await relay.query([{ ids: [testEvent.id] }]);

    assertEquals(events.length, 1, "Should find one event");
    assertEquals(events[0].id, testEvent.id);
    assertEquals(events[0].kind, testEvent.kind);
    assertEquals(events[0].content, testEvent.content);
    assertEquals(events[0].pubkey, testEvent.pubkey);
    assertEquals(events[0].sig, testEvent.sig);
  },
});

Deno.test({
  name: "OpenSearchRelay - eventBatch() inserts multiple events",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const events = [
      genEvent({ kind: 1, content: "Event 1" }),
      genEvent({ kind: 1, content: "Event 2" }),
      genEvent({ kind: 1, content: "Event 3" }),
    ];

    await relay.eventBatch(events);

    // Wait for index refresh
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query all events
    const queriedEvents = await relay.query([{ kinds: [1], limit: 10 }]);

    assertEquals(queriedEvents.length, 3, "Should find three events");
  },
});

Deno.test({
  name: "OpenSearchRelay - query by ids",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event1 = genEvent({ kind: 1, content: "Event 1" });
    const event2 = genEvent({ kind: 1, content: "Event 2" });
    const event3 = genEvent({ kind: 1, content: "Event 3" });

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query specific events by ID
    const events = await relay.query([{ ids: [event1.id, event3.id] }]);

    assertEquals(events.length, 2, "Should find two events");
    const eventIds = events.map((e) => e.id).sort();
    assertEquals(eventIds, [event1.id, event3.id].sort());
  },
});

Deno.test({
  name: "OpenSearchRelay - query by authors",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();
    const pubkey1 = getPublicKey(sk1);

    const event1 = genEvent({ kind: 1, content: "Event from author 1" }, sk1);
    const event2 = genEvent(
      { kind: 1, content: "Another from author 1" },
      sk1,
    );
    const event3 = genEvent({ kind: 1, content: "Event from author 2" }, sk2);

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query events by specific author
    const events = await relay.query([{ authors: [pubkey1] }]);

    assertEquals(events.length, 2, "Should find two events from author 1");
    events.forEach((e) => {
      assertEquals(e.pubkey, pubkey1);
    });
  },
});

Deno.test({
  name: "OpenSearchRelay - query by kinds",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event1 = genEvent({ kind: 0, content: "Metadata" });
    const event2 = genEvent({ kind: 1, content: "Text note" });
    const event3 = genEvent({ kind: 3, content: "Contacts" });
    const event4 = genEvent({ kind: 1, content: "Another text note" });

    await relay.eventBatch([event1, event2, event3, event4]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query only kind 1 events
    const events = await relay.query([{ kinds: [1] }]);

    assertEquals(events.length, 2, "Should find two kind 1 events");
    events.forEach((e) => {
      assertEquals(e.kind, 1);
    });
  },
});

Deno.test({
  name: "OpenSearchRelay - query by time range (since/until)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const now = Math.floor(Date.now() / 1000);
    const hourAgo = now - 3600;
    const twoHoursAgo = now - 7200;

    const event1 = genEvent({
      kind: 1,
      content: "Two hours ago",
      created_at: twoHoursAgo,
    });
    const event2 = genEvent({
      kind: 1,
      content: "One hour ago",
      created_at: hourAgo,
    });
    const event3 = genEvent({ kind: 1, content: "Now", created_at: now });

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query events since one hour ago
    const recentEvents = await relay.query([{ since: hourAgo - 10 }]);
    assertEquals(recentEvents.length, 2, "Should find two recent events");

    // Query events until one hour ago
    const oldEvents = await relay.query([{ until: hourAgo + 10 }]);
    assertEquals(oldEvents.length, 2, "Should find two old events");

    // Query events in a specific range
    const rangeEvents = await relay.query([{
      since: twoHoursAgo - 10,
      until: hourAgo + 10,
    }]);
    assertEquals(rangeEvents.length, 2, "Should find two events in range");
  },
});

Deno.test({
  name: "OpenSearchRelay - query with limit",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const events = Array.from(
      { length: 10 },
      (_, i) => genEvent({ kind: 1, content: `Event ${i}` }),
    );

    await relay.eventBatch(events);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query with limit
    const limitedEvents = await relay.query([{ kinds: [1], limit: 5 }]);

    assertEquals(limitedEvents.length, 5, "Should respect limit parameter");
  },
});

Deno.test({
  name: "OpenSearchRelay - query with tag filters (common tags)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);

    const event1 = genEvent({
      kind: 1,
      content: "Event with e tag",
      tags: [["e", "event123"]],
    }, sk);
    const event2 = genEvent({
      kind: 1,
      content: "Event with p tag",
      tags: [["p", pubkey]],
    }, sk);
    const event3 = genEvent({
      kind: 1,
      content: "Event with both tags",
      tags: [["e", "event456"], ["p", pubkey]],
    }, sk);
    const event4 = genEvent({
      kind: 1,
      content: "Event with no tags",
      tags: [],
    }, sk);

    await relay.eventBatch([event1, event2, event3, event4]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query events with specific e tag
    const eTagEvents = await relay.query([{ "#e": ["event123"] }]);
    assertEquals(eTagEvents.length, 1, "Should find one event with e tag");
    assertEquals(eTagEvents[0].id, event1.id);

    // Query events with specific p tag
    const pTagEvents = await relay.query([{ "#p": [pubkey] }]);
    assertEquals(pTagEvents.length, 2, "Should find two events with p tag");
  },
});

Deno.test({
  name: "OpenSearchRelay - query with multi-letter tag filters",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();

    const event1 = genEvent({
      kind: 1,
      content: "Event with custom tag",
      tags: [["custom", "value1"]],
    }, sk);
    const event2 = genEvent({
      kind: 1,
      content: "Event with another custom tag",
      tags: [["custom", "value2"]],
    }, sk);
    const event3 = genEvent({
      kind: 1,
      content: "Event with different tag",
      tags: [["other", "value3"]],
    }, sk);

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query events with custom tag
    const customTagEvents = await relay.query([{ "#custom": ["value1"] }]);
    assertEquals(
      customTagEvents.length,
      1,
      "Should find one event with custom tag",
    );
    assertEquals(customTagEvents[0].id, event1.id);

    // Query events with multiple values
    const multiValueEvents = await relay.query([
      { "#custom": ["value1", "value2"] },
    ]);
    assertEquals(
      multiValueEvents.length,
      2,
      "Should find two events with custom tag values",
    );
  },
});

Deno.test({
  name: "OpenSearchRelay - NIP-50 full-text search",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event1 = genEvent({
      kind: 1,
      content: "Bitcoin is the best cryptocurrency",
    });
    const event2 = genEvent({
      kind: 1,
      content: "Ethereum and smart contracts",
    });
    const event3 = genEvent({
      kind: 1,
      content: "I love using Nostr for social media",
    });

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Search for "bitcoin"
    const bitcoinEvents = await relay.query([{ search: "bitcoin" }]);
    assertEquals(
      bitcoinEvents.length,
      1,
      "Should find one event about bitcoin",
    );
    assertEquals(bitcoinEvents[0].id, event1.id);

    // Search for "nostr"
    const nostrEvents = await relay.query([{ search: "nostr" }]);
    assertEquals(nostrEvents.length, 1, "Should find one event about nostr");
    assertEquals(nostrEvents[0].id, event3.id);
  },
});

Deno.test({
  name: "OpenSearchRelay - query with multiple filters",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();

    const event1 = genEvent({ kind: 1, content: "Kind 1 from author 1" }, sk1);
    const event2 = genEvent({ kind: 3, content: "Kind 3 from author 1" }, sk1);
    const event3 = genEvent({ kind: 1, content: "Kind 1 from author 2" }, sk2);

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query with multiple filters (should OR them)
    const events = await relay.query([
      { kinds: [1] },
      { kinds: [3] },
    ]);

    assertEquals(
      events.length,
      3,
      "Should find all events matching either filter",
    );
  },
});

Deno.test({
  name: "OpenSearchRelay - count() returns event count",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const events = Array.from(
      { length: 7 },
      (_, i) => genEvent({ kind: 1, content: `Event ${i}` }),
    );

    await relay.eventBatch(events);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Count all kind 1 events
    const result = await relay.count([{ kinds: [1] }]);

    assertEquals(result.count, 7, "Should count all events");
  },
});

Deno.test({
  name: "OpenSearchRelay - req() streams events",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event1 = genEvent({ kind: 1, content: "Event 1" });
    const event2 = genEvent({ kind: 1, content: "Event 2" });

    await relay.eventBatch([event1, event2]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Stream events
    const messages: Array<["EVENT" | "EOSE", string, NostrEvent?]> = [];
    for await (const msg of relay.req([{ kinds: [1] }])) {
      messages.push(msg as ["EVENT" | "EOSE", string, NostrEvent?]);
    }

    // Should have 2 EVENT messages and 1 EOSE
    const eventMessages = messages.filter((m) => m[0] === "EVENT");
    const eoseMessages = messages.filter((m) => m[0] === "EOSE");

    assertEquals(eventMessages.length, 2, "Should stream two events");
    assertEquals(eoseMessages.length, 1, "Should send EOSE");
  },
});

Deno.test({
  name: "OpenSearchRelay - query with limit 0 returns empty",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event = genEvent({ kind: 1, content: "Test event" });
    await relay.event(event);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query with limit 0 (realtime-only subscription)
    const events = await relay.query([{ kinds: [1], limit: 0 }]);

    assertEquals(events.length, 0, "Should return no events with limit 0");
  },
});

Deno.test({
  name: "OpenSearchRelay - duplicate events are replaced",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const event = genEvent({ kind: 1, content: "Original content" }, sk);

    // Insert the same event twice
    await relay.event(event);
    await relay.event(event);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query should return only one event (same ID overwrites)
    const events = await relay.query([{ ids: [event.id] }]);

    assertEquals(events.length, 1, "Should have only one event");
    assertEquals(events[0].id, event.id);
  },
});

Deno.test({
  name: "OpenSearchRelay - complex query with multiple conditions",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    const event1 = genEvent({
      kind: 1,
      content: "Match",
      created_at: now,
      tags: [["p", pubkey]],
    }, sk);
    const event2 = genEvent({
      kind: 3,
      content: "Wrong kind",
      created_at: now,
      tags: [["p", pubkey]],
    }, sk);
    const event3 = genEvent({
      kind: 1,
      content: "Too old",
      created_at: now - 7200,
      tags: [["p", pubkey]],
    }, sk);

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query with multiple conditions
    const events = await relay.query([{
      kinds: [1],
      authors: [pubkey],
      since: now - 3600,
      "#p": [pubkey],
    }]);

    assertEquals(events.length, 1, "Should find only the matching event");
    assertEquals(events[0].id, event1.id);
  },
});

Deno.test({
  name: "OpenSearchRelay - eventBatch with empty array does nothing",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    // Should not throw
    await relay.eventBatch([]);

    const events = await relay.query([{}]);
    assertEquals(events.length, 0, "Should have no events");
  },
});

Deno.test({
  name: "OpenSearchRelay - events sorted by created_at desc",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const now = Math.floor(Date.now() / 1000);

    const event1 = genEvent({ kind: 1, content: "Old", created_at: now - 100 });
    const event2 = genEvent({
      kind: 1,
      content: "Middle",
      created_at: now - 50,
    });
    const event3 = genEvent({ kind: 1, content: "New", created_at: now });

    await relay.eventBatch([event1, event2, event3]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const events = await relay.query([{ kinds: [1] }]);

    assertEquals(events.length, 3);
    assertEquals(
      events[0].created_at >= events[1].created_at,
      true,
      "Events should be sorted newest first",
    );
    assertEquals(
      events[1].created_at >= events[2].created_at,
      true,
      "Events should be sorted newest first",
    );
  },
});

Deno.test({
  name: "OpenSearchRelay - replaceable events (kind 0) only keep latest",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    // Create two kind 0 events from same author
    const olderEvent = genEvent({
      kind: 0,
      content: JSON.stringify({ name: "Old Name" }),
      created_at: now - 100,
    }, sk);

    const newerEvent = genEvent({
      kind: 0,
      content: JSON.stringify({ name: "New Name" }),
      created_at: now,
    }, sk);

    // Insert older event first
    await relay.event(olderEvent);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Verify older event is stored
    let events = await relay.query([{ kinds: [0], authors: [pubkey] }]);
    assertEquals(events.length, 1, "Should have one event");
    assertEquals(events[0].id, olderEvent.id, "Should be the older event");

    // Insert newer event
    await relay.event(newerEvent);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query should return only the newer event
    events = await relay.query([{ kinds: [0], authors: [pubkey] }]);
    assertEquals(events.length, 1, "Should still have only one event");
    assertEquals(events[0].id, newerEvent.id, "Should be the newer event");
    assertEquals(
      JSON.parse(events[0].content).name,
      "New Name",
      "Content should be from newer event",
    );
  },
});

Deno.test({
  name:
    "OpenSearchRelay - replaceable events don't replace if older timestamp",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    // Create two kind 0 events from same author
    const newerEvent = genEvent({
      kind: 0,
      content: JSON.stringify({ name: "New Name" }),
      created_at: now,
    }, sk);

    const olderEvent = genEvent({
      kind: 0,
      content: JSON.stringify({ name: "Old Name" }),
      created_at: now - 100,
    }, sk);

    // Insert newer event first
    await relay.event(newerEvent);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Insert older event (should be rejected)
    await relay.event(olderEvent);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query should return only the newer event
    const events = await relay.query([{ kinds: [0], authors: [pubkey] }]);
    assertEquals(events.length, 1, "Should still have only one event");
    assertEquals(events[0].id, newerEvent.id, "Should be the newer event");
  },
});

Deno.test({
  name: "OpenSearchRelay - addressable events (kind 30000+) with d tag",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    // Create two kind 30023 (long-form content) events with same d tag
    const olderArticle = genEvent({
      kind: 30023,
      content: "Old article content",
      created_at: now - 100,
      tags: [["d", "my-article"]],
    }, sk);

    const newerArticle = genEvent({
      kind: 30023,
      content: "Updated article content",
      created_at: now,
      tags: [["d", "my-article"]],
    }, sk);

    // Create another article with different d tag
    const differentArticle = genEvent({
      kind: 30023,
      content: "Different article",
      created_at: now,
      tags: [["d", "other-article"]],
    }, sk);

    // Insert all events
    await relay.eventBatch([olderArticle, newerArticle, differentArticle]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query should return only the newer version of "my-article" and the other article
    const events = await relay.query([{ kinds: [30023], authors: [pubkey] }]);
    assertEquals(events.length, 2, "Should have two articles");

    const myArticle = events.find((e) =>
      e.tags.some((t) => t[0] === "d" && t[1] === "my-article")
    );
    assertEquals(
      myArticle?.id,
      newerArticle.id,
      "Should be the newer version",
    );
    assertEquals(
      myArticle?.content,
      "Updated article content",
      "Content should be updated",
    );
  },
});

Deno.test({
  name:
    "OpenSearchRelay - addressable events with empty d tag are separate from no d tag",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    // Event with d tag = ""
    const emptyDTag = genEvent({
      kind: 30023,
      content: "Empty d tag",
      created_at: now,
      tags: [["d", ""]],
    }, sk);

    // Event with no d tag (defaults to "")
    const noDTag = genEvent({
      kind: 30023,
      content: "No d tag",
      created_at: now + 1,
      tags: [],
    }, sk);

    await relay.eventBatch([emptyDTag, noDTag]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Both should be treated as having d="" and only the newer one should exist
    const events = await relay.query([{ kinds: [30023], authors: [pubkey] }]);
    assertEquals(events.length, 1, "Should have only one event");
    assertEquals(
      events[0].id,
      noDTag.id,
      "Should be the newer event (no d tag)",
    );
  },
});

Deno.test({
  name:
    "OpenSearchRelay - replaceable events with same timestamp, lower ID wins",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const now = Math.floor(Date.now() / 1000);

    // Create two events with same timestamp
    const event1 = genEvent({
      kind: 0,
      content: JSON.stringify({ name: "Event 1" }),
      created_at: now,
    }, sk);

    const event2 = genEvent({
      kind: 0,
      content: JSON.stringify({ name: "Event 2" }),
      created_at: now,
    }, sk);

    // Determine which has lower ID
    const lowerIdEvent = event1.id < event2.id ? event1 : event2;
    const higherIdEvent = event1.id < event2.id ? event2 : event1;

    // Insert higher ID first
    await relay.event(higherIdEvent);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Insert lower ID (should replace)
    await relay.event(lowerIdEvent);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Query should return the event with lower ID
    const events = await relay.query([{ kinds: [0] }]);
    assertEquals(events.length, 1, "Should have only one event");
    assertEquals(
      events[0].id,
      lowerIdEvent.id,
      "Should be the event with lower ID",
    );
  },
});

Deno.test({
  name:
    "OpenSearchRelay - batch insert deduplicates replaceable events within batch",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    // Create multiple kind 0 events in a batch
    const events: NostrEvent[] = [
      genEvent({
        kind: 0,
        content: JSON.stringify({ name: "Version 1" }),
        created_at: now - 200,
      }, sk),
      genEvent({
        kind: 0,
        content: JSON.stringify({ name: "Version 2" }),
        created_at: now - 100,
      }, sk),
      genEvent({
        kind: 0,
        content: JSON.stringify({ name: "Version 3" }),
        created_at: now,
      }, sk),
    ];

    // Insert all at once
    await relay.eventBatch(events);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Should only have the newest version
    const storedEvents = await relay.query([{ kinds: [0], authors: [pubkey] }]);
    assertEquals(storedEvents.length, 1, "Should have only one event");
    assertEquals(
      storedEvents[0].id,
      events[2].id,
      "Should be the newest event",
    );
    assertEquals(
      JSON.parse(storedEvents[0].content).name,
      "Version 3",
      "Should have newest content",
    );
  },
});

Deno.test({
  name: "OpenSearchRelay - regular events (kind 1) are NOT replaceable",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const now = Math.floor(Date.now() / 1000);

    // Create two kind 1 events from same author
    const event1 = genEvent({
      kind: 1,
      content: "First note",
      created_at: now - 100,
    }, sk);

    const event2 = genEvent({
      kind: 1,
      content: "Second note",
      created_at: now,
    }, sk);

    await relay.eventBatch([event1, event2]);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Both events should be stored
    const events = await relay.query([{ kinds: [1], authors: [pubkey] }]);
    assertEquals(events.length, 2, "Should have both events");
  },
});
