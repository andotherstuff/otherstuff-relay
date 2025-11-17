/**
 * Queue Bridge - Connects ImmortalQueue to Redis for existing workers
 * 
 * This bridge allows us to use the IMMORTAL queue on the server side
 * while keeping the existing relay workers unchanged.
 */

import { createClient as createRedisClient } from "redis";
import { Config } from "@/lib/config.ts";
import { ImmortalQueue } from "@/lib/immortal-queue.ts";

const config = new Config(Deno.env);

// Redis client
const redis = createRedisClient({
  url: config.redisUrl,
});
await redis.connect();

// This will be shared with the server (imported)
export const immortalQueue = new ImmortalQueue<{ connId: string; msg: string }>(100000);

const BATCH_SIZE = 1000;
const POLL_INTERVAL = 10; // ms

/**
 * Bridge worker - pulls from ImmortalQueue and pushes to Redis
 */
async function runBridge() {
  console.log("🌉 Queue bridge started");

  while (true) {
    try {
      // Pop batch from immortal queue
      const messages = immortalQueue.pop(BATCH_SIZE);

      if (messages.length > 0) {
        // Push to Redis for relay workers
        const pipeline = redis.multi();
        
        for (const msg of messages) {
          pipeline.rPush(
            "nostr:relay:queue",
            JSON.stringify(msg.data),
          );
        }

        await pipeline.exec();

        // Log throughput every 1000 messages
        if (Math.random() < 0.01) {
          const stats = immortalQueue.getStats();
          console.log(
            `📊 Bridge: ${stats.processedMessages.toLocaleString()} processed, ` +
            `${stats.droppedMessages.toLocaleString()} dropped, ` +
            `queue: ${stats.length}/${stats.capacity} (${(stats.utilization * 100).toFixed(1)}%)`,
          );
        }
      } else {
        // Queue empty, wait a bit
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }
    } catch (error) {
      console.error("Bridge error:", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down queue bridge...");
  await redis.quit();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Start bridge
runBridge();
