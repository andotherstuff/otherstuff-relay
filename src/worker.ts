/**
 * Worker process that batches events from Redis and inserts into ClickHouse
 */
import { createClient } from "@clickhouse/client-web";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
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

console.log("🔧 Worker started, waiting for events...");

const BATCH_SIZE = 1000; // Number of events to batch before inserting
const BATCH_TIMEOUT_MS = 100; // Maximum time to wait before flushing batch

let batch: NostrEvent[] = [];
let batchTimer: number | null = null;

async function flushBatch() {
  if (batch.length === 0) return;

  const eventsToInsert = batch;
  batch = [];

  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  try {
    await clickhouse.insert({
      table: "nostr_events",
      values: eventsToInsert.map((event) => ({
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

    console.log(`✅ Inserted ${eventsToInsert.length} events into ClickHouse`);
  } catch (error) {
    console.error("❌ Failed to insert batch:", error);
    // Push failed events back to queue for retry
    for (const event of eventsToInsert) {
      await redis.rPush("nostr:events:queue", JSON.stringify(event));
    }
  }
}

function scheduleBatchFlush() {
  if (batchTimer === null) {
    batchTimer = setTimeout(() => {
      flushBatch();
    }, BATCH_TIMEOUT_MS);
  }
}

// Main processing loop
async function processEvents() {
  while (true) {
    try {
      // BLPOP blocks until an event is available (timeout: 1 second)
      const result = await redis.blPop("nostr:events:queue", 1);

      if (result) {
        const event = JSON.parse(result.element) as NostrEvent;
        batch.push(event);

        // Flush if batch is full
        if (batch.length >= BATCH_SIZE) {
          await flushBatch();
        } else {
          // Schedule a flush if not already scheduled
          scheduleBatchFlush();
        }
      } else {
        // Timeout reached, flush any pending events
        if (batch.length > 0) {
          await flushBatch();
        }
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
  console.log("Shutting down worker...");
  await flushBatch(); // Flush any remaining events
  await redis.quit();
  await clickhouse.close();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Start processing
processEvents();
