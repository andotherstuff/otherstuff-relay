/**
 * Batch import utility for importing large JSONL files of Nostr events
 * Optimized for handling 10GB+ files with streaming and batch processing
 */
import { createClient } from "@clickhouse/client-web";
import { setNostrWasm, verifyEvent } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";
import { Config } from "./config.ts";
import type { NostrEvent } from "@nostrify/nostrify";

interface ImportStats {
  totalLines: number;
  validEvents: number;
  invalidEvents: number;
  duplicateEvents: number;
  errors: number;
  startTime: number;
  lastReportTime: number;
}

interface ImportOptions {
  batchSize?: number; // Number of events to batch before inserting (default: 5000)
  skipValidation?: boolean; // Skip cryptographic validation (faster but risky)
  skipDuplicates?: boolean; // Check for duplicates before inserting (slower but safer)
  parallelValidation?: number; // Number of parallel validation workers (default: 4)
  progressInterval?: number; // Progress report interval in seconds (default: 5)
}

class EventImporter {
  private clickhouse;
  private stats: ImportStats;
  private seenIds = new Set<string>();
  private wasmInitialized: Promise<void>;

  constructor(private options: ImportOptions = {}) {
    const config = new Config(Deno.env);
    this.clickhouse = createClient({
      url: config.databaseUrl,
    });

    this.stats = {
      totalLines: 0,
      validEvents: 0,
      invalidEvents: 0,
      duplicateEvents: 0,
      errors: 0,
      startTime: Date.now(),
      lastReportTime: Date.now(),
    };

    // Initialize WASM for signature verification
    this.wasmInitialized = (async () => {
      const wasm = await initNostrWasm();
      setNostrWasm(wasm);
    })();
  }

  /**
   * Import events from a JSONL file
   */
  async importFile(filePath: string): Promise<void> {
    console.log(`📂 Starting import from: ${filePath}`);
    console.log(`⚙️  Options:`, {
      batchSize: this.options.batchSize || 5000,
      skipValidation: this.options.skipValidation || false,
      skipDuplicates: this.options.skipDuplicates || false,
      parallelValidation: this.options.parallelValidation || 4,
    });

    const file = await Deno.open(filePath, { read: true });
    const decoder = new TextDecoder();
    let buffer = "";
    let batch: NostrEvent[] = [];
    const batchSize = this.options.batchSize || 5000;

    try {
      // Read file in chunks for memory efficiency
      const chunkSize = 64 * 1024; // 64KB chunks
      const readBuffer = new Uint8Array(chunkSize);

      while (true) {
        const bytesRead = await file.read(readBuffer);
        if (bytesRead === null) break;

        buffer += decoder.decode(readBuffer.subarray(0, bytesRead), {
          stream: true,
        });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          this.stats.totalLines++;

          try {
            const event = JSON.parse(line) as NostrEvent;

            // Basic validation
            if (!this.isValidEventStructure(event)) {
              this.stats.invalidEvents++;
              continue;
            }

            // Check for duplicates in current session
            if (this.seenIds.has(event.id)) {
              this.stats.duplicateEvents++;
              continue;
            }
            this.seenIds.add(event.id);

            batch.push(event);

            // Insert batch when it reaches the target size
            if (batch.length >= batchSize) {
              await this.processBatch(batch);
              batch = [];
            }
          } catch (error) {
            this.stats.errors++;
            console.error(`Error parsing line ${this.stats.totalLines}:`, error);
          }

          // Report progress
          this.reportProgress();
        }
      }

      // Process any remaining events in the last batch
      if (batch.length > 0) {
        await this.processBatch(batch);
      }

      // Process final incomplete line if any
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as NostrEvent;
          if (this.isValidEventStructure(event) && !this.seenIds.has(event.id)) {
            await this.processBatch([event]);
          }
        } catch (error) {
          this.stats.errors++;
          console.error("Error parsing final line:", error);
        }
      }
    } finally {
      file.close();
    }

    this.printFinalStats();
  }

  /**
   * Process a batch of events with parallel validation
   */
  private async processBatch(events: NostrEvent[]): Promise<void> {
    if (events.length === 0) return;

    let validatedEvents = events;

    // Validate events if not skipped
    if (!this.options.skipValidation) {
      validatedEvents = await this.validateBatch(events);
    }

    // Check for duplicates in database if enabled
    if (this.options.skipDuplicates && validatedEvents.length > 0) {
      validatedEvents = await this.filterDuplicates(validatedEvents);
    }

    // Insert into ClickHouse
    if (validatedEvents.length > 0) {
      await this.insertBatch(validatedEvents);
    }
  }

  /**
   * Validate a batch of events with parallel processing
   */
  private async validateBatch(events: NostrEvent[]): Promise<NostrEvent[]> {
    await this.wasmInitialized;

    const parallelism = this.options.parallelValidation || 4;
    const validEvents: NostrEvent[] = [];

    // Split events into chunks for parallel processing
    const chunkSize = Math.ceil(events.length / parallelism);
    const chunks: NostrEvent[][] = [];

    for (let i = 0; i < events.length; i += chunkSize) {
      chunks.push(events.slice(i, i + chunkSize));
    }

    // Validate chunks in parallel
    const results = await Promise.all(
      chunks.map((chunk) => this.validateChunk(chunk))
    );

    // Combine results
    for (const result of results) {
      validEvents.push(...result);
    }

    return validEvents;
  }

  /**
   * Validate a chunk of events
   */
  private async validateChunk(events: NostrEvent[]): Promise<NostrEvent[]> {
    const validEvents: NostrEvent[] = [];

    for (const event of events) {
      try {
        const isValid = await verifyEvent(event);
        if (isValid) {
          validEvents.push(event);
          this.stats.validEvents++;
        } else {
          this.stats.invalidEvents++;
        }
      } catch (error) {
        this.stats.invalidEvents++;
        console.error(`Validation error for event ${event.id}:`, error);
      }
    }

    return validEvents;
  }

  /**
   * Filter out events that already exist in the database
   */
  private async filterDuplicates(
    events: NostrEvent[]
  ): Promise<NostrEvent[]> {
    const ids = events.map((e) => e.id);

    const query = `
      SELECT id
      FROM nostr_events
      WHERE id IN {ids:Array(String)}
    `;

    const resultSet = await this.clickhouse.query({
      query,
      query_params: { ids },
      format: "JSONEachRow",
    });

    const existingIds = new Set(
      (await resultSet.json<{ id: string }>()).map((row) => row.id)
    );

    const duplicateCount = existingIds.size;
    this.stats.duplicateEvents += duplicateCount;

    return events.filter((event) => !existingIds.has(event.id));
  }

  /**
   * Insert a batch of events into ClickHouse
   */
  private async insertBatch(events: NostrEvent[]): Promise<void> {
    try {
      await this.clickhouse.insert({
        table: "nostr_events",
        values: events.map((event) => ({
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
          sig: event.sig,
        })),
        format: "JSONEachRow",
      });
    } catch (error) {
      this.stats.errors++;
      console.error(`Failed to insert batch of ${events.length} events:`, error);
      throw error;
    }
  }

  /**
   * Basic structural validation
   */
  private isValidEventStructure(event: unknown): event is NostrEvent {
    if (!event || typeof event !== "object") return false;

    const e = event as Partial<NostrEvent>;

    return (
      typeof e.id === "string" &&
      typeof e.pubkey === "string" &&
      typeof e.created_at === "number" &&
      typeof e.kind === "number" &&
      Array.isArray(e.tags) &&
      typeof e.content === "string" &&
      typeof e.sig === "string"
    );
  }

  /**
   * Report progress periodically
   */
  private reportProgress(): void {
    const now = Date.now();
    const interval = (this.options.progressInterval || 5) * 1000;

    if (now - this.stats.lastReportTime >= interval) {
      const elapsed = (now - this.stats.startTime) / 1000;
      const rate = Math.round(this.stats.totalLines / elapsed);

      console.log(
        `📊 Progress: ${this.stats.totalLines.toLocaleString()} lines, ` +
          `${this.stats.validEvents.toLocaleString()} valid, ` +
          `${this.stats.invalidEvents.toLocaleString()} invalid, ` +
          `${this.stats.duplicateEvents.toLocaleString()} duplicates, ` +
          `${rate.toLocaleString()} lines/sec`
      );

      this.stats.lastReportTime = now;
    }
  }

  /**
   * Print final import statistics
   */
  private printFinalStats(): void {
    const elapsed = (Date.now() - this.stats.startTime) / 1000;
    const rate = Math.round(this.stats.totalLines / elapsed);

    console.log("\n" + "=".repeat(60));
    console.log("📈 Import Complete!");
    console.log("=".repeat(60));
    console.log(`Total lines processed: ${this.stats.totalLines.toLocaleString()}`);
    console.log(`Valid events:          ${this.stats.validEvents.toLocaleString()}`);
    console.log(`Invalid events:        ${this.stats.invalidEvents.toLocaleString()}`);
    console.log(`Duplicate events:      ${this.stats.duplicateEvents.toLocaleString()}`);
    console.log(`Errors:                ${this.stats.errors.toLocaleString()}`);
    console.log(`Time elapsed:          ${elapsed.toFixed(2)}s`);
    console.log(`Processing rate:       ${rate.toLocaleString()} lines/sec`);
    console.log("=".repeat(60) + "\n");
  }

  /**
   * Close the importer and cleanup resources
   */
  async close(): Promise<void> {
    await this.clickhouse.close();
  }
}

// CLI interface
if (import.meta.main) {
  const args = Deno.args;

  if (args.length === 0) {
    console.log(`
Usage: deno run -A src/import.ts <file.jsonl> [options]

Options:
  --batch-size <n>           Number of events per batch (default: 5000)
  --skip-validation          Skip cryptographic signature validation (faster but risky)
  --skip-duplicates          Check and skip duplicate events (slower but safer)
  --parallel <n>             Number of parallel validation workers (default: 4)
  --progress-interval <n>    Progress report interval in seconds (default: 5)

Examples:
  # Basic import
  deno run -A src/import.ts events.jsonl

  # Fast import without validation (use only for trusted data)
  deno run -A src/import.ts events.jsonl --skip-validation

  # Safe import with duplicate checking
  deno run -A src/import.ts events.jsonl --skip-duplicates

  # Tuned for performance
  deno run -A src/import.ts events.jsonl --batch-size 10000 --parallel 8
    `);
    Deno.exit(1);
  }

  const filePath = args[0];
  const options: ImportOptions = {};

  // Parse CLI arguments
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--batch-size":
        options.batchSize = parseInt(args[++i]);
        break;
      case "--skip-validation":
        options.skipValidation = true;
        break;
      case "--skip-duplicates":
        options.skipDuplicates = true;
        break;
      case "--parallel":
        options.parallelValidation = parseInt(args[++i]);
        break;
      case "--progress-interval":
        options.progressInterval = parseInt(args[++i]);
        break;
    }
  }

  const importer = new EventImporter(options);

  try {
    await importer.importFile(filePath);
  } catch (error) {
    console.error("❌ Import failed:", error);
    Deno.exit(1);
  } finally {
    await importer.close();
  }
}

export { EventImporter };
