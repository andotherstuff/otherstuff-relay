# Testing Real-Time Subscriptions

This guide shows how to test the Redis pub/sub based real-time subscriptions.

## Prerequisites

Start the required services:

```bash
# Start ClickHouse
docker run -d --name clickhouse -p 8123:8123 -p 9000:9000 clickhouse/clickhouse-server

# Start Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Or use docker-compose (create docker-compose.yml from README)
docker-compose up -d
```

## Testing with WebSocket Clients

### Using `websocat`

Install websocat:
```bash
# macOS
brew install websocat

# Linux
cargo install websocat

# Or download binary from https://github.com/vi/websocat/releases
```

#### Test 1: Subscribe and Receive Real-Time Events

Terminal 1 - Start subscriber:
```bash
websocat ws://localhost:8000
```

Send REQ command:
```json
["REQ","sub1",{"kinds":[1],"limit":10}]
```

You should receive:
1. Historical events (if any exist)
2. `["EOSE","sub1"]` message
3. Any new kind:1 events in real-time

Terminal 2 - Publish an event:
```bash
websocat ws://localhost:8000
```

Send EVENT command (you'll need a properly signed event):
```json
["EVENT",{"id":"...","pubkey":"...","created_at":1234567890,"kind":1,"tags":[],"content":"Hello, world!","sig":"..."}]
```

Terminal 1 should immediately receive the event!

### Using `nak` (Nostr Army Knife)

Install nak:
```bash
go install github.com/fiatjaf/nak@latest
```

#### Test 2: Multi-Client Real-Time Delivery

Terminal 1 - Subscribe to kind 1 events:
```bash
nak req -k 1 ws://localhost:8000
```

Terminal 2 - Subscribe to kind 1 events (different client):
```bash
nak req -k 1 ws://localhost:8000
```

Terminal 3 - Publish an event:
```bash
echo "Test message" | nak event -k 1 ws://localhost:8000
```

Both Terminal 1 and Terminal 2 should receive the event simultaneously!

#### Test 3: Filter-Based Subscriptions

Subscribe to specific author:
```bash
nak req -a <pubkey> ws://localhost:8000
```

Subscribe to specific kinds:
```bash
nak req -k 1 -k 7 ws://localhost:8000
```

Subscribe with time filters:
```bash
# Events since timestamp
nak req -k 1 --since $(date -u +%s) ws://localhost:8000
```

## Testing with Redis CLI

Monitor events being published:

```bash
# Subscribe to the events channel
redis-cli SUBSCRIBE nostr:events

# In another terminal, publish a test event
redis-cli PUBLISH nostr:events '{"id":"test","pubkey":"test","created_at":1234567890,"kind":1,"tags":[],"content":"test","sig":"test"}'
```

Check pub/sub statistics:
```bash
# Number of subscribers to nostr:events channel
redis-cli PUBSUB NUMSUB nostr:events

# Active channels
redis-cli PUBSUB CHANNELS

# Number of patterns
redis-cli PUBSUB NUMPAT
```

## Testing Subscription Limits

Test max subscriptions per connection (limit: 20):

```bash
websocat ws://localhost:8000
```

Send 21 REQ commands:
```json
["REQ","sub1",{"kinds":[1]}]
["REQ","sub2",{"kinds":[2]}]
...
["REQ","sub21",{"kinds":[21]}]
```

The 21st subscription should be rejected with:
```json
["CLOSED","sub21","error: too many subscriptions"]
```

## Testing Connection Cleanup

1. Connect with websocat:
```bash
websocat ws://localhost:8000
```

2. Create subscriptions:
```json
["REQ","sub1",{"kinds":[1]}]
["REQ","sub2",{"kinds":[2]}]
```

3. Check metrics:
```bash
curl http://localhost:8000/metrics | grep nostr_subscriptions_active
# Should show: nostr_subscriptions_active 2

curl http://localhost:8000/metrics | grep nostr_connections_active
# Should show: nostr_connections_active 1
```

4. Disconnect (Ctrl+C in websocat)

5. Check metrics again:
```bash
curl http://localhost:8000/metrics | grep nostr_subscriptions_active
# Should show: nostr_subscriptions_active 0

curl http://localhost:8000/metrics | grep nostr_connections_active
# Should show: nostr_connections_active 0
```

6. Check Redis:
```bash
redis-cli PUBSUB NUMSUB nostr:events
# Should show 0 subscribers
```

## Testing Filter Matching

### Test Exact Kind Match

Subscribe to kind 1:
```json
["REQ","sub1",{"kinds":[1]}]
```

Publish kind 1 event → Should receive ✅
Publish kind 2 event → Should NOT receive ❌

### Test Author Filter

Subscribe to specific author:
```json
["REQ","sub1",{"authors":["abc123..."]}]
```

Publish event from that author → Should receive ✅
Publish event from different author → Should NOT receive ❌

### Test Tag Filter

Subscribe to events tagged with specific event ID:
```json
["REQ","sub1",{"#e":["event-id-here"]}]
```

Publish event with `["e","event-id-here"]` tag → Should receive ✅
Publish event without that tag → Should NOT receive ❌

### Test Time Range

Subscribe to future events only:
```json
["REQ","sub1",{"since":1234567890,"kinds":[1]}]
```

Publish event with `created_at > 1234567890` → Should receive ✅
Publish event with `created_at < 1234567890` → Should NOT receive ❌

### Test Multiple Filters (OR logic)

Subscribe with multiple filters:
```json
["REQ","sub1",{"kinds":[1]},{"kinds":[2]}]
```

Publish kind 1 event → Should receive ✅
Publish kind 2 event → Should receive ✅
Publish kind 3 event → Should NOT receive ❌

## Performance Testing

### Test Event Throughput

Use `nak` to publish many events:
```bash
# Publish 1000 events
for i in {1..1000}; do
  echo "Message $i" | nak event -k 1 ws://localhost:8000
done
```

Monitor metrics:
```bash
watch -n 1 'curl -s http://localhost:8000/metrics | grep nostr_events'
```

### Test Concurrent Subscribers

Open 10 terminals and run in each:
```bash
nak req -k 1 ws://localhost:8000
```

Publish an event from another terminal:
```bash
echo "Broadcast test" | nak event -k 1 ws://localhost:8000
```

All 10 subscribers should receive the event simultaneously!

### Test Latency

Terminal 1 - Subscribe with timestamp:
```bash
websocat ws://localhost:8000 | while read line; do
  echo "$(date +%s.%N): $line"
done
```

Send REQ:
```json
["REQ","sub1",{"kinds":[1]}]
```

Terminal 2 - Publish with timestamp:
```bash
echo "$(date +%s.%N): Publishing"
echo '["EVENT",{...event...}]' | websocat ws://localhost:8000
```

Compare timestamps to measure end-to-end latency.

## Health Check Testing

```bash
# Check overall health
curl http://localhost:8000/health

# Expected response:
{
  "status": "ok",
  "clickhouse": "connected",
  "redis": "connected"
}
```

Test with Redis down:
```bash
docker stop redis
curl http://localhost:8000/health
# Should show error status
```

Test with ClickHouse down:
```bash
docker stop clickhouse
curl http://localhost:8000/health
# Should show error status
```

## Debugging

Enable debug mode:
```bash
DEBUG=1 deno task dev
```

Watch Redis traffic:
```bash
redis-cli MONITOR
```

Watch ClickHouse queries:
```bash
docker exec -it clickhouse clickhouse-client
SELECT * FROM system.query_log ORDER BY event_time DESC LIMIT 10;
```

## Common Test Scenarios

### Scenario 1: Late Subscriber
1. Publish 10 events
2. Create subscription
3. Should receive all 10 historical events + EOSE
4. Publish new event
5. Should receive new event in real-time

### Scenario 2: Multiple Subscriptions Per Connection
1. Connect once
2. Create 5 different subscriptions with different filters
3. Publish events matching different filters
4. Each event should be delivered to matching subscriptions only

### Scenario 3: Subscription Replacement
1. Create subscription with ID "sub1"
2. Receive events
3. Send new REQ with same ID "sub1" but different filters
4. Old subscription should be replaced
5. Events should match new filters

### Scenario 4: Horizontal Scaling
1. Start two relay instances (different ports)
2. Subscribe to kind 1 on relay 1
3. Publish event to relay 2
4. Subscriber on relay 1 should receive the event (via Redis)

## Automated Testing

Create a test script:

```bash
#!/bin/bash
# test-realtime.sh

echo "Testing real-time subscriptions..."

# Start subscriber in background
(echo '["REQ","test",{"kinds":[1]}]'; sleep 30) | websocat ws://localhost:8000 > /tmp/subscriber.log &
SUBSCRIBER_PID=$!

# Wait for subscription to be established
sleep 2

# Publish test event
echo '["EVENT",{...}]' | websocat ws://localhost:8000

# Wait for delivery
sleep 1

# Check if event was received
if grep -q "EVENT" /tmp/subscriber.log; then
  echo "✅ Real-time delivery working!"
else
  echo "❌ Real-time delivery failed!"
fi

# Cleanup
kill $SUBSCRIBER_PID
rm /tmp/subscriber.log
```

Run tests:
```bash
chmod +x test-realtime.sh
./test-realtime.sh
```
