/**
 * Benchmark comparing Redis queues vs in-memory channels
 * Demonstrates the performance difference between V1 and V2 architectures
 */

import { createClient as createRedisClient } from "redis";
import { Channel } from "@/lib/channel.ts";

const ITERATIONS = 10000;
const MESSAGE_SIZE = 1000; // bytes

// Generate test message
function generateMessage(size: number): string {
  return JSON.stringify({
    id: crypto.randomUUID(),
    data: "x".repeat(size),
  });
}

// Benchmark Redis queue
async function benchmarkRedis(): Promise<number> {
  const redis = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();

  const queueKey = "benchmark:queue";

  // Warm up
  for (let i = 0; i < 100; i++) {
    await redis.lPush(queueKey, generateMessage(MESSAGE_SIZE));
    await redis.lPop(queueKey);
  }

  // Benchmark
  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const msg = generateMessage(MESSAGE_SIZE);
    await redis.lPush(queueKey, msg);
    await redis.lPop(queueKey);
  }

  const end = performance.now();
  const duration = end - start;

  await redis.quit();

  return duration;
}

// Benchmark in-memory channel
async function benchmarkChannel(): Promise<number> {
  const channel = new Channel<string>();

  // Warm up
  for (let i = 0; i < 100; i++) {
    channel.push(generateMessage(MESSAGE_SIZE));
    await channel.pop(1, 100);
  }

  // Benchmark
  const start = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    const msg = generateMessage(MESSAGE_SIZE);
    channel.push(msg);
    await channel.pop(1, 100);
  }

  const end = performance.now();
  const duration = end - start;

  return duration;
}

// Benchmark batch operations
async function benchmarkRedisBatch(): Promise<number> {
  const redis = createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  await redis.connect();

  const queueKey = "benchmark:batch";
  const batchSize = 100;

  const start = performance.now();

  for (let i = 0; i < ITERATIONS / batchSize; i++) {
    const messages = Array.from({ length: batchSize }, () =>
      generateMessage(MESSAGE_SIZE)
    );

    // Push batch
    for (const msg of messages) {
      await redis.lPush(queueKey, msg);
    }

    // Pop batch
    for (let j = 0; j < batchSize; j++) {
      await redis.lPop(queueKey);
    }
  }

  const end = performance.now();
  const duration = end - start;

  await redis.quit();

  return duration;
}

async function benchmarkChannelBatch(): Promise<number> {
  const channel = new Channel<string>();
  const batchSize = 100;

  const start = performance.now();

  for (let i = 0; i < ITERATIONS / batchSize; i++) {
    const messages = Array.from({ length: batchSize }, () =>
      generateMessage(MESSAGE_SIZE)
    );

    // Push batch
    channel.pushBatch(messages);

    // Pop batch
    await channel.pop(batchSize, 100);
  }

  const end = performance.now();
  const duration = end - start;

  return duration;
}

// Run benchmarks
console.log("🏁 Starting benchmarks...\n");
console.log(`Iterations: ${ITERATIONS}`);
console.log(`Message size: ${MESSAGE_SIZE} bytes\n`);

console.log("=" .repeat(60));
console.log("Individual Operations");
console.log("=".repeat(60));

console.log("\n⏱️  Benchmarking Redis queue (individual)...");
const redisDuration = await benchmarkRedis();
const redisOpsPerSec = (ITERATIONS / redisDuration) * 1000;
const redisLatency = redisDuration / ITERATIONS;

console.log(`✅ Redis: ${redisDuration.toFixed(2)}ms total`);
console.log(`   Throughput: ${redisOpsPerSec.toFixed(0)} ops/sec`);
console.log(`   Avg latency: ${redisLatency.toFixed(3)}ms per op`);

console.log("\n⏱️  Benchmarking in-memory channel (individual)...");
const channelDuration = await benchmarkChannel();
const channelOpsPerSec = (ITERATIONS / channelDuration) * 1000;
const channelLatency = channelDuration / ITERATIONS;

console.log(`✅ Channel: ${channelDuration.toFixed(2)}ms total`);
console.log(`   Throughput: ${channelOpsPerSec.toFixed(0)} ops/sec`);
console.log(`   Avg latency: ${channelLatency.toFixed(3)}ms per op`);

const speedup = redisDuration / channelDuration;
console.log(`\n🚀 Channel is ${speedup.toFixed(1)}x faster than Redis`);

console.log("\n" + "=".repeat(60));
console.log("Batch Operations (100 items/batch)");
console.log("=".repeat(60));

console.log("\n⏱️  Benchmarking Redis queue (batch)...");
const redisBatchDuration = await benchmarkRedisBatch();
const redisBatchOpsPerSec = (ITERATIONS / redisBatchDuration) * 1000;

console.log(`✅ Redis: ${redisBatchDuration.toFixed(2)}ms total`);
console.log(`   Throughput: ${redisBatchOpsPerSec.toFixed(0)} ops/sec`);

console.log("\n⏱️  Benchmarking in-memory channel (batch)...");
const channelBatchDuration = await benchmarkChannelBatch();
const channelBatchOpsPerSec = (ITERATIONS / channelBatchDuration) * 1000;

console.log(`✅ Channel: ${channelBatchDuration.toFixed(2)}ms total`);
console.log(`   Throughput: ${channelBatchOpsPerSec.toFixed(0)} ops/sec`);

const batchSpeedup = redisBatchDuration / channelBatchDuration;
console.log(`\n🚀 Channel is ${batchSpeedup.toFixed(1)}x faster than Redis (batch)`);

console.log("\n" + "=".repeat(60));
console.log("Summary");
console.log("=".repeat(60));

console.log(`
Individual Operations:
  Redis:   ${redisLatency.toFixed(3)}ms/op (${redisOpsPerSec.toFixed(0)} ops/sec)
  Channel: ${channelLatency.toFixed(3)}ms/op (${channelOpsPerSec.toFixed(0)} ops/sec)
  Speedup: ${speedup.toFixed(1)}x

Batch Operations:
  Redis:   ${redisBatchOpsPerSec.toFixed(0)} ops/sec
  Channel: ${channelBatchOpsPerSec.toFixed(0)} ops/sec
  Speedup: ${batchSpeedup.toFixed(1)}x

Expected V2 Improvement:
  Message routing: ${speedup.toFixed(0)}x faster
  End-to-end latency: ${(speedup / 4).toFixed(0)}-${speedup.toFixed(0)}x faster
  (V1 has 4 Redis calls per message, V2 has 0)
`);
