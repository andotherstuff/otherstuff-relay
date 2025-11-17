/**
 * Management worker process that handles NIP-86 operations requiring OpenSearch access
 * Listens for management commands and executes them with database access
 */
import { Client } from "@opensearch-project/opensearch";
import { createClient as createRedisClient } from "redis";
import { Config } from "@/lib/config.ts";
import { OpenSearchRelay } from "@/lib/opensearch.ts";
import { RelayManagement } from "@/lib/management.ts";

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

// Initialize OpenSearchRelay
const relay = new OpenSearchRelay(opensearch);

// Initialize relay management with relay access
// @ts-ignore: Redis type compatibility issue
const management = new RelayManagement(redis, relay);

const WORKER_ID = crypto.randomUUID().slice(0, 8);

console.log(`🔧 Management worker ${WORKER_ID} started`);

interface ManagementCommand {
  method: string;
  params: unknown[];
  requestId: string;
}

// Main processing loop
async function processCommands() {
  while (true) {
    try {
      // Block for up to 1 second waiting for a command
      const result = await redis.blPop("relay:management:queue", 1);

      if (result) {
        const command: ManagementCommand = JSON.parse(result.element);

        console.log(
          `📋 Processing ${command.method} (request ${command.requestId})`,
        );

        try {
          let response: unknown;

          switch (command.method) {
            case "banpubkey":
              response = await management.banPubkey(
                command.params[0] as string,
                command.params[1] as string | undefined,
              );
              break;

            case "banevent":
              response = await management.banEvent(
                command.params[0] as string,
                command.params[1] as string | undefined,
              );
              break;

            default:
              response = { error: `Unknown method: ${command.method}` };
          }

          // Send response back
          await redis.set(
            `relay:management:response:${command.requestId}`,
            JSON.stringify({ result: response }),
            { EX: 60 }, // Expire after 60 seconds
          );
        } catch (error) {
          console.error(`Failed to process ${command.method}:`, error);

          // Send error response
          await redis.set(
            `relay:management:response:${command.requestId}`,
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
            { EX: 60 },
          );
        }
      }
    } catch (error) {
      console.error("Error in management worker:", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Start processing
processCommands();

// Graceful shutdown
Deno.addSignalListener("SIGINT", async () => {
  console.log("\n🛑 Management worker shutting down...");
  await redis.quit();
  await relay.close();
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", async () => {
  console.log("\n🛑 Management worker shutting down...");
  await redis.quit();
  await relay.close();
  Deno.exit(0);
});
