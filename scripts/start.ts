/**
 * Service manager to run server and workers together
 */
import { Client } from "@opensearch-project/opensearch";
import { Config } from "@/lib/config.ts";
import { OpenSearchRelay } from "@/lib/opensearch.ts";

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

// Number of worker instances to run
const NUM_STORAGE_WORKERS = parseInt(
  Deno.env.get("NUM_STORAGE_WORKERS") || "8",
);
const NUM_RELAY_WORKERS = parseInt(Deno.env.get("NUM_RELAY_WORKERS") || "64");
const RESTART_DELAY_MS = parseInt(Deno.env.get("RESTART_DELAY_MS") || "1000");

console.log(
  `🚀 Starting relay with ${NUM_RELAY_WORKERS} relay workers and ${NUM_STORAGE_WORKERS} storage workers...`,
);

// Service types
type ServiceType =
  | "relay-worker"
  | "storage-worker"
  | "management-worker"
  | "server";

interface Service {
  process: Deno.ChildProcess;
  type: ServiceType;
  instance: number; // Instance number for workers, 0 for server
}

const services: Service[] = [];
let isShuttingDown = false;

/**
 * Start a service instance
 */
function startService(
  type: ServiceType,
  instance: number,
  silent = false,
): Service {
  const args = type === "server"
    ? ["serve", "-A", "--env-file", "--parallel", `services/${type}.ts`]
    : ["run", "-A", "--env-file", `services/${type}.ts`];

  const process = new Deno.Command("deno", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const service: Service = { process, type, instance };

  if (!silent) {
    const label = instance > 0 ? `${type} #${instance}` : type;
    console.log(`✅ ${label} started (PID: ${process.pid})`);
  }

  // Monitor this service
  monitorService(service);

  return service;
}

/**
 * Monitor a service and restart it if it dies
 */
async function monitorService(service: Service) {
  const { process, type, instance } = service;

  const status = await process.status;

  // Don't restart if we're shutting down
  if (isShuttingDown) {
    return;
  }

  const label = instance > 0 ? `${type} #${instance}` : type;

  console.error(
    `\n❌ ${label} exited with status: ${status.code}`,
  );

  // Remove from services array
  const index = services.indexOf(service);
  if (index > -1) {
    services.splice(index, 1);
  }

  // For server, we should probably shut down everything
  // since the server is critical
  if (type === "server") {
    console.error(
      "⚠️  Server service died - this is critical. Initiating shutdown...",
    );
    await shutdown();
    return;
  }

  // For workers, restart after a delay
  console.log(
    `🔄 Restarting ${label} in ${RESTART_DELAY_MS}ms...`,
  );

  await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));

  if (!isShuttingDown) {
    const newService = startService(type, instance);
    services.push(newService);
  }
}

// Start all services concurrently
await Promise.all([
  // Start relay workers (handle validation and message processing)
  (async () => {
    const reportInterval = Math.max(1, Math.floor(NUM_RELAY_WORKERS / 10)); // Report every 10%
    for (let i = 0; i < NUM_RELAY_WORKERS; i++) {
      const service = startService("relay-worker", i + 1, true);
      services.push(service);
      await new Promise((resolve) => setTimeout(resolve, 100)); // Stagger startups

      // Report progress
      if ((i + 1) % reportInterval === 0 || i === NUM_RELAY_WORKERS - 1) {
        console.log(`🔄 ${i + 1}/${NUM_RELAY_WORKERS} relay workers started`);
      }
    }
    console.log(`✅ All ${NUM_RELAY_WORKERS} relay workers started`);
  })(),

  // Start storage workers (handle batch inserts to OpenSearch)
  (async () => {
    const reportInterval = Math.max(1, Math.floor(NUM_STORAGE_WORKERS / 10)); // Report every 10%
    for (let i = 0; i < NUM_STORAGE_WORKERS; i++) {
      const service = startService("storage-worker", i + 1, true);
      services.push(service);
      await new Promise((resolve) => setTimeout(resolve, 100)); // Stagger startups

      // Report progress
      if ((i + 1) % reportInterval === 0 || i === NUM_STORAGE_WORKERS - 1) {
        console.log(
          `🔄 ${i + 1}/${NUM_STORAGE_WORKERS} storage workers started`,
        );
      }
    }
    console.log(`✅ All ${NUM_STORAGE_WORKERS} storage workers started`);
  })(),

  // Start management worker (handles NIP-86 operations requiring OpenSearch access)
  Promise.resolve().then(() => {
    const managementService = startService("management-worker", 1);
    services.push(managementService);
  }),

  // Start server
  Promise.resolve().then(() => {
    const serverService = startService("server", 0);
    services.push(serverService);
  }),
]);

// Graceful shutdown handler
const shutdown = async () => {
  if (isShuttingDown) {
    return; // Already shutting down
  }

  isShuttingDown = true;
  console.log("\n🛑 Shutting down all services...");

  for (const service of services) {
    try {
      service.process.kill("SIGTERM");
    } catch {
      // Service might already be dead
    }
  }

  // Wait for all services to exit
  await Promise.all(services.map((s) => s.process.status));

  console.log("✅ All services stopped");
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
