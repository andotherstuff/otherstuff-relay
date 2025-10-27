#!/usr/bin/env deno run --allow-net --allow-env --allow-read

import { config } from "./config.ts";
import type { Event } from "./types.ts";

const CLICKHOUSE_URL =
  `http://${config.clickhouse.host}:${config.clickhouse.httpPort}`;

interface ImportStats {
  totalLines: number;
  processedLines: number;
  validEvents: number;
  invalidEvents: number;
  startTime: number;
  batchSize: number;
  currentBatch: Event[];
}

async function makeRequest(query: string, data?: any): Promise<string> {
  const url = new URL(CLICKHOUSE_URL);

  url.searchParams.set("database", config.clickhouse.database);
  url.searchParams.set("query", query);

  const headers: Record<string, string> = {
    "Content-Type": data ? "application/json" : "text/plain",
  };

  if (config.clickhouse.user) {
    const auth = config.clickhouse.password
      ? `${config.clickhouse.user}:${config.clickhouse.password}`
      : config.clickhouse.user;
    headers["Authorization"] = `Basic ${btoa(auth)}`;
  }

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `ClickHouse HTTP error ${response.status}: ${errorText}`,
        );
      }

      return await response.text();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.warn(
          `ClickHouse request failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms:`,
          (error as Error).message,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

async function insertBatch(events: Event[]): Promise<void> {
  if (events.length === 0) return;

  const query = `
    INSERT INTO events FORMAT JSONEachRow
  `;
  
  const eventData = events.map((event) => {
    try {
      return JSON.stringify({
        id: event.id,
        pubkey: event.pubkey,
        created_at: new Date(event.created_at * 1000).toISOString().replace(
          "T",
          " ",
        ).replace("Z", ""),
        kind: event.kind,
        tags: event.tags || [],
        content: event.content,
        sig: event.sig,
      });
    } catch (error) {
      console.warn("Failed to serialize event:", event.id, error);
      return null;
    }
  }).filter(Boolean).join("\n");

  if (!eventData) {
    console.warn("No valid events in batch");
    return;
  }

  await makeRequest(query, eventData);
}

function validateEvent(event: any): event is Event {
  return (
    typeof event === "object" &&
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    typeof event.kind === "number" &&
    Array.isArray(event.tags) &&
    typeof event.content === "string" &&
    typeof event.sig === "string"
  );
}

function parseLine(line: string): Event | null {
  try {
    const event = JSON.parse(line);
    if (validateEvent(event)) {
      return event;
    } else {
      console.warn("Invalid event structure:", line.substring(0, 100) + "...");
      return null;
    }
  } catch (error) {
    console.warn("Failed to parse JSON line:", line.substring(0, 100) + "...");
    return null;
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

async function* processFile(filePath: string): AsyncGenerator<Event[], void, unknown> {
  const file = await Deno.open(filePath, { read: true });
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(64 * 1024); // 64KB buffer
  let remaining = "";
  
  try {
    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;
      
      const chunk = decoder.decode(buffer.subarray(0, bytesRead));
      const lines = (remaining + chunk).split("\n");
      remaining = lines.pop() || "";
      
      const events: Event[] = [];
      for (const line of lines) {
        if (line.trim()) {
          const event = parseLine(line.trim());
          if (event) {
            events.push(event);
          }
        }
      }
      
      if (events.length > 0) {
        yield events;
      }
    }
    
    // Process remaining data
    if (remaining.trim()) {
      const event = parseLine(remaining.trim());
      if (event) {
        yield [event];
      }
    }
  } finally {
    file.close();
  }
}

async function estimateFileStats(filePath: string): Promise<{ lines: number; size: number }> {
  console.log(`📊 Estimating file stats for ${filePath}...`);
  
  const file = await Deno.stat(filePath);
  const fileSize = file.size;
  
  // Sample first 10KB to estimate average line length
  const sampleFile = await Deno.open(filePath, { read: true });
  const decoder = new TextDecoder();
  const sampleBuffer = new Uint8Array(10 * 1024);
  const bytesRead = await sampleFile.read(sampleBuffer);
  sampleFile.close();
  
  if (bytesRead === null) return { lines: 0, size: fileSize };
  
  const sample = decoder.decode(sampleBuffer.subarray(0, bytesRead));
  const sampleLines = sample.split("\n").filter(line => line.trim());
  const avgLineLength = sampleLines.reduce((sum, line) => sum + line.length, 0) / sampleLines.length;
  
  const estimatedLines = Math.floor(fileSize / avgLineLength);
  
  return { lines: estimatedLines, size: fileSize };
}

async function main() {
  if (Deno.args.length === 0) {
    console.error("Usage: deno run --allow-net --allow-env --allow-read src/import.ts <jsonl-file>");
    Deno.exit(1);
  }

  const filePath = Deno.args[0];
  
  try {
    await Deno.stat(filePath);
  } catch {
    console.error(`❌ File not found: ${filePath}`);
    Deno.exit(1);
  }

  console.log(`🚀 Starting bulk import from ${filePath}`);
  
  const batchSize = parseInt(Deno.env.get("IMPORT_BATCH_SIZE") || "50000");
  const progressInterval = parseInt(Deno.env.get("PROGRESS_INTERVAL") || "10"); // seconds
  
  const stats = await estimateFileStats(filePath);
  console.log(`📊 File size: ${formatBytes(stats.size)}, Estimated lines: ${stats.lines.toLocaleString()}`);
  
  let processedLines = 0;
  let validEvents = 0;
  let invalidEvents = 0;
  let batchCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;
  let lastProcessedLines = 0;
  
  const currentBatch: Event[] = [];
  
  console.log(`📦 Using batch size: ${batchSize.toLocaleString()} events`);
  console.log(`⏱️  Progress update interval: ${progressInterval} seconds`);
  console.log("");
  
  try {
    for await (const events of processFile(filePath)) {
      processedLines += events.length;
      
      // Validate and add events to batch
      for (const event of events) {
        if (event) {
          currentBatch.push(event);
          validEvents++;
        } else {
          invalidEvents++;
        }
      }
      
      // Process batch when full
      if (currentBatch.length >= batchSize) {
        batchCount++;
        const batchStart = Date.now();
        
        try {
          await insertBatch(currentBatch);
          const batchDuration = Date.now() - batchStart;
          
          console.log(`✅ Batch ${batchCount}: ${currentBatch.length.toLocaleString()} events in ${batchDuration}ms`);
        } catch (error) {
          console.error(`❌ Batch ${batchCount} failed:`, error.message);
          // Continue processing other batches even if one fails
        }
        
        currentBatch.length = 0; // Clear batch
      }
      
      // Progress report
      const now = Date.now();
      if (now - lastProgressTime >= progressInterval * 1000) {
        const elapsed = now - startTime;
        const recentLines = processedLines - lastProcessedLines;
        const recentDuration = now - lastProgressTime;
        const linesPerSecond = Math.round(recentLines / (recentDuration / 1000));
        const eventsPerSecond = Math.round(validEvents / (elapsed / 1000));
        const progressPercent = (processedLines / stats.lines * 100).toFixed(1);
        const eta = Math.round((stats.lines - processedLines) / linesPerSecond);
        
        console.log(`📈 Progress: ${progressPercent}% | Lines: ${processedLines.toLocaleString()}/${stats.lines.toLocaleString()} | Events: ${validEvents.toLocaleString()} | Rate: ${linesPerSecond.toLocaleString()} lines/s, ${eventsPerSecond.toLocaleString()} events/s | ETA: ${formatDuration(eta * 1000)}`);
        
        lastProgressTime = now;
        lastProcessedLines = processedLines;
      }
    }
    
    // Process final batch
    if (currentBatch.length > 0) {
      batchCount++;
      try {
        await insertBatch(currentBatch);
        console.log(`✅ Final batch: ${currentBatch.length.toLocaleString()} events`);
      } catch (error) {
        console.error(`❌ Final batch failed:`, error.message);
      }
    }
    
    const totalTime = Date.now() - startTime;
    const avgLinesPerSecond = Math.round(processedLines / (totalTime / 1000));
    const avgEventsPerSecond = Math.round(validEvents / (totalTime / 1000));
    
    console.log("");
    console.log("🎉 Import completed!");
    console.log(`📊 Final stats:`);
    console.log(`   Total lines processed: ${processedLines.toLocaleString()}`);
    console.log(`   Valid events: ${validEvents.toLocaleString()}`);
    console.log(`   Invalid events: ${invalidEvents.toLocaleString()}`);
    console.log(`   Batches processed: ${batchCount}`);
    console.log(`   Total time: ${formatDuration(totalTime)}`);
    console.log(`   Average rate: ${avgLinesPerSecond.toLocaleString()} lines/s, ${avgEventsPerSecond.toLocaleString()} events/s`);
    console.log(`   Success rate: ${((validEvents / processedLines) * 100).toFixed(2)}%`);
    
  } catch (error) {
    console.error("❌ Import failed:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}