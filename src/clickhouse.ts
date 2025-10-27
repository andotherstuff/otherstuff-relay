import { config } from './config.ts';
import type { Event, Filter } from './types.ts';

// Connection pool for parallel access
const connectionPool: Deno.Conn[] = [];
const POOL_SIZE = config.clickhouse.poolSize;

async function getConnection(): Promise<Deno.Conn> {
  // Get or create connection from pool
  if (connectionPool.length > 0) {
    return connectionPool.pop()!;
  }
  
  // Create new connection if pool is empty
  return await Deno.connect({
    hostname: config.clickhouse.host,
    port: config.clickhouse.port,
  });
}

function releaseConnection(conn: Deno.Conn): void {
  if (connectionPool.length < POOL_SIZE) {
    connectionPool.push(conn);
  } else {
    conn.close();
  }
}

export async function initDatabase(): Promise<void> {
  const conn = await getConnection();
  
  // Create database if not exists
  await sendQuery(conn, `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}`);
  
  // Create events table with optimized schema for Nostr
  await sendQuery(conn, `
    CREATE TABLE IF NOT EXISTS ${config.clickhouse.database}.events (
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
}

async function sendQuery(conn: Deno.Conn, query: string): Promise<void> {
  const queryWithNewline = query + '\n';
  await conn.write(new TextEncoder().encode(queryWithNewline));
  
  // Read response (simple approach - just consume the response)
  const buffer = new Uint8Array(1024);
  try {
    await conn.read(buffer);
  } catch {
    // Connection might be closed, ignore
  }
}

export async function insertEvent(event: Event): Promise<boolean> {
  let conn: Deno.Conn | null = null;
  try {
    conn = await getConnection();
    
    const query = `
      INSERT INTO ${config.clickhouse.database}.events 
      FORMAT JSONEachRow
      ${JSON.stringify({
        id: event.id,
        pubkey: event.pubkey,
        created_at: new Date(event.created_at * 1000).toISOString(),
        kind: event.kind,
        tags: event.tags,
        content: event.content,
        sig: event.sig,
      })}
    `;
    
    await sendQuery(conn, query);
    return true;
  } catch (error) {
    console.error('Failed to insert event:', error);
    return false;
  } finally {
    if (conn) {
      releaseConnection(conn);
    }
  }
}

export async function queryEvents(filter: Filter): Promise<Event[]> {
  let conn: Deno.Conn | null = null;
  try {
    conn = await getConnection();
    
    const conditions: string[] = [];
    const params: any[] = [];
    
    if (filter.ids?.length) {
      conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    
    if (filter.authors?.length) {
      conditions.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }
    
    if (filter.kinds?.length) {
      conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    
    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(new Date(filter.since * 1000).toISOString());
    }
    
    if (filter.until) {
      conditions.push('created_at <= ?');
      params.push(new Date(filter.until * 1000).toISOString());
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter.limit ? `LIMIT ${filter.limit}` : '';
    
    const query = `
      SELECT id, pubkey, toUnixTimestamp(created_at) as created_at, kind, tags, content, sig
      FROM ${config.clickhouse.database}.events
      ${whereClause}
      ORDER BY created_at DESC
      ${limitClause}
      FORMAT JSONEachRow
    `;
    
    await conn.write(new TextEncoder().encode(query + '\n'));
    
    const events: Event[] = [];
    const buffer = new Uint8Array(65536);
    let bytesRead = 0;
    
    try {
      bytesRead = await conn.read(buffer);
    } catch {
      return [];
    }
    
    if (bytesRead > 0) {
      const response = new TextDecoder().decode(buffer.subarray(0, bytesRead));
      const lines = response.trim().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          events.push({
            id: data.id,
            pubkey: data.pubkey,
            created_at: data.created_at,
            kind: data.kind,
            tags: data.tags,
            content: data.content,
            sig: data.sig,
          });
        } catch {
          // Skip malformed lines
        }
      }
    }
    
    return events;
  } catch (error) {
    console.error('Failed to query events:', error);
    return [];
  } finally {
    if (conn) {
      releaseConnection(conn);
    }
  }
}