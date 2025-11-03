# Otherstuff Relay

A high-performance Nostr relay server built with Deno and ClickHouse, optimized
for high-throughput event processing and real-time data delivery.

## Overview

This relay server combines the lightweight efficiency of Deno with the
analytical power of ClickHouse to deliver a scalable Nostr infrastructure
solution. The architecture prioritizes performance, reliability, and operational
simplicity.

## Architecture

![Architecture Diagram](./diagram.png)

- **Deno Runtime**: Modern JavaScript/TypeScript runtime with native HTTP server
  capabilities (`deno serve` with 16 parallel instances)
- **Redis Queues**: High-performance in-memory queues for message passing and
  coordination
  - `nostr:relay:queue`: Raw client messages awaiting processing
  - `nostr:events:queue`: Validated events awaiting batch insertion
  - `nostr:responses:{connId}`: Responses from workers to specific connections
- **Relay Workers**: N parallel processes that validate events and handle Nostr
  protocol logic
- **Storage Workers**: Dedicated batch processors that pull validated events
  from Redis and insert into ClickHouse
- **ClickHouse Database**: Columnar database optimized for time-series event
  storage and analytical queries
- **WebSocket Protocol**: Real-time bidirectional communication with Nostr
  clients
- **Prometheus Metrics**: Comprehensive monitoring and performance tracking
  using prom-client

### Message Flow

```
Nostr Clients
    ↓ (WebSocket)
Deno Server (16 instances)
    ↓ (Queue raw messages)
Redis: nostr:relay:queue
    ↓ (Pull & process)
Relay Workers (N parallel) ← Validate in parallel
    ↓ (Queue validated events)
Redis: nostr:events:queue
    ↓ (Batch pull)
Storage Workers (M parallel)
    ↓ (Batch insert)
ClickHouse
```

This architecture solves the validation bottleneck by:

1. **Parallel validation**: N relay workers process and validate events
   concurrently
2. **Fast message queueing**: WebSocket server queues raw messages without
   blocking (microseconds)
3. **Batch storage**: Storage workers pull 1000 validated events and insert in
   one ClickHouse request
4. **Horizontal scaling**: 16 Deno instances + N relay workers + M storage
   workers = massive parallelism
5. **Shared state via Redis**: Workers coordinate through Redis (subscriptions,
   responses)

## Features

### Performance

- **Reverse Index Optimization**: Distributed reverse indexing in Redis for fast
  subscription matching (~200x faster than naive approach)
- **Intelligent Rate Limiting**: Per-connection limits prevent abuse while
  maintaining throughput
- **Query Optimization**: Automatic timeouts, size limits, and result caps
  protect system resources
- **Fast Validation**: Rapid rejection of invalid events to minimize processing
  overhead
- **Direct Database Access**: Efficient direct queries to ClickHouse for optimal
  performance

### NIP Compliance

- **NIP-01**: Full support for basic protocol, event validation, and ephemeral
  events (20000 <= k < 30000)
- **NIP-20**: Command results (OK messages) with detailed rejection reasons
- **Ephemeral Events**: Not stored in database, rejected if too old to broadcast
- **Age-Based Broadcasting**: Configurable threshold prevents stale events from
  flooding realtime subscriptions

### Reliability

- **Connection Management**: Robust resource limits and cleanup prevent memory
  leaks
- **Graceful Shutdown**: Ensures all buffered events are persisted before
  termination
- **Error Handling**: Comprehensive error recovery and logging for operational
  visibility

### Observability

- **Prometheus Metrics**: Industry-standard metrics using prom-client library
  for monitoring and alerting
- **Health Endpoints**: Real-time system status and diagnostic information
- **Structured Logging**: Clear, actionable log messages for troubleshooting

## Quick Start

### Prerequisites

- **Deno** 1.40 or later
- **ClickHouse** server (local or remote)
- **Redis** server (local or remote)

### Installation

Clone the repository and navigate to the project directory:

```bash
git clone <repository-url>
cd nostr-relay-clickhouse
```

### Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Configure the following environment variables:

#### Server Configuration

```bash
PORT=8000                                    # HTTP server port
```

#### Database Configuration

```bash
# ClickHouse connection URL
# Format: http://[user[:password]@]host[:port]/database
# If no database is specified, defaults to 'nostr'
DATABASE_URL=http://localhost:8123/nostr

# Examples:
# DATABASE_URL=http://default:password@localhost:8123/nostr
# DATABASE_URL=http://user@clickhouse.example.com:8123/my_relay_db
# DATABASE_URL=http://localhost:8123  # Uses default 'nostr' database

# Optional: Source relay identifier for tracking event origins
RELAY_SOURCE=wss://your-relay-domain.com
```

#### Redis Configuration

```bash
# Redis connection URL
# Format: redis://[user[:password]@]host[:port][/database]
REDIS_URL=redis://localhost:6379

# Examples:
# REDIS_URL=redis://:password@localhost:6379
# REDIS_URL=redis://localhost:6379/0
```

#### Broadcast Configuration

```bash
# Maximum age (in seconds) for events to broadcast to realtime subscriptions
# Events older than this won't be sent to active subscriptions (but are still stored)
# Default: 300 (5 minutes)
BROADCAST_MAX_AGE=300

# Examples:
# BROADCAST_MAX_AGE=60    # Only broadcast events from the last minute
# BROADCAST_MAX_AGE=3600  # Only broadcast events from the last hour
```

### Running the Server

### Running the Server

**Simple (recommended)** - Run everything with one command:

```bash
deno task start
```

This starts:

- 1 web server (16 Deno instances via `deno serve`)
- 4 relay workers (configurable via `NUM_RELAY_WORKERS` env var)
- 2 storage workers (configurable via `NUM_STORAGE_WORKERS` env var)

**Manual** - Run processes separately:

Terminal 1 - Relay worker(s):

```bash
deno task relay-worker
```

Terminal 2 - Storage worker(s):

```bash
deno task storage-worker
```

Terminal 3 - Web server:

```bash
deno task server
```

### Scaling Workers

Adjust the number of worker processes in `.env`:

```bash
NUM_RELAY_WORKERS=8      # Run 8 relay workers for parallel validation
NUM_STORAGE_WORKERS=4    # Run 4 storage workers for higher write throughput
```

Or set it when running:

```bash
NUM_RELAY_WORKERS=8 NUM_STORAGE_WORKERS=4 deno task start
```

## Database Schema

The ClickHouse schema is optimized for Nostr event patterns and analytical
queries:

### Main Events Table

```sql
CREATE TABLE events_local (
    id String COMMENT '32-byte hex event ID (SHA-256 hash)',
    pubkey String COMMENT '32-byte hex public key of event creator',
    created_at DateTime COMMENT 'Unix timestamp when event was created',
    kind UInt16 COMMENT 'Event kind (0-65535, see NIP-01)',
    content String COMMENT 'Event content (arbitrary string, format depends on kind)',
    sig String COMMENT '64-byte hex Schnorr signature',
    tags Array(Array(String)) COMMENT 'Nested array of tags',
    indexed_at DateTime DEFAULT now() COMMENT 'When this event was indexed into Clickhouse',
    relay_source String DEFAULT '' COMMENT 'Source relay URL (e.g., wss://relay.damus.io)',
    PRIMARY KEY (id),
    INDEX idx_kind kind TYPE minmax GRANULARITY 4,
    INDEX idx_pubkey pubkey TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = ReplacingMergeTree(indexed_at)
ORDER BY (created_at, kind, pubkey)
PARTITION BY toYYYYMM(created_at)
```

### Tag Optimization

A materialized view automatically flattens tags for fast queries:

```sql
CREATE MATERIALIZED VIEW event_tags_flat
AS SELECT
    id as event_id,
    pubkey,
    created_at,
    kind,
    arrayJoin(tags) as tag_array,
    tag_array[1] as tag_name,
    tag_array[2] as tag_value_1
FROM events_local
```

### Statistics Views

Additional views provide analytics and monitoring:

- `event_stats` - Daily event counts by kind
- `relay_stats` - Source relay statistics
- `tag_stats` - Tag frequency analysis

The tables are automatically created on server startup. Events are inserted in
batches by the worker process.

## API Endpoints

### WebSocket Endpoint

- **URL**: `ws://localhost:8000/`
- **Protocol**: Nostr WebSocket protocol
- **Purpose**: Real-time event streaming and client communication

### Health Check

- **URL**: `GET /health`
- **Response**: JSON object with system status
- **Purpose**: Service health monitoring and load balancer checks

### Metrics

- **URL**: `GET /metrics`
- **Format**: Prometheus text format
- **Purpose**: Performance monitoring and alerting

## Performance Characteristics

### Throughput

- **Event Ingestion**: 10,000+ events/second with parallel validation
- **Validation**: Scales linearly with number of relay workers
- **Query Response**: Sub-millisecond for indexed queries
- **Concurrent Connections**: 10,000+ simultaneous WebSocket connections

### Resource Efficiency

- **Memory Usage**: ~50MB per worker process
- **CPU Utilization**: Distributed across relay workers for parallel validation
- **Database Connections**: Pooled connections per storage worker
- **Queue Latency**: < 1ms for message queueing, ~10ms for response delivery

### Scalability

- **Parallel Validation**: N relay workers process events concurrently
- **Horizontal Scaling**: Multiple server instances + workers behind load
  balancer
- **Database Scaling**: ClickHouse cluster support for high availability
- **Storage**: Partitioned data enables efficient archival and retention

## Development

### Project Structure

```
src/
├── server.ts         # HTTP server and WebSocket handling
├── relay-worker.ts   # Relay worker for parallel message processing & validation
├── storage-worker.ts # Storage worker for batch ClickHouse inserts
├── start.ts          # Process manager to run all components
├── config.ts         # Environment configuration
└── metrics.ts        # Prometheus metrics collection
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Implement your changes with appropriate tests
4. Ensure all formatting checks pass
5. Submit a pull request with a clear description

### Code Standards

- **TypeScript**: Strict type checking enabled
- **Formatting**: Deno formatter for consistent code style
- **Documentation**: Comprehensive inline documentation
- **Testing**: Unit tests for critical functionality

## Deployment

### Docker Deployment

```dockerfile
FROM denoland/deno:latest
WORKDIR /app
COPY . .
EXPOSE 8000
CMD ["deno", "task", "start"]
```

### Production Considerations

- **Reverse Proxy**: Use Nginx or similar for SSL termination
- **Monitoring**: Configure Prometheus and Grafana for metrics visualization
- **Logging**: Implement centralized log aggregation
- **Backups**: Regular ClickHouse data backups for disaster recovery

## License

This project is licensed under the AGPLv3 License. See the LICENSE file for
details.

## Support

For issues, questions, or contributions, please open an issue on the GitHub
repository or contact the maintainers.
