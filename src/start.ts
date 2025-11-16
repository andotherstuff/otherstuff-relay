/**
 * Process manager to run server and workers together
 */
import { Client } from "@opensearch-project/opensearch";
import { Config } from "./config.ts";
import { OpenSearchRelay } from "./opensearch.ts";

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
const RESTART_DELAY_MS = parseInt(Deno.env.get("RESTART_DELAY_MS") || "1000");

console.log(
  `🚀 Starting relay with ${NUM_RELAY_WORKERS} relay workers and ${NUM_STORAGE_WORKERS} storage workers...`,
);

// Track processes by type for restart logic
type ProcessType = "relay-worker" | "storage-worker" | "server";

interface ManagedProcess {
  process: Deno.ChildProcess;
  type: ProcessType;
  id: number; // Worker ID for workers, 0 for server
}

const processes: ManagedProcess[] = [];
let isShuttingDown = false;

/**
 * Start a process and track it
 */
function startProcess(
  type: ProcessType,
  id: number,
  silent = false,
): ManagedProcess {
  const process = new Deno.Command("deno", {
    args: ["task", "-q", type],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const managed: ManagedProcess = { process, type, id };

  if (!silent) {
    console.log(
      `✅ ${type} ${id > 0 ? `#${id}` : ""} started (PID: ${process.pid})`,
    );
  }

  // Monitor this process
  monitorProcess(managed);

  return managed;
}

/**
 * Monitor a process and restart it if it dies
 */
async function monitorProcess(managed: ManagedProcess) {
  const { process, type, id } = managed;

  const status = await process.status;

  // Don't restart if we're shutting down
  if (isShuttingDown) {
    return;
  }

  console.error(
    `\n❌ ${type} ${id > 0 ? `#${id}` : ""} exited with status: ${status.code}`,
  );

  // Remove from processes array
  const index = processes.indexOf(managed);
  if (index > -1) {
    processes.splice(index, 1);
  }

  // For server, we should probably shut down everything
  // since the server is critical
  if (type === "server") {
    console.error(
      "⚠️  Server process died - this is critical. Initiating shutdown...",
    );
    await shutdown();
    return;
  }

  // For workers, restart after a delay
  console.log(
    `🔄 Restarting ${type} ${
      id > 0 ? `#${id}` : ""
    } in ${RESTART_DELAY_MS}ms...`,
  );

  await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));

  if (!isShuttingDown) {
    const newProcess = startProcess(type, id);
    processes.push(newProcess);
  }
}

// Start relay workers (handle validation and message processing)
await (async () => {
  const reportInterval = Math.max(1, Math.floor(NUM_RELAY_WORKERS / 10)); // Report every 10%
  for (let i = 0; i < NUM_RELAY_WORKERS; i++) {
    const managed = startProcess("relay-worker", i + 1, true);
    processes.push(managed);
    await new Promise((resolve) => setTimeout(resolve, 50)); // Stagger startups

    // Report progress
    if ((i + 1) % reportInterval === 0 || i === NUM_RELAY_WORKERS - 1) {
      console.log(`🔄 ${i + 1}/${NUM_RELAY_WORKERS} relay workers started`);
    }
  }
  console.log(`✅ All ${NUM_RELAY_WORKERS} relay workers started`);
})();

// Start storage workers (handle batch inserts to OpenSearch)
await (async () => {
  const reportInterval = Math.max(1, Math.floor(NUM_STORAGE_WORKERS / 10)); // Report every 10%
  for (let i = 0; i < NUM_STORAGE_WORKERS; i++) {
    const managed = startProcess("storage-worker", i + 1, true);
    processes.push(managed);
    await new Promise((resolve) => setTimeout(resolve, 50)); // Stagger startups

    // Report progress
    if ((i + 1) % reportInterval === 0 || i === NUM_STORAGE_WORKERS - 1) {
      console.log(`🔄 ${i + 1}/${NUM_STORAGE_WORKERS} storage workers started`);
    }
  }
  console.log(`✅ All ${NUM_STORAGE_WORKERS} storage workers started`);
})();

// Start server
const serverManaged = startProcess("server", 0);
processes.push(serverManaged);

// Graceful shutdown handler
const shutdown = async () => {
  if (isShuttingDown) {
    return; // Already shutting down
  }

  isShuttingDown = true;
  console.log("\n🛑 Shutting down all processes...");

  for (const managed of processes) {
    try {
      managed.process.kill("SIGTERM");
    } catch {
      // Process might already be dead
    }
  }

  // Wait for all processes to exit
  await Promise.all(processes.map((m) => m.process.status));

  console.log("✅ All processes stopped");
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
