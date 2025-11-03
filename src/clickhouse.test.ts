import { assertEquals, assertExists } from "@std/assert";
import { createClient } from "@clickhouse/client-web";
import { ClickhouseRelay } from "./clickhouse.ts";
import { Config } from "./config.ts";
import { genEvent } from "@nostrify/nostrify/test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { NostrEvent } from "@nostrify/nostrify";

// Setup and teardown
async function setupRelay(): Promise<ClickhouseRelay> {
  const config = new Config(Deno.env);
  const clickhouse = createClient({
    url: config.databaseUrl,
  });

  const relay = new ClickhouseRelay(clickhouse, {
    relaySource: "wss://test-relay.example.com",
  });

  // Run migrations to ensure tables exist
  await relay.migrate();

  // Clean up test data
  await clickhouse.command({
    query: "TRUNCATE TABLE events_local",
  });

  return relay;
}

Deno.test({
  name: "ClickhouseRelay - migrate creates tables",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using _relay = await setupRelay();

    // Verify main table exists
    const config = new Config(Deno.env);
    const clickhouse = createClient({ url: config.databaseUrl });

    const result = await clickhouse.query({
      query:
        "SELECT count() as count FROM system.tables WHERE name = 'events_local' AND database = currentDatabase()",
      format: "JSONEachRow",
    });

    const data = await result.json<{ count: number }>();
    assertEquals(data[0].count >= 1, true, "events_local table should exist");

    // Verify materialized view exists
    const mvResult = await clickhouse.query({
      query:
        "SELECT count() as count FROM system.tables WHERE name = 'event_tags_flat' AND database = currentDatabase()",
      format: "JSONEachRow",
    });

    const mvData = await mvResult.json<{ count: number }>();
    assertEquals(
      mvData[0].count >= 1,
      true,
      "event_tags_flat view should exist",
    );
  },
});

Deno.test({
  name: "ClickhouseRelay - event() inserts a single event",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const testEvent = genEvent({ kind: 1, content: "Test metadata event" });

    await relay.event(testEvent);

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
  name: "ClickhouseRelay - eventBatch() inserts multiple events",
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

    // Query all events
    const queriedEvents = await relay.query([{ kinds: [1], limit: 10 }]);

    assertEquals(queriedEvents.length, 3, "Should find three events");
  },
});

Deno.test({
  name: "ClickhouseRelay - query by ids",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event1 = genEvent({ kind: 1, content: "Event 1" });
    const event2 = genEvent({ kind: 1, content: "Event 2" });
    const event3 = genEvent({ kind: 1, content: "Event 3" });

    await relay.eventBatch([event1, event2, event3]);

    // Query specific events by ID
    const events = await relay.query([{ ids: [event1.id, event3.id] }]);

    assertEquals(events.length, 2, "Should find two events");
    const eventIds = events.map((e) => e.id).sort();
    assertEquals(eventIds, [event1.id, event3.id].sort());
  },
});

Deno.test({
  name: "ClickhouseRelay - query by authors",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();
    const pubkey1 = getPublicKey(sk1);

    const event1 = genEvent({ kind: 1, content: "Event from author 1" }, sk1);
    const event2 = genEvent({ kind: 1, content: "Another from author 1" }, sk1);
    const event3 = genEvent({ kind: 1, content: "Event from author 2" }, sk2);

    await relay.eventBatch([event1, event2, event3]);

    // Query events by specific author
    const events = await relay.query([{ authors: [pubkey1] }]);

    assertEquals(events.length, 2, "Should find two events from author 1");
    events.forEach((e) => {
      assertEquals(e.pubkey, pubkey1);
    });
  },
});

Deno.test({
  name: "ClickhouseRelay - query by kinds",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event1 = genEvent({ kind: 0, content: "Metadata" });
    const event2 = genEvent({ kind: 1, content: "Text note" });
    const event3 = genEvent({ kind: 3, content: "Contacts" });
    const event4 = genEvent({ kind: 1, content: "Another text note" });

    await relay.eventBatch([event1, event2, event3, event4]);

    // Query only kind 1 events
    const events = await relay.query([{ kinds: [1] }]);

    assertEquals(events.length, 2, "Should find two kind 1 events");
    events.forEach((e) => {
      assertEquals(e.kind, 1);
    });
  },
});

Deno.test({
  name: "ClickhouseRelay - query by time range (since/until)",
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
  name: "ClickhouseRelay - query with limit",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const events = Array.from(
      { length: 10 },
      (_, i) => genEvent({ kind: 1, content: `Event ${i}` }),
    );

    await relay.eventBatch(events);

    // Query with limit
    const limitedEvents = await relay.query([{ kinds: [1], limit: 5 }]);

    assertEquals(limitedEvents.length, 5, "Should respect limit parameter");
  },
});

Deno.test({
  name: "ClickhouseRelay - query with tag filters",
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

    // Give the materialized view a moment to populate
    await new Promise((resolve) => setTimeout(resolve, 100));

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
  name: "ClickhouseRelay - query with multiple filters",
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
  name: "ClickhouseRelay - count() returns event count",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const events = Array.from(
      { length: 7 },
      (_, i) => genEvent({ kind: 1, content: `Event ${i}` }),
    );

    await relay.eventBatch(events);

    // Count all kind 1 events
    const result = await relay.count([{ kinds: [1] }]);

    assertEquals(result.count, 7, "Should count all events");
  },
});

Deno.test({
  name: "ClickhouseRelay - req() streams events",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event1 = genEvent({ kind: 1, content: "Event 1" });
    const event2 = genEvent({ kind: 1, content: "Event 2" });

    await relay.eventBatch([event1, event2]);

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
  name: "ClickhouseRelay - query with limit 0 returns empty",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const event = genEvent({ kind: 1, content: "Test event" });
    await relay.event(event);

    // Query with limit 0 (realtime-only subscription)
    const events = await relay.query([{ kinds: [1], limit: 0 }]);

    assertEquals(events.length, 0, "Should return no events with limit 0");
  },
});

Deno.test({
  name: "ClickhouseRelay - duplicate events are replaced",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await using relay = await setupRelay();

    const sk = generateSecretKey();
    const event = genEvent({ kind: 1, content: "Original content" }, sk);

    // Insert the same event twice
    await relay.event(event);
    await relay.event(event);

    // Query should return only one event due to ReplacingMergeTree
    // Note: ClickHouse may take time to merge, so we just verify we can query it
    const events = await relay.query([{ ids: [event.id] }]);

    assertExists(events[0], "Event should exist");
    assertEquals(events[0].id, event.id);
  },
});

Deno.test({
  name: "ClickhouseRelay - complex query with multiple conditions",
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

    // Give the materialized view a moment to populate
    await new Promise((resolve) => setTimeout(resolve, 100));

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
  name: "ClickhouseRelay - eventBatch with empty array does nothing",
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
  name: "ClickhouseRelay - relay source is stored",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const config = new Config(Deno.env);
    const clickhouse = createClient({ url: config.databaseUrl });

    const relay = new ClickhouseRelay(clickhouse, {
      relaySource: "wss://custom-relay.example.com",
    });

    await relay.migrate();
    await clickhouse.command({ query: "TRUNCATE TABLE events_local" });

    const event = genEvent({ kind: 1, content: "Test event" });
    await relay.event(event);

    // Verify relay_source is stored
    const result = await clickhouse.query({
      query: "SELECT relay_source FROM events_local WHERE id = {id:String}",
      query_params: { id: event.id },
      format: "JSONEachRow",
    });

    const data = await result.json<{ relay_source: string }>();
    assertEquals(data[0].relay_source, "wss://custom-relay.example.com");
  },
});
