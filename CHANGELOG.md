# Changelog

## [Unreleased] - 2025-10-27

### Added
- **Redis Pub/Sub Integration**: Implemented real-time event distribution using Redis pub/sub
- **NIP-01 Real-time Subscriptions**: Full support for live event streaming to subscribed clients
- **Per-Connection Redis Subscribers**: Each WebSocket connection maintains its own Redis subscriber for isolated event filtering
- **Event Matching Logic**: Client-side filter matching for efficient real-time event delivery
- **Redis Configuration**: Added `REDIS_URL` environment variable for Redis connection
- **Enhanced Health Check**: Health endpoint now checks both ClickHouse and Redis connectivity
- **Docker Compose Example**: Complete deployment example with ClickHouse and Redis services

### Changed
- **Removed In-Memory Subscriptions**: Eliminated problematic in-memory subscription storage
- **Stateless Architecture**: Relay no longer maintains subscription state, enabling horizontal scaling
- **Subscription Handling**: Simplified `handleReq` to only handle historical queries and EOSE
- **Connection Cleanup**: Improved WebSocket connection cleanup with proper Redis subscriber disposal

### Removed
- **Subscription Maps**: Removed `subscriptions` and `connectionSubs` in-memory maps from relay class
- **Connection ID Tracking**: Removed `connId` parameter from relay methods (now handled per-socket)

### Technical Details

#### Event Flow
1. Client sends `EVENT` → Relay validates and stores in ClickHouse
2. Relay publishes event to Redis channel `nostr:events`
3. All connected subscribers receive the event
4. Each connection filters events based on active subscription filters
5. Matching events are sent to the client via WebSocket

#### Subscription Flow
1. Client sends `REQ` with filters
2. Relay queries historical events from ClickHouse
3. Historical events are sent to client
4. `EOSE` is sent to signal end of stored events
5. New matching events arrive via Redis pub/sub in real-time

#### Scaling Benefits
- Multiple relay instances can share the same Redis and ClickHouse
- No coordination needed between relay instances
- Redis handles event distribution across all subscribers
- Each relay instance independently filters events for its connections

### Migration Notes

**Redis Required**: This version requires a Redis server. Update your `.env` file:
```bash
REDIS_URL=redis://localhost:6379
```

**No Breaking Changes**: The Nostr protocol interface remains unchanged. Clients will see improved real-time performance.

### Performance Impact
- **Improved**: Real-time event delivery latency (sub-millisecond via Redis)
- **Improved**: Memory usage (no in-memory subscription state)
- **Improved**: Horizontal scalability (stateless relay instances)
- **New Dependency**: Redis server required for operation
