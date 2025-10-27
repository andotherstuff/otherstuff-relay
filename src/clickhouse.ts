import { config } from "./config.ts";
import type { Event, Filter } from "./types.ts";

const CLICKHOUSE_URL =
  `http://${config.clickhouse.host}:${config.clickhouse.httpPort}`;

interface EventBatch {
  events: Event[];
  resolve: () => void;
  reject: (error: Error) => void;
}

class EventBuffer {
  private buffer: Event[] = [];
  private batchTimeout: number | null = null;
  private isProcessing = false;
  private processingQueue = 0;

  constructor(
    private batchSize: number = 10000,
    private flushInterval: number = 50,
  ) {}

  addEvent(event: Event): Promise<void> {
    return new Promise((resolve, reject) => {
      this.buffer.push(event);

      if (this.buffer.length >= this.batchSize) {
        this.flush().then(resolve).catch(() => resolve());
      } else {
        resolve();

        if (!this.batchTimeout) {
          this.scheduleFlush();
        }
      }
    });
  }

  private scheduleFlush(): void {
    if (this.batchTimeout) return;

    this.batchTimeout = setTimeout(() => {
      this.flush().catch(console.error);
    }, this.flushInterval);
  }

  private async flush(): Promise<void> {
    if (this.isProcessing || this.buffer.length === 0) return;

    this.isProcessing = true;
    this.processingQueue++;

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    const eventsToProcess = this.buffer.splice(0);
    const batchSize = eventsToProcess.length;

    try {
      await insertBatch(eventsToProcess);
      console.log(`✅ Batch inserted: ${batchSize} events`);
    } catch (error) {
      console.error(`❌ Batch failed (${batchSize} events):`, error.message);
    } finally {
      this.isProcessing = false;
      this.processingQueue--;

      if (this.buffer.length >= this.batchSize) {
        setTimeout(() => this.flush().catch(console.error), 10);
      }
    }
  }

  async flushAll(): Promise<void> {
    while (this.processingQueue > 0 || this.buffer.length > 0) {
      await this.flush();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const eventBuffer = new EventBuffer(
  parseInt(Deno.env.get("BATCH_SIZE") || "10000"),
  parseInt(Deno.env.get("FLUSH_INTERVAL") || "50"),
);

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

  const maxRetries = 5;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(30000),
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
        const delay = Math.min(200 * Math.pow(2, attempt - 1), 2000);
        if (attempt === 1) {
          console.warn(
            `ClickHouse request failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms:`,
            (error as Error).message,
          );
        } else {
          console.warn(
            `Retry ${attempt}/${maxRetries} failed, trying again in ${delay}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error("ClickHouse request failed after all retries:", lastError);
  throw lastError;
}

async function insertBatch(events: Event[]): Promise<void> {
  if (events.length === 0) return;

  const query = `
    INSERT INTO events FORMAT JSONEachRow
  `;
  const eventData = events.map((event) =>
    JSON.stringify({
      id: event.id,
      pubkey: event.pubkey,
      created_at: new Date(event.created_at * 1000).toISOString().replace(
        "T",
        " ",
      ).replace("Z", ""),
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })
  ).join("\n");

  await makeRequest(query, eventData);
}

export async function initDatabase(): Promise<void> {
  try {
    // Create database if not exists
    await makeRequest(
      `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}`,
    );

    // Create events table with optimized schema for Nostr
    await makeRequest(`
      CREATE TABLE IF NOT EXISTS events (
        id String,
        pubkey String,
        created_at DateTime64(3),
        kind UInt32,
        tags Array(Array(String)),
        content String,
        sig String,
        event_date Date MATERIALIZED toDate(created_at),
        INDEX idx_pubkey pubkey TYPE bloom_filter GRANULARITY 1,
        INDEX idx_kind kind TYPE minmax GRANULARITY 1,
        INDEX idx_created_at created_at TYPE minmax GRANULARITY 1
      ) ENGINE = MergeTree()
      PARTITION BY toYYYYMM(event_date)
      ORDER BY (kind, created_at, id)
      SETTINGS index_granularity = 8192
    `);

    console.log("✅ ClickHouse database initialized successfully");
  } catch (error) {
    console.error("❌ Failed to initialize ClickHouse database:", error);
    throw error;
  }
}

export async function insertEvent(event: Event): Promise<boolean> {
  try {
    await eventBuffer.addEvent(event);
    return true;
  } catch (error) {
    if (Deno.env.get("DEBUG")) {
      console.error("Failed to queue event:", error);
    }
    return true;
  }
}

export async function queryEvents(filter: Filter): Promise<Event[]> {
  try {
    const conditions: string[] = [];

    if (filter.ids?.length) {
      const limitedIds = filter.ids.slice(0, 1000);
      const escapedIds = limitedIds.map((id) => `'${id.replace(/'/g, "\\'")}'`)
        .join(",");
      conditions.push(`id IN (${escapedIds})`);
    }

    if (filter.authors?.length) {
      const limitedAuthors = filter.authors.slice(0, 1000);
      const escapedAuthors = limitedAuthors.map((author) =>
        `'${author.replace(/'/g, "\\'")}'`
      ).join(",");
      conditions.push(`pubkey IN (${escapedAuthors})`);
    }

    if (filter.kinds?.length) {
      conditions.push(`kind IN (${filter.kinds.join(",")})`);
    }

    if (filter.since) {
      conditions.push(`created_at >= toDateTime64(${filter.since}, 3)`);
    }

    if (filter.until) {
      conditions.push(`created_at <= toDateTime64(${filter.until}, 3)`);
    }

    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#") && Array.isArray(values) && values.length > 0) {
        const tag = key.substring(1);
        const limitedValues = (values as string[]).slice(0, 100);
        const escapedValues = limitedValues.map((v: string) =>
          `'${v.replace(/'/g, "\\'")}'`
        ).join(",");
        conditions.push(`hasAny(tags, [${tag}, ${escapedValues}])`);
      }
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const effectiveLimit = Math.min(filter.limit || 1000, 1000);
    const limitClause = `LIMIT ${effectiveLimit}`;

    const query = `
      SELECT id, pubkey, toUnixTimestamp(created_at) as created_at, kind, tags, content, sig
      FROM events
      ${whereClause}
      ORDER BY created_at DESC
      ${limitClause}
      FORMAT JSONEachRow
    `;

    const response = await makeRequest(query);
    const events: Event[] = [];

    if (response.trim()) {
      const lines = response.trim().split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          events.push({
            id: data.id,
            pubkey: data.pubkey,
            created_at: Math.floor(data.created_at),
            kind: data.kind,
            tags: data.tags || [],
            content: data.content,
            sig: data.sig,
          });
        } catch (parseError) {
          console.warn("Failed to parse event row:", line, parseError);
        }
      }
    }

    return events;
  } catch (error) {
    console.error("Failed to query events:", error);
    return [];
  }
}

export async function shutdown(): Promise<void> {
  console.log("Flushing remaining events...");
  await eventBuffer.flushAll();
}
