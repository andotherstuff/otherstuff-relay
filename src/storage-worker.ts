/**
 * Storage worker process that batches events from Redis and inserts into ClickHouse
 */
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import { RedisMetrics } from "./metrics.ts";
import type { NostrEvent } from "@nostrify/nostrify";

const config = new Config(Deno.env);

// ClickHouse client
const clickhouse = createClient({
  url: config.databaseUrl,
});

// Redis client
const redis = createRedisClient({
  url: config.redisUrl,
});
await redis.connect();

const WORKER_ID = crypto.randomUUID().slice(0, 8);
console.log(`🔧 Storage worker ${WORKER_ID} started, waiting for events...`);

const BATCH_SIZE = 1000; // Number of events to batch before inserting
const POLL_INTERVAL_MS = 10; // How often to check Redis when queue is empty

async function insertBatch(events: NostrEvent[]) {
  if (events.length === 0) return;

  try {
    await clickhouse.insert({
      table: "nostr_events",
      values: events.map((event) => ({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
      })),
      format: "JSONEachRow",
    });

    console.log(`✅ Inserted ${events.length} events into ClickHouse`);
    
    // Increment events stored counter
    await RedisMetrics.incrementEventsStored(events.length);
  } catch (error) {
    console.error("❌ Failed to insert batch:", error);
    
    // Increment events failed counter
    await RedisMetrics.incrementEventsFailed(events.length);
    
    // Push failed events back to queue for retry
    for (const event of events) {
      await redis.rPush("nostr:events:queue", JSON.stringify(event));
    }
  }
}

// Main processing loop
async function processEvents() {
  while (true) {
    try {
      // Pop up to BATCH_SIZE events at once using LPOP with count
      // This is MUCH faster than popping one at a time
      const results = await redis.lPopCount("nostr:events:queue", BATCH_SIZE);

      if (results && results.length > 0) {
        const events: NostrEvent[] = [];

        for (const result of results) {
          try {
            const event = JSON.parse(result) as NostrEvent;
            events.push(event);
          } catch (error) {
            console.error("Failed to parse event:", error);
          }
        }

        if (events.length > 0) {
          await insertBatch(events);
        }
      } else {
        // Queue is empty, wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      console.error("Error processing events:", error);
      // Wait a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Graceful shutdown
const shutdown = async () => {
  console.log(`Shutting down storage worker ${WORKER_ID}...`);
  // Process any remaining events in the queue
  const results = await redis.lPopCount("nostr:events:queue", BATCH_SIZE);
  if (results && results.length > 0) {
    const events: NostrEvent[] = results
      .map((r: string) => {
        try {
          return JSON.parse(r) as NostrEvent;
        } catch {
          return null;
        }
      })
      .filter((e: NostrEvent | null): e is NostrEvent => e !== null);

    if (events.length > 0) {
      await insertBatch(events);
    }
  }
  await redis.quit();
  await clickhouse.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Start processing
processEvents();
