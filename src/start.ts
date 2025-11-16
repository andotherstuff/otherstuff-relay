/**
 * Process manager to run server and workers together
 */
import { Client } from "@opensearch-project/opensearch";
import { Config } from "./config.ts";
import { OpenSearchRelay } from "./opensearch.ts";

const processes: Deno.ChildProcess[] = [];

// Instantiate config with Deno.env
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

// Initialize OpenSearchRelay
const relay = new OpenSearchRelay(opensearch);
await relay.migrate();

// Number of worker processes to run
const NUM_STORAGE_WORKERS = parseInt(
  Deno.env.get("NUM_STORAGE_WORKERS") || "2",
);
const NUM_RELAY_WORKERS = parseInt(Deno.env.get("NUM_RELAY_WORKERS") || "4");

console.log(
  `🚀 Starting relay with ${NUM_RELAY_WORKERS} relay workers and ${NUM_STORAGE_WORKERS} storage workers...`,
);

// Start relay workers (handle validation and message processing)
(async () => {
  for (let i = 0; i < NUM_RELAY_WORKERS; i++) {
    const worker = new Deno.Command("deno", {
      args: ["task", "relay-worker"],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();

    processes.push(worker);
    await new Promise((resolve) => setTimeout(resolve, 100)); // Stagger startups
  }
})();

// Start storage workers (handle batch inserts to OpenSearch)
(async () => {
  for (let i = 0; i < NUM_STORAGE_WORKERS; i++) {
    const worker = new Deno.Command("deno", {
      args: ["task", "storage-worker"],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();

    processes.push(worker);
    await new Promise((resolve) => setTimeout(resolve, 100)); // Stagger startups
  }
})();

// Start server
const server = new Deno.Command("deno", {
  args: ["task", "server"],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

processes.push(server);
console.log(`✅ Server started (PID: ${server.pid})`);

// Graceful shutdown handler
const shutdown = async () => {
  console.log("\n🛑 Shutting down all processes...");

  for (const process of processes) {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process might already be dead
    }
  }

  // Wait for all processes to exit
  await Promise.all(processes.map((p) => p.status));

  console.log("✅ All processes stopped");
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Wait for any process to exit
Promise.race(processes.map((p) => p.status)).then((status) => {
  console.error(`\n❌ A process exited unexpectedly with status: ${status}`);
  shutdown();
});
