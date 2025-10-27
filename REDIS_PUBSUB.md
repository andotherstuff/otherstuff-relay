# Redis Pub/Sub Architecture

This document explains how the relay uses Redis pub/sub for real-time NIP-01 subscriptions.

## Overview

The relay uses a **single Redis channel** (`nostr:events`) to publish all events. Each WebSocket connection maintains its own Redis subscriber that filters events based on active subscriptions.

## Architecture Diagram

```
┌─────────────┐
│   Client A  │
└──────┬──────┘
       │ WebSocket
       ▼
┌─────────────────────────────────┐
│  Relay Instance 1               │
│  ┌───────────────────────────┐  │
│  │ WebSocket Handler         │  │
│  │ - Active Subs: [sub1]     │  │
│  │ - Filters: [kind:1]       │  │
│  └───────────┬───────────────┘  │
│              │                   │
│  ┌───────────▼───────────────┐  │
│  │ Redis Subscriber          │  │
│  │ Channel: nostr:events     │  │
│  └───────────┬───────────────┘  │
└──────────────┼───────────────────┘
               │
               │ Redis Pub/Sub
               │
      ┌────────▼─────────┐
      │  Redis Server    │
      │  Channel:        │
      │  nostr:events    │
      └────────▲─────────┘
               │
               │ Publish
               │
┌──────────────┼───────────────────┐
│  Relay Instance 2               │
│  ┌───────────▼───────────────┐  │
│  │ Event Handler             │  │
│  │ 1. Verify event           │  │
│  │ 2. Store in ClickHouse    │  │
│  │ 3. Publish to Redis       │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

## Event Publishing

When a relay receives an event:

```typescript
// 1. Verify and validate
if (!verifyEvent(event)) {
  return [false, "invalid"];
}

// 2. Store in ClickHouse
await clickhouse.insert({ table: "events", values: [event] });

// 3. Publish to Redis (single channel for all events)
await redisPublisher.publish("nostr:events", JSON.stringify(event));
```

## Event Subscription

When a client creates a subscription:

```typescript
// 1. Store filters for this subscription
subscriptions.set(subId, filters);

// 2. Query historical events from ClickHouse
const events = await queryEvents(filters);
for (const event of events) {
  send(["EVENT", subId, event]);
}

// 3. Send EOSE
send(["EOSE", subId]);

// 4. Real-time events arrive via Redis subscriber
// (already listening on nostr:events channel)
```

## Event Filtering

Each Redis subscriber filters events locally:

```typescript
redisSubscriber.subscribe("nostr:events", (message) => {
  const event = JSON.parse(message);
  
  // Check all active subscriptions
  for (const [subId, filters] of subscriptions.entries()) {
    if (matchesFilters(event, filters)) {
      send(["EVENT", subId, event]);
    }
  }
});
```

## Filter Matching Logic

The `matchesFilters` function checks if an event matches subscription filters:

```typescript
static matchesFilters(event: NostrEvent, filters: NostrFilter[]): boolean {
  return filters.some(filter => {
    // Check IDs (prefix match)
    if (filter.ids && !filter.ids.some(id => event.id.startsWith(id))) {
      return false;
    }
    
    // Check authors (prefix match)
    if (filter.authors && !filter.authors.some(author => 
      event.pubkey.startsWith(author)
    )) {
      return false;
    }
    
    // Check kinds (exact match)
    if (filter.kinds && !filter.kinds.includes(event.kind)) {
      return false;
    }
    
    // Check since/until timestamps
    if (filter.since && event.created_at < filter.since) {
      return false;
    }
    if (filter.until && event.created_at > filter.until) {
      return false;
    }
    
    // Check tag filters (#e, #p, etc.)
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith("#")) {
        const tagName = key.substring(1);
        const hasMatch = event.tags.some(tag => 
          tag[0] === tagName && values.includes(tag[1])
        );
        if (!hasMatch) return false;
      }
    }
    
    return true;
  });
}
```

## Connection Lifecycle

### Connection Established
```typescript
socket.onopen = () => {
  // 1. Increment connection gauge
  connectionsGauge.inc();
  
  // 2. Create dedicated Redis subscriber
  redisSubscriber = createRedisClient({ url: config.redisUrl });
  await redisSubscriber.connect();
  
  // 3. Subscribe to events channel
  await redisSubscriber.subscribe("nostr:events", eventHandler);
};
```

### Subscription Created (REQ)
```typescript
case "REQ": {
  // 1. Check subscription limit (max 20 per connection)
  if (subscriptions.size >= 20) {
    send(["CLOSED", subId, "error: too many subscriptions"]);
    break;
  }
  
  // 2. Store filters for real-time matching
  subscriptions.set(subId, filters);
  
  // 3. Query and send historical events + EOSE
  await relay.handleReq(subId, filters, sendEvent, sendEose);
  
  // Real-time events delivered automatically via Redis
}
```

### Subscription Closed (CLOSE)
```typescript
case "CLOSE": {
  // Remove subscription filters
  subscriptions.delete(subId);
  
  // Decrement subscription gauge
  relay.handleClose();
}
```

### Connection Closed
```typescript
socket.onclose = async () => {
  // 1. Decrement connection gauge
  connectionsGauge.dec();
  
  // 2. Clean up all subscriptions
  for (const subId of subscriptions.keys()) {
    relay.handleClose();
  }
  subscriptions.clear();
  
  // 3. Disconnect Redis subscriber
  await redisSubscriber.unsubscribe("nostr:events");
  await redisSubscriber.quit();
};
```

## Scaling Considerations

### Horizontal Scaling
- ✅ Multiple relay instances can run simultaneously
- ✅ Each instance publishes to the same Redis channel
- ✅ Each instance's connections receive events from all publishers
- ✅ No coordination needed between relay instances

### Resource Usage
- **Redis Memory**: Minimal (pub/sub doesn't store messages)
- **Redis Connections**: 1 publisher + N subscribers (N = active WebSocket connections)
- **Network**: Events are sent once to Redis, then distributed to all subscribers

### Performance
- **Latency**: Sub-millisecond event delivery via Redis
- **Throughput**: Redis can handle 100k+ messages/second
- **Filtering**: O(N×M) where N = subscriptions, M = filters per subscription

## Monitoring

Key metrics to monitor:

```
# Active WebSocket connections
nostr_connections_active

# Active subscriptions across all connections
nostr_subscriptions_active

# Events published to Redis
nostr_events_stored (also represents Redis publishes)

# Redis connection health
Check /health endpoint for Redis status
```

## Debugging

Enable debug logging:
```bash
DEBUG=1 deno task start
```

Check Redis pub/sub:
```bash
# Monitor published events
redis-cli MONITOR

# Check active channels
redis-cli PUBSUB CHANNELS

# Check subscribers per channel
redis-cli PUBSUB NUMSUB nostr:events
```

## Common Issues

### Events not delivered in real-time
- Check Redis connection: `curl http://localhost:8000/health`
- Verify Redis subscriber is connected: `redis-cli PUBSUB NUMSUB nostr:events`
- Check filter matching logic with debug logging

### High Redis connection count
- Each WebSocket connection creates one Redis subscriber
- Normal: connections_count = redis_subscribers_count
- Limit concurrent connections if needed

### Memory usage growing
- Check for WebSocket connections not being cleaned up
- Verify Redis subscribers are properly closed on disconnect
- Monitor `nostr_connections_active` metric

## Future Optimizations

Potential improvements:

1. **Channel per Kind**: Publish to `nostr:events:kind:{kind}` for more efficient filtering
2. **Bloom Filters**: Use Redis bloom filters for tag-based subscriptions
3. **Connection Pooling**: Reuse Redis connections across WebSocket connections
4. **Batch Publishing**: Publish multiple events in a single Redis command
