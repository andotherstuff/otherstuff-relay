# Otherstuff Relay

A high-performance Nostr relay server built with Deno and OpenSearch, optimized
for high-throughput event processing, real-time data delivery, and full-text
search.

## Overview

This relay server combines the lightweight efficiency of Deno with the search
power of OpenSearch to deliver a scalable Nostr infrastructure solution with
native NIP-50 full-text search support. The architecture prioritizes
performance, reliability, and operational simplicity.

**Two architectures available:**
- **V1 (Redis-based)**: Distributed architecture with Redis queues for horizontal scaling
- **V2 (In-memory)**: High-performance single-instance with in-memory channels (**10-100x faster**)

See [V1 vs V2 Comparison](./docs/V1_VS_V2.md) and [Performance Optimizations](./PERFORMANCE_OPTIMIZATIONS.md) for details.

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
  from Redis and insert into OpenSearch using bulk API
- **OpenSearch Database**: Full-text search engine optimized for fast queries,
  full-text search (NIP-50), and comprehensive tag indexing
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
    ↓ (Bulk insert - up to 1000 events/batch)
OpenSearch
```

This architecture solves the validation bottleneck by:

1. **Parallel validation**: N relay workers process and validate events
   concurrently
2. **Fast message queueing**: WebSocket server queues raw messages without
   blocking (microseconds)
3. **Batch storage**: Storage workers pull 1000 validated events and insert in
   one OpenSearch bulk request
4. **Horizontal scaling**: 16 Deno instances + N relay workers + M storage
   workers = massive parallelism
5. **Shared state via Redis**: Workers coordinate through Redis (subscriptions,
   responses)
6. **Optimized indexing**: All tags are indexed for fast queries, including
   multi-letter tags

## Features

### NIP Support

- **NIP-01**: Basic protocol flow, event validation, filtering, and real-time
  subscriptions with inverted indexes
- **NIP-09**: Event deletion requests (kind 5 events)
- **NIP-11**: Relay information document
- **NIP-50**: Full-text search with advanced sort modes (hot, top,
  controversial, rising)
- **NIP-86**: Relay management API with NIP-98 authentication
- **NIP-98**: HTTP authentication for management API

### Performance

- **Inverted Index Subscriptions**: O(log n) subscription matching using Redis
  inverted indexes for efficient real-time event broadcasting
- **Intelligent Rate Limiting**: Per-connection limits prevent abuse while
  maintaining throughput
- **Query Optimization**: Automatic timeouts, size limits, and result caps
  protect system resources
- **Fast Validation**: Rapid rejection of invalid events to minimize processing
  overhead
- **Optimized Queries**: OpenSearch provides sub-millisecond queries with proper
  indexing
- **Full-Text Search**: Native NIP-50 support with relevance scoring and fuzzy
  matching
- **Advanced Sort Modes**: NIP-50 extensions for `sort:hot`, `sort:top`,
  `sort:controversial`, and `sort:rising` to discover trending and popular
  content
- **Comprehensive Tag Indexing**: All tags indexed for fast filtering, including
  multi-letter tags
- **Bulk Insert**: Storage workers use OpenSearch bulk API for high-throughput
  writes
- **Event Age Filtering**: Configurable age-based filtering prevents
  broadcasting of stale events to subscribers, with special handling for
  ephemeral events
- **Event Deletion**: NIP-09 deletion requests processed automatically, with
  pubkey verification and timestamp-based deletion for addressable events

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
- **OpenSearch** server (local or remote)
- **Redis** server (local or remote)

### Installation

Clone the repository and navigate to the project directory:

```bash
git clone <repository-url>
cd otherstuff-relay
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
# OpenSearch connection URL
# Format: http://[host]:[port] or https://[host]:[port]
OPENSEARCH_URL=http://localhost:9200

# Examples:
# OPENSEARCH_URL=http://localhost:9200
# OPENSEARCH_URL=https://opensearch.example.com:9200

# OpenSearch authentication (optional)
# Leave blank if no authentication is required
OPENSEARCH_USERNAME=
OPENSEARCH_PASSWORD=
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

#### Event Filtering Configuration

```bash
# Maximum age of events to broadcast to subscribers (in seconds)
# Events older than this will not be broadcast to subscribers
# Ephemeral events (kind 20000-29999) are never stored, only broadcast
# Ephemeral events that are too old will be rejected with a false OK message
# Set to 0 to disable age filtering
# Default: 300 (5 minutes)
BROADCAST_MAX_AGE=300
```

#### NIP-86 Management API Configuration

```bash
# Comma-separated list of admin pubkeys (hex format) authorized to use the management API
# Leave empty to disable the management API
ADMIN_PUBKEYS=pubkey1,pubkey2,pubkey3

# Relay URL for NIP-98 authentication (optional)
# If set, this URL will be used for validating the 'u' tag in NIP-98 auth events
# instead of the actual request URL. Useful when the relay is behind a reverse proxy
# or load balancer where the internal URL differs from the public URL.
# Example: RELAY_URL=https://relay.example.com/
RELAY_URL=
```

### Database Setup

Before running the server, initialize the OpenSearch index:

```bash
deno task migrate
```

This creates the `nostr-events` index with optimized mappings for:

- Fast tag filtering (all tags indexed)
- Full-text search on content (NIP-50)
- Time-based queries
- Relevance scoring

### Analytics

Find the most popular events based on how many times they are referenced by
other events via `e` tags:

```bash
# Most popular events in the last 24 hours
deno task trends --duration 24h

# Most popular events in the last 7 days, top 50
deno task trends --duration 7d --limit 50

# Most popular kind 1 (text notes) events in the last 7 days
deno task trends --duration 7d --target-kinds 1

# Most popular events referenced by kind 6 (reposts) and kind 7 (reactions)
deno task trends --duration 24h --source-kinds 6,7

# Most popular kind 1 events referenced by kind 1 events (notes citing notes)
deno task trends --duration 7d --source-kinds 1 --target-kinds 1

# Most popular events between specific dates
deno task trends --since 2025-11-01 --until 2025-11-15

# Most popular events since a specific timestamp
deno task trends --since 1700000000

# Just show IDs and counts (faster)
deno task trends --duration 24h --no-event-data

# Show all options
deno task trends --help
```

### Running the Server

**IMMORTAL MODE (Unkillable - Recommended):**

```bash
deno task start
```

Features:
- **NEVER dies from queue overload** - Removed artificial limits
- **Massive parallelization** - 64 validation workers + 8 storage workers
- **Auto-recovery** - Workers automatically restart if they die
- **10,000+ events/sec** - High throughput with parallel processing
- **Infinite queue capacity** - Redis queue grows as needed

See [IMMORTAL_RELAY.md](./IMMORTAL_RELAY.md) for details.

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
NUM_RELAY_WORKERS=64      # Run 64 relay workers for parallel validation
NUM_STORAGE_WORKERS=4    # Run 4 storage workers for higher write throughput
```

Or set it when running:

```bash
NUM_RELAY_WORKERS=8 NUM_STORAGE_WORKERS=4 deno task start
```

## Database Schema

The OpenSearch index is optimized for Nostr event patterns with comprehensive
tag indexing and full-text search:

### Index Mapping

The `nostr-events` index includes:

**Core Fields:**

- `id` (keyword) - Event ID, used as document ID
- `pubkey` (keyword) - Author's public key
- `created_at` (long) - Unix timestamp
- `kind` (integer) - Event kind
- `content` (text) - Full-text searchable content with custom analyzer
- `sig` (keyword) - Event signature
- `tags` (keyword array) - Original tag structure

**Optimized Tag Fields:**

- `tag_e` (keyword array) - Event references
- `tag_p` (keyword array) - Pubkey references
- `tag_a` (keyword array) - Address references
- `tag_d` (keyword array) - Identifier tags
- `tag_t` (keyword array) - Hashtags
- `tag_r` (keyword array) - URL references
- `tag_g` (keyword array) - Geohash tags

**Generic Tag Storage:**

- `tags_flat` (nested) - All other tags indexed as `{name, value}` pairs

**Metadata:**

- `indexed_at` (long) - Indexing timestamp

### Query Performance

- **Tag queries**: O(log n) lookup using keyword fields
- **Multi-letter tags**: Fully supported via nested `tags_flat` structure
- **Full-text search**: Native NIP-50 support with relevance scoring
- **Time-range queries**: Optimized with `created_at` field
- **Bulk inserts**: Up to 1000 events per batch using bulk API

The index is automatically created by running `deno task migrate`.

## API Endpoints

### WebSocket Endpoint

- **URL**: `ws://localhost:8000/`
- **Protocol**: Nostr WebSocket protocol
- **Purpose**: Real-time event streaming and client communication

### Relay Information (NIP-11)

- **URL**: `GET /`
- **Headers**: `Accept: application/nostr+json`
- **Response**: JSON object with relay capabilities and metadata
- **Purpose**: Inform clients about relay features, limitations, and policies

Example:

```bash
curl -H "Accept: application/nostr+json" http://localhost:8000/
```

Response includes:

- Relay name, description, and contact info
- Supported NIPs
- Server limitations (max message size, subscriptions, etc.)
- Event retention policies
- Whether writes are restricted (allowlist/banlist active)

### Management API (NIP-86)

- **URL**: `POST /`
- **Headers**:
  - `Content-Type: application/nostr+json+rpc`
  - `Authorization: Nostr <base64-encoded-auth-event>`
- **Purpose**: Remote relay administration (ban/allow pubkeys, events, kinds,
  etc.)
- **Auth**: Requires NIP-98 authentication with admin pubkey

See [Admin Guide](./docs/ADMIN_GUIDE.md) for details.

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
- **Bulk Inserts**: 1000 events per batch using OpenSearch bulk API
- **Query Response**: Sub-100ms for most queries with proper indexing
- **Full-Text Search**: Native relevance scoring with fuzzy matching
- **Concurrent Connections**: 10,000+ simultaneous WebSocket connections

### Resource Efficiency

- **Memory Usage**: ~50MB per worker process
- **CPU Utilization**: Distributed across relay workers for parallel validation
- **Database Connections**: Pooled connections per storage worker
- **Queue Latency**: < 1ms for message queueing, ~10ms for response delivery
- **Index Refresh**: 5-second refresh interval balances write performance with
  search freshness

### Scalability

- **Parallel Validation**: N relay workers process events concurrently
- **Horizontal Scaling**: Multiple server instances + workers behind load
  balancer
- **Database Scaling**: OpenSearch cluster support for high availability and
  sharding
- **Storage**: Time-based sharding available for efficient data management
- **Tag Indexing**: All tags fully indexed for O(log n) lookups

## NIP-09 Event Deletion

This relay implements NIP-09 event deletion requests (kind 5 events). Deletion
is handled automatically and transparently:

### How It Works

1. **Automatic Processing**: When a kind 5 deletion event is inserted, the relay
   automatically deletes referenced events before storing the deletion event
2. **Event References (`e` tags)**: Deletes all referenced events that have the
   same pubkey as the deletion request
3. **Addressable References (`a` tags)**: Deletes all versions of the
   addressable event up to the deletion request's `created_at` timestamp
4. **Pubkey Verification**: Only events with matching pubkeys are deleted
   (authors can only delete their own events)
5. **Deletion Events Preserved**: The deletion events themselves are stored and
   broadcast indefinitely
6. **Re-insertion Prevention**: Deleted events cannot be re-inserted - the relay
   checks for deletion events before accepting any event

### Example Deletion Event

```json
{
  "kind": 5,
  "pubkey": "<author-pubkey>",
  "tags": [
    ["e", "<event-id-to-delete>"],
    ["e", "<another-event-id>"],
    ["a", "30023:<author-pubkey>:my-article"],
    ["k", "1"],
    ["k", "30023"]
  ],
  "content": "these posts were published by accident"
}
```

### API Methods

**Automatic Deletion (Recommended)**:

- Simply insert a kind 5 event using `event()` or `eventBatch()`
- Deletions are processed automatically

**Manual Deletion**:

- Use `remove(filters)` to delete events matching specific filters
- Useful for administrative cleanup or custom deletion logic

### Important Notes

- Deletion is not guaranteed across all relays - this is a best-effort mechanism
- Clients may have already received and stored the deleted events
- Deleted events are prevented from being re-inserted
- The relay continues to broadcast deletion events to help propagate deletions

## NIP-86 Relay Management API

This relay implements NIP-86 for remote relay management via an authenticated
HTTP API. Administrators can ban/allow pubkeys, events, kinds, and IPs, as well
as configure relay metadata.

### Configuration

Set admin pubkeys in your `.env` file:

```bash
# Comma-separated list of admin pubkeys (hex format)
ADMIN_PUBKEYS=pubkey1,pubkey2,pubkey3

# Optional: Set relay URL for NIP-98 authentication
# Useful when behind a reverse proxy or load balancer
RELAY_URL=https://relay.example.com/

# Optional: Set initial relay metadata
RELAY_NAME=My Nostr Relay
RELAY_DESCRIPTION=A high-performance relay
RELAY_ICON=https://example.com/icon.png
```

**Note about RELAY_URL**: When your relay is behind a reverse proxy or load
balancer, the internal request URL (e.g., `http://localhost:8000/`) will differ
from the public URL (e.g., `https://relay.example.com/`). Set `RELAY_URL` to the
public URL so that NIP-98 auth events can use the correct URL in their `u` tag.

### Authentication

All management API requests require NIP-98 HTTP authentication:

1. Create a kind 27235 event with:
   - `u` tag: Full relay URL (use the configured `RELAY_URL` if set, e.g.,
     `https://relay.example.com/`)
   - `method` tag: `POST`
   - `payload` tag: SHA256 hash of request body (hex)
2. Base64 encode the event
3. Send in `Authorization: Nostr <base64-event>` header
4. Your pubkey must be in the `ADMIN_PUBKEYS` list

### Supported Methods

**Pubkey Management:**

- `banpubkey` - Ban a pubkey from publishing events
- `listbannedpubkeys` - List all banned pubkeys
- `allowpubkey` - Add pubkey to allowlist (optional feature)
- `listallowedpubkeys` - List allowlisted pubkeys

**Event Management:**

- `banevent` - Ban a specific event by ID
- `allowevent` - Remove event from ban list
- `listbannedevents` - List all banned events

**Kind Filtering:**

- `allowkind` - Add kind to allowlist
- `disallowkind` - Remove kind from allowlist
- `listallowedkinds` - List allowed kinds

**IP Blocking:**

- `blockip` - Block an IP address
- `unblockip` - Remove IP from blocklist
- `listblockedips` - List blocked IPs

**Relay Metadata:**

- `changerelayname` - Update relay name
- `changerelaydescription` - Update relay description
- `changerelayicon` - Update relay icon URL

**Discovery:**

- `supportedmethods` - List all supported methods

### Example Usage

Using `curl` and `nostr-tools`:

```javascript
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { createHash } from "crypto";

const sk = generateSecretKey();
const body = JSON.stringify({
  method: "banpubkey",
  params: ["<pubkey-to-ban>", "spam"],
});

const authEvent = finalizeEvent({
  kind: 27235,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["u", "http://localhost:8000/"],
    ["method", "POST"],
    ["payload", createHash("sha256").update(body).digest("hex")],
  ],
  content: "",
}, sk);

const response = await fetch("http://localhost:8000/", {
  method: "POST",
  headers: {
    "Content-Type": "application/nostr+json+rpc",
    "Authorization": `Nostr ${btoa(JSON.stringify(authEvent))}`,
  },
  body,
});

const result = await response.json();
console.log(result); // { result: true }
```

### How Filtering Works

**Banlists (Blocklists):**

- Events from banned pubkeys are rejected
- Banned events cannot be inserted
- Banned IPs cannot connect (future feature)

**Allowlists (Whitelists):**

- If allowlist is **empty**, all pubkeys/kinds are allowed
- If allowlist has entries, **only** those pubkeys/kinds are allowed
- Useful for private/invite-only relays

**Filter Priority:**

1. Check banned pubkeys → reject if banned
2. Check allowlist → reject if not in allowlist (when allowlist is configured)
3. Check banned events → reject if banned
4. Check allowed kinds → reject if not in allowlist (when allowlist is
   configured)

### Security Notes

- Only pubkeys in `ADMIN_PUBKEYS` can access the management API
- All requests must have valid NIP-98 authentication
- Auth events must be within 60 seconds of current time
- Payload hash is verified for POST requests
- All management operations are logged with admin pubkey

## NIP-50 Search Extensions

This relay implements advanced NIP-50 search extensions for discovering trending
and popular content.

**Supported sort modes:**

- `sort:hot` - Recent events with high engagement (recency + popularity)
- `sort:top` - Most referenced events (all-time or within time range)
- `sort:controversial` - Events with mixed positive/negative reactions
- `sort:rising` - Recently created events gaining engagement quickly

**Example queries:**

```json
// Find the hottest bitcoin discussions
{"kinds": [1], "search": "sort:hot bitcoin", "limit": 50}

// Top events from the last 24 hours
{"kinds": [1], "since": 1700000000, "search": "sort:top", "limit": 100}

// Rising vegan content
{"kinds": [1], "search": "sort:rising vegan", "limit": 50}
```

## Documentation

- **[PubSub System](./docs/PUBSUB.md)** - Real-time subscription system with
  inverted indexes for NIP-01
- **[NIP-86 & NIP-11 Implementation](./NIP86_IMPLEMENTATION.md)** - Technical
  details of the NIP-86 and NIP-11 implementations
- **[Admin Guide](./docs/ADMIN_GUIDE.md)** - How to manage your relay using the
  NIP-86 API
- **[NIP-86 Example Client](./examples/nip86-client.ts)** - Working example of a
  NIP-86 management client
- **[NIP-11 Query Script](./examples/nip11-query.sh)** - Simple script to query
  relay information

## Development

### Project Structure

```
lib/
├── config.ts         # Environment configuration
├── metrics.ts        # Prometheus metrics collection
├── opensearch.ts     # OpenSearch relay implementation with NIP-50 and NIP-09 support
├── opensearch.test.ts # Tests for OpenSearch relay
├── pubsub.ts         # PubSub system with inverted indexes for NIP-01 subscriptions
├── pubsub.test.ts    # Tests for PubSub system
├── management.ts     # NIP-86 relay management
├── auth.ts           # NIP-98 authentication
└── relay-info.ts     # NIP-11 relay information

docs/
├── PUBSUB.md         # PubSub system documentation
└── ADMIN_GUIDE.md    # NIP-86 admin guide

scripts/
├── migrate.ts        # Database migration script
└── start.ts          # Process manager to run all components

services/
├── server.ts         # HTTP server and WebSocket handling
├── relay-worker.ts   # Relay worker for parallel message processing & validation
├── storage-worker.ts # Storage worker for batch OpenSearch inserts
└── management-worker.ts # Management worker for NIP-86 operations
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
- **Backups**: Regular OpenSearch snapshots for disaster recovery
- **Index Management**: Configure index lifecycle policies for data retention
- **Security**: Enable OpenSearch security features and authentication in
  production

## License

This project is licensed under the AGPLv3 License. See the LICENSE file for
details.

## Support

For issues, questions, or contributions, please open an issue on the GitHub
repository or contact the maintainers.
