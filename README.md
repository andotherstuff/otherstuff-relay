# Nostr Relay with ClickHouse

A high-performance Nostr relay server built with Deno and ClickHouse, optimized for high throughput and real-time event processing.

## Architecture

- **Deno**: Modern JavaScript/TypeScript runtime with native HTTP server
- **ClickHouse**: Columnar database for efficient event storage and querying
- **WebSocket**: Real-time communication with Nostr clients
- **Metrics**: Prometheus-compatible metrics endpoint

## Features

- ✅ Native ClickHouse integration with optimized schema
- ✅ Async event insertion for low latency
- ✅ Efficient filtering with indexed columns
- ✅ Connection pooling and management
- ✅ Prometheus metrics
- ✅ Graceful shutdown
- ✅ Minimal, performant codebase

## Quick Start

### Prerequisites

- Deno 1.40+
- ClickHouse server

### Configuration

Environment variables:

```bash
# Server
PORT=8000

# ClickHouse
CLICKHOUSE_HOST=localhost
CLICKHOUSE_PORT=9000
CLICKHOUSE_DATABASE=nostr
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=

# Features
NO_VERIFICATION=false    # Disable signature verification for performance
METRICS_ENABLED=true     # Enable metrics endpoint
```

### Running

```bash
# Development mode with hot reload
deno task dev

# Production mode
deno task start
```

## Database Schema

The ClickHouse schema is optimized for Nostr event patterns:

```sql
CREATE TABLE events (
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
```

## Performance Features

1. **Async Event Insertion**: Events are validated and responded to immediately, then inserted asynchronously
2. **Optimized ClickHouse Schema**: Partitioned by date, ordered for common query patterns
3. **Bloom Filter Indexes**: Fast pubkey lookups
4. **Connection Reuse**: Single ClickHouse connection per server instance
5. **Minimal Dependencies**: Core functionality without bloat

## Monitoring

- **Health**: `GET /health`
- **Metrics**: `GET /metrics` (Prometheus format)
- **WebSocket**: `GET /` (Nostr relay endpoint)

## Development

The codebase is intentionally minimal and focused on performance:

- `src/server.ts`: HTTP server and WebSocket handling
- `src/relay.ts`: Nostr protocol logic and subscription management
- `src/clickhouse.ts`: Database operations and schema
- `src/types.ts`: TypeScript type definitions
- `src/config.ts`: Environment configuration
- `src/metrics.ts`: Prometheus metrics collection

## License

MIT