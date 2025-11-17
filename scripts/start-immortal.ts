/**
 * Start script for IMMORTAL relay
 * Runs the unkillable relay with adaptive backpressure
 */

import { parseArgs } from "@std/cli/parse-args";
import { Config } from "@/lib/config.ts";

const config = new Config(Deno.env);

// Parse command line args
const args = parseArgs(Deno.args, {
  string: ["relay-workers", "storage-workers"],
  default: {
    "relay-workers": Deno.env.get("NUM_RELAY_WORKERS") || "16",
    "storage-workers": Deno.env.get("NUM_STORAGE_WORKERS") || "2",
  },
});

const numRelayWorkers = parseInt(args["relay-workers"]);
const numStorageWorkers = parseInt(args["storage-workers"]);

console.log(`
╔════════════════════════════════════════════════════════════════╗
║           🧟 IMMORTAL NOSTR RELAY - UNKILLABLE MODE 🧟         ║
╠════════════════════════════════════════════════════════════════╣
║  This relay can NEVER die!                                     ║
║                                                                ║
║  Features:                                                     ║
║  • Adaptive backpressure (slows down instead of dying)        ║
║  • Circuit breaker (auto-recovery from overload)              ║
║  • Priority queuing (critical messages always go through)     ║
║  • Rate limiting (100 msg/sec per connection)                 ║
║  • Graceful degradation (warns before dropping messages)      ║
║  • Queue capacity: 100,000 messages                           ║
╠════════════════════════════════════════════════════════════════╣
║  Port:           ${config.port.toString().padEnd(46)} ║
║  OpenSearch:     ${config.opensearchUrl.padEnd(46)} ║
║  Redis:          ${config.redisUrl.padEnd(46)} ║
║  Relay Workers:  ${numRelayWorkers.toString().padEnd(46)} ║
║  Storage Workers:${numStorageWorkers.toString().padEnd(46)} ║
╚════════════════════════════════════════════════════════════════╝
`);

const processes: Deno.ChildProcess[] = [];

// Graceful shutdown handler
const shutdown = async () => {
  console.log("\n🛑 Shutting down all processes...");

  for (const proc of processes) {
    try {
      proc.kill("SIGTERM");
      await proc.status;
    } catch (err) {
      console.error("Error stopping process:", err);
    }
  }

  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Start queue bridge (connects ImmortalQueue to Redis)
console.log("\n🌉 Starting queue bridge...");
const bridgeProc = new Deno.Command("deno", {
  args: [
    "run",
    "-A",
    "--env-file",
    "services/queue-bridge.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
processes.push(bridgeProc);

// Start relay workers
console.log(`\n🔧 Starting ${numRelayWorkers} relay workers...`);
for (let i = 0; i < numRelayWorkers; i++) {
  const workerProc = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--env-file",
      "services/relay-worker.ts",
    ],
    stdout: i === 0 ? "inherit" : "null", // Only show logs from first worker
    stderr: "inherit",
  }).spawn();
  processes.push(workerProc);
}

// Start storage workers
console.log(`\n💾 Starting ${numStorageWorkers} storage workers...`);
for (let i = 0; i < numStorageWorkers; i++) {
  const storageProc = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--env-file",
      "services/storage-worker.ts",
    ],
    stdout: i === 0 ? "inherit" : "null",
    stderr: "inherit",
  }).spawn();
  processes.push(storageProc);
}

// Start management worker
console.log("\n🔐 Starting management worker...");
const managementProc = new Deno.Command("deno", {
  args: [
    "run",
    "-A",
    "--env-file",
    "services/management-worker.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
processes.push(managementProc);

// Start IMMORTAL web server
console.log(`\n🧟 Starting IMMORTAL web server on port ${config.port}...`);
const serverProc = new Deno.Command("deno", {
  args: [
    "serve",
    "-A",
    "--env-file",
    "--port",
    config.port.toString(),
    "services/server-immortal.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
processes.push(serverProc);

console.log(`
╔════════════════════════════════════════════════════════════════╗
║              ✅ IMMORTAL RELAY FULLY OPERATIONAL ✅            ║
╠════════════════════════════════════════════════════════════════╣
║  WebSocket: ws://localhost:${config.port}/                          ║
║  Metrics:   http://localhost:${config.port}/metrics                 ║
║  Health:    http://localhost:${config.port}/health                  ║
║                                                                ║
║  Admin Queue Control:                                          ║
║  POST /admin/queue with NIP-98 auth:                          ║
║    {"capacity": 200000}      - Increase queue size            ║
║    {"rateLimit": 200}        - Adjust rate limit              ║
║    {"resetCircuitBreaker": true} - Manual recovery            ║
╠════════════════════════════════════════════════════════════════╣
║  Queue States:                                                 ║
║  🟢 HEALTHY    - <50% capacity, all messages accepted         ║
║  🟡 DEGRADED   - 50-80%, low priority messages dropped        ║
║  🟠 OVERLOADED - 80-95%, only high/critical messages          ║
║  🔴 CRITICAL   - >95%, circuit breaker may trip               ║
╠════════════════════════════════════════════════════════════════╣
║  This relay will NEVER close connections due to queue         ║
║  overload. It will gracefully degrade and warn clients.       ║
║                                                                ║
║  Press Ctrl+C to shutdown gracefully                           ║
╚════════════════════════════════════════════════════════════════╝
`);

// Wait for any process to exit
await Promise.race(processes.map((p) => p.status));

// If any process exits, shutdown all
await shutdown();
