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

async function makeRequest(query: string, data?: any, isRawData: boolean = false): Promise<string> {
  const url = new URL(CLICKHOUSE_URL);

  url.searchParams.set("database", config.clickhouse.database);
  url.searchParams.set("query", query);

  const headers: Record<string, string> = {
    "Content-Type": data ? (isRawData ? "text/plain" : "application/json") : "text/plain",
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
        body: data ? (isRawData ? data : JSON.stringify(data)) : undefined,
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

async function insertBatch(events: Event[]): Promise<{ success: number; failed: number }> {
  if (events.length === 0) return { success: 0, failed: 0 };

  // Validate and transform events before sending to ClickHouse
  const validEvents: any[] = [];
  let serializationErrors = 0;
  
  for (const event of events) {
    try {
      // Transform the event to ClickHouse format
      const transformedEvent = {
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
      };
      validEvents.push(transformedEvent);
    } catch (error) {
      console.warn("Failed to transform event:", event.id, error);
      serializationErrors++;
    }
  }

  if (validEvents.length === 0) {
    console.warn("No valid events in batch");
    return { success: 0, failed: events.length };
  }

  // Create the query with FORMAT JSONEachRow
  const query = `
    INSERT INTO events FORMAT JSONEachRow
  `;

  // Create the JSONEachRow data (one JSON object per line)
  const eventData = validEvents
    .map(event => JSON.stringify(event))
    .join("\n");

  try {
    // Send the raw JSONEachRow data as the body
    await makeRequest(query, eventData, true); // Mark as raw data
    return { 
      success: validEvents.length, 
      failed: serializationErrors 
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Batch insert failed for ${validEvents.length} events:`, errorMessage);
    
    // If the entire batch fails, try individual events
    console.log("Attempting to insert events individually...");
    let individualSuccess = 0;
    let individualFailed = serializationErrors;
    
    for (const event of validEvents) {
      try {
        const individualEventData = JSON.stringify(event);
        await makeRequest(query, individualEventData, true); // Mark as raw data
        individualSuccess++;
      } catch (individualError) {
        const individualErrorMessage = individualError instanceof Error ? individualError.message : String(individualError);
        console.warn("Individual event insert failed:", individualErrorMessage);
        individualFailed++;
      }
    }
    
    return { 
      success: individualSuccess, 
      failed: individualFailed 
    };
  }
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
  // Skip empty lines early
  if (!line || !line.trim()) {
    return null;
  }

  try {
    // Basic JSON validation before full parsing
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      console.warn("Invalid JSON format - not an object:", trimmed.substring(0, 100) + "...");
      return null;
    }

    const event = JSON.parse(trimmed);
    
    // Additional validation to prevent parsing of obviously wrong data
    if (!event || typeof event !== 'object') {
      console.warn("Parsed data is not an object:", trimmed.substring(0, 100) + "...");
      return null;
    }

    if (validateEvent(event)) {
      return event;
    } else {
      console.warn("Invalid event structure:", trimmed.substring(0, 100) + "...");
      return null;
    }
  } catch (error) {
    // More specific error handling
    const errorMessage = (error as Error).message;
    if (errorMessage.includes('Unexpected token')) {
      console.warn("JSON syntax error:", errorMessage, "-", line.substring(0, 100) + "...");
    } else if (errorMessage.includes('Unexpected end')) {
      console.warn("Incomplete JSON data:", line.substring(0, 100) + "...");
    } else {
      console.warn("JSON parse error:", errorMessage, "-", line.substring(0, 100) + "...");
    }
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

interface FileProcessorStats {
  totalChunks: number;
  successfulChunks: number;
  failedChunks: number;
  consecutiveFailures: number;
}

async function* processFile(filePath: string): AsyncGenerator<Event[], void, unknown> {
  const file = await Deno.open(filePath, { read: true });
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(64 * 1024); // 64KB buffer
  let remaining = "";
  let chunkCount = 0;
  
  const stats: FileProcessorStats = {
    totalChunks: 0,
    successfulChunks: 0,
    failedChunks: 0,
    consecutiveFailures: 0
  };
  
  const MAX_CONSECUTIVE_FAILURES = 10;
  
  try {
    while (true) {
      let bytesRead: number | null;
      try {
        bytesRead = await file.read(buffer);
        stats.consecutiveFailures = 0; // Reset on successful read
      } catch (readError) {
        stats.failedChunks++;
        stats.consecutiveFailures++;
        const readErrorMessage = readError instanceof Error ? readError.message : String(readError);
        console.error(`File read error in chunk ${chunkCount}:`, readErrorMessage);
        
        // Circuit breaker: stop if too many consecutive failures
        if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`Too many consecutive read failures (${MAX_CONSECUTIVE_FAILURES}), stopping file processing`);
          break;
        }
        
        chunkCount++;
        continue;
      }
      
      if (bytesRead === null) break;
      
      let chunk: string;
      try {
        chunk = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      } catch (decodeError) {
        stats.failedChunks++;
        stats.consecutiveFailures++;
        const decodeErrorMessage = decodeError instanceof Error ? decodeError.message : String(decodeError);
        console.error(`Text decoding error in chunk ${chunkCount}:`, decodeErrorMessage);
        
        if (stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`Too many consecutive decode failures (${MAX_CONSECUTIVE_FAILURES}), stopping file processing`);
          break;
        }
        
        chunkCount++;
        continue;
      }
      
      stats.consecutiveFailures = 0; // Reset on successful decode
      const lines = (remaining + chunk).split("\n");
      remaining = lines.pop() || "";
      
      const events: Event[] = [];
      let lineParseErrors = 0;
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = parseLine(line.trim());
            if (event) {
              events.push(event);
            }
          } catch (parseError) {
            lineParseErrors++;
            const parseErrorMessage = parseError instanceof Error ? parseError.message : String(parseError);
            // Only log first few errors per chunk to avoid spam
            if (lineParseErrors <= 3) {
              console.warn("Error parsing line in chunk:", parseErrorMessage);
            }
          }
        }
      }
      
      if (lineParseErrors > 3) {
        console.warn(`... ${lineParseErrors - 3} additional line parsing errors in chunk ${chunkCount}`);
      }
      
      if (events.length > 0) {
        stats.successfulChunks++;
        yield events;
      } else if (lineParseErrors === 0) {
        // Chunk had no events and no parse errors, likely empty or whitespace
        stats.successfulChunks++;
      }
      
      stats.totalChunks++;
      chunkCount++;
      
      // Log progress every 1000 chunks for very large files
      if (chunkCount % 1000 === 0) {
        console.log(`📖 Processed ${chunkCount.toLocaleString()} chunks (${stats.successfulChunks} successful, ${stats.failedChunks} failed)`);
      }
    }
    
    // Process remaining data
    if (remaining.trim()) {
      try {
        const event = parseLine(remaining.trim());
        if (event) {
          yield [event];
        }
      } catch (finalParseError) {
        const finalParseErrorMessage = finalParseError instanceof Error ? finalParseError.message : String(finalParseError);
        console.warn("Error parsing final remaining data:", finalParseErrorMessage);
      }
    }
    
    console.log(`📚 File processing complete: ${stats.totalChunks.toLocaleString()} total chunks, ${stats.successfulChunks.toLocaleString()} successful, ${stats.failedChunks.toLocaleString()} failed`);
  } finally {
    try {
      file.close();
    } catch (closeError) {
      const closeErrorMessage = closeError instanceof Error ? closeError.message : String(closeError);
      console.error("Error closing file:", closeErrorMessage);
    }
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
  let successfulInserts = 0;
  let failedInserts = 0;
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
        
        const result = await insertBatch(currentBatch);
        const batchDuration = Date.now() - batchStart;
        
        successfulInserts += result.success;
        failedInserts += result.failed;
        
        if (result.success > 0) {
          console.log(`✅ Batch ${batchCount}: ${result.success.toLocaleString()} successful, ${result.failed.toLocaleString()} failed in ${batchDuration}ms`);
        } else {
          console.log(`❌ Batch ${batchCount}: All ${result.failed.toLocaleString()} events failed in ${batchDuration}ms`);
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
      const result = await insertBatch(currentBatch);
      successfulInserts += result.success;
      failedInserts += result.failed;
      
      if (result.success > 0) {
        console.log(`✅ Final batch: ${result.success.toLocaleString()} successful, ${result.failed.toLocaleString()} failed`);
      } else {
        console.log(`❌ Final batch: All ${result.failed.toLocaleString()} events failed`);
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
    console.log(`   Successful inserts: ${successfulInserts.toLocaleString()}`);
    console.log(`   Failed inserts: ${failedInserts.toLocaleString()}`);
    console.log(`   Batches processed: ${batchCount}`);
    console.log(`   Total time: ${formatDuration(totalTime)}`);
    console.log(`   Average rate: ${avgLinesPerSecond.toLocaleString()} lines/s, ${avgEventsPerSecond.toLocaleString()} events/s`);
    console.log(`   Parse success rate: ${((validEvents / processedLines) * 100).toFixed(2)}%`);
    console.log(`   Insert success rate: ${((successfulInserts / (successfulInserts + failedInserts)) * 100).toFixed(2)}%`);
    
  } catch (error) {
    console.error("❌ Import failed:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}