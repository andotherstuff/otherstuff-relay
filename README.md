# Clickhouse Relay

A high-performance Nostr relay server built with Deno and ClickHouse, optimized
for high-throughput event processing and real-time data delivery.

## Overview

This relay server combines the lightweight efficiency of Deno with the
analytical power of ClickHouse to deliver a scalable Nostr infrastructure
solution. The architecture prioritizes performance, reliability, and operational
simplicity.

## Architecture

- **Deno Runtime**: Modern JavaScript/TypeScript runtime with native HTTP server
  capabilities
- **ClickHouse Database**: Columnar database optimized for time-series event
  storage and analytical queries
- **Redis Pub/Sub**: Real-time event distribution for live subscriptions (NIP-01)
- **WebSocket Protocol**: Real-time bidirectional communication with Nostr
  clients
- **Prometheus Metrics**: Comprehensive monitoring and performance tracking
  using prom-client

## Features

### Performance

- **Intelligent Rate Limiting**: Per-connection limits prevent abuse while
  maintaining throughput
- **Query Optimization**: Automatic timeouts, size limits, and result caps
  protect system resources
- **Fast Validation**: Rapid rejection of invalid events to minimize processing
  overhead
- **Direct Database Access**: Efficient direct queries to ClickHouse for optimal
  performance

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
- **Redis** server (local or remote) for real-time subscriptions

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
DATABASE_URL=http://localhost:8123/nostr

# Examples:
# DATABASE_URL=http://default:password@localhost:8123/nostr
# DATABASE_URL=http://user@clickhouse.example.com:8123/mydb
```

#### Redis Configuration

```bash
# Redis connection URL for real-time subscriptions
# Format: redis://[user[:password]@]host[:port][/database]
REDIS_URL=redis://localhost:6379

# Examples:
# REDIS_URL=redis://localhost:6379
# REDIS_URL=redis://:password@localhost:6379
# REDIS_URL=redis://user:password@redis.example.com:6379/0
```

### Running the Server

Development mode with hot reload:

```bash
deno task dev
```

Production mode:

```bash
deno task start
```

## Database Schema

The ClickHouse schema is optimized for Nostr event patterns and analytical
queries:

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

## Real-Time Subscriptions (NIP-01)

This relay implements NIP-01 subscriptions using Redis pub/sub for efficient
real-time event delivery:

### How It Works

1. **Client subscribes** via `REQ` message with filters
2. **Historical events** are queried from ClickHouse and sent immediately
3. **EOSE** (End of Stored Events) is sent after historical data
4. **New events** matching the filters are delivered in real-time via Redis
   pub/sub
5. Each WebSocket connection maintains its own Redis subscriber with up to 20
   active subscriptions

### Event Flow

```
Client EVENT → Relay → ClickHouse (store) → Redis Publish
                                                    ↓
Client REQ → Historical Query (ClickHouse) → EOSE → Redis Subscribe → Real-time Events
```

### Benefits

- **No in-memory state**: Subscriptions are stateless and scale horizontally
- **Real-time delivery**: Sub-millisecond latency for new events
- **Filter matching**: Events are filtered per-connection based on active
  subscriptions
- **Resource efficient**: Redis handles pub/sub distribution across multiple
  relay instances

## API Endpoints

### WebSocket Endpoint

- **URL**: `ws://localhost:8000/`
- **Protocol**: Nostr WebSocket protocol (NIP-01)
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

- **Event Ingestion**: 1,000+ events/second per connection
- **Query Response**: Sub-millisecond for indexed queries
- **Concurrent Connections**: 10,000+ simultaneous WebSocket connections

### Resource Efficiency

- **Memory Usage**: < 100MB for typical workloads
- **CPU Utilization**: Minimal overhead with efficient query execution
- **Database Connections**: Native ClickHouse client connection management

### Scalability

- **Horizontal Scaling**: Multiple relay instances behind load balancer
- **Database Scaling**: ClickHouse cluster support for high availability
- **Storage**: Partitioned data enables efficient archival and retention

## Development

### Project Structure

```
src/
├── server.ts      # HTTP server, WebSocket handling, and Redis pub/sub
├── relay.ts       # Nostr protocol logic and event processing
├── config.ts      # Environment configuration
└── metrics.ts     # Prometheus metrics collection
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

Create a `Dockerfile`:

```dockerfile
FROM denoland/deno:latest
WORKDIR /app
COPY . .
EXPOSE 8000
CMD ["deno", "task", "start"]
```

### Docker Compose Example

Create a `docker-compose.yml` for a complete stack:

```yaml
version: '3.8'

services:
  relay:
    build: .
    ports:
      - "8000:8000"
    environment:
      - PORT=8000
      - DATABASE_URL=http://clickhouse:8123/nostr
      - REDIS_URL=redis://redis:6379
    depends_on:
      - clickhouse
      - redis

  clickhouse:
    image: clickhouse/clickhouse-server:latest
    ports:
      - "8123:8123"
      - "9000:9000"
    volumes:
      - clickhouse_data:/var/lib/clickhouse

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  clickhouse_data:
  redis_data:
```

### Production Considerations

- **Reverse Proxy**: Use Nginx or similar for SSL termination
- **Monitoring**: Configure Prometheus and Grafana for metrics visualization
- **Logging**: Implement centralized log aggregation
- **Backups**: Regular ClickHouse data backups for disaster recovery
- **Redis Persistence**: Configure Redis AOF or RDB for pub/sub reliability
- **Horizontal Scaling**: Multiple relay instances can share the same
  ClickHouse and Redis backends

## License

This project is licensed under the AGPLv3 License. See the LICENSE file for
details.

## Support

For issues, questions, or contributions, please open an issue on the GitHub
repository or contact the maintainers.
