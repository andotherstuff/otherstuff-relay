/**
 * Storage worker process that batches events from Redis and inserts into OpenSearch
 */
import { Client } from "@opensearch-project/opensearch";
import { createClient as createRedisClient } from "redis";
import { Config } from "./config.ts";
import { getMetricsInstance, initializeMetrics } from "./metrics.ts";
import { OpenSearchRelay } from "./opensearch.ts";
import type { NostrEvent } from "@nostrify/nostrify";

const config = new Config(Deno.env);

// OpenSearch client
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

// Add authentication if provided
if (config.opensearchUsername && config.opensearchPassword) {
  opensearchConfig.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}

const opensearch = new Client(opensearchConfig);

// Redis client
const redis = createRedisClient({
  url: config.redisUrl,
});
await redis.connect();

// Initialize metrics with Redis client
initializeMetrics(redis);

// Get metrics instance for use in this module
const metrics = getMetricsInstance();

// Initialize OpenSearchRelay
const relay = new OpenSearchRelay(opensearch);

const WORKER_ID = crypto.randomUUID().slice(0, 8);

const BATCH_SIZE = 1000; // Number of events to batch before inserting
const POLL_INTERVAL_MS = 10; // How often to check Redis when queue is empty

async function insertBatch(events: NostrEvent[]) {
  if (events.length === 0) return;

  try {
    await relay.eventBatch(events);

    console.log(`✅ Inserted ${events.length} events into OpenSearch`);

    // Increment events stored counter
    await metrics.incrementEventsStored(events.length);
  } catch (error) {
    console.error("❌ Failed to insert batch:", error);

    // Increment events failed counter
    await metrics.incrementEventsFailed(events.length);

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

  try {
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
  } catch (error) {
    console.error("Error processing remaining events during shutdown:", error);
  }

  try {
    await redis.quit();
  } catch (error) {
    console.error("Error closing Redis connection:", error);
  }

  try {
    await relay.close();
  } catch (error) {
    console.error("Error closing OpenSearch connection:", error);
  }

  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Start processing
processEvents();
