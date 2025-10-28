/**
 * Process manager to run server and workers together
 */

const processes: Deno.ChildProcess[] = [];

// Number of worker processes to run
const NUM_STORAGE_WORKERS = parseInt(
  Deno.env.get("NUM_STORAGE_WORKERS") || "2",
);
const NUM_RELAY_WORKERS = parseInt(Deno.env.get("NUM_RELAY_WORKERS") || "4");

console.log(
  `🚀 Starting relay with ${NUM_RELAY_WORKERS} relay workers and ${NUM_STORAGE_WORKERS} storage workers...`,
);

// Start relay workers (handle validation and message processing)
for (let i = 0; i < NUM_RELAY_WORKERS; i++) {
  const worker = new Deno.Command("deno", {
    args: ["task", "relay-worker"],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  processes.push(worker);
  console.log(`✅ Relay worker ${i + 1} started (PID: ${worker.pid})`);
}

// Start storage workers (handle batch inserts to ClickHouse)
for (let i = 0; i < NUM_STORAGE_WORKERS; i++) {
  const worker = new Deno.Command("deno", {
    args: ["task", "storage-worker"],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  processes.push(worker);
  console.log(`✅ Storage worker ${i + 1} started (PID: ${worker.pid})`);
}

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
