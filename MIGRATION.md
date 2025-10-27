# Migration Guide: In-Memory to Redis Pub/Sub

This guide helps you migrate from the old in-memory subscription system to the new Redis pub/sub based real-time subscriptions.

## What Changed?

### Before (In-Memory Subscriptions)
- ❌ Subscriptions stored in memory (`Map<string, Subscription>`)
- ❌ Did not work - events were not delivered in real-time
- ❌ Could not scale horizontally
- ❌ Lost subscriptions on relay restart

### After (Redis Pub/Sub)
- ✅ Subscriptions managed per WebSocket connection
- ✅ Real-time event delivery via Redis pub/sub
- ✅ Horizontal scaling support
- ✅ Stateless relay instances

## Prerequisites

### New Dependency: Redis

You must have Redis running before starting the relay.

**Option 1: Docker**
```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
```

**Option 2: Local Installation**
```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis

# Arch Linux
sudo pacman -S redis
sudo systemctl start redis
```

**Option 3: Docker Compose**
```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
volumes:
  redis_data:
```

## Step-by-Step Migration

### Step 1: Update Dependencies

The `deno.json` file has been updated automatically. If you're pulling changes:

```bash
git pull
# Dependencies will be downloaded on next run
```

### Step 2: Update Environment Configuration

Add Redis URL to your `.env` file:

```bash
# Add this line
REDIS_URL=redis://localhost:6379
```

If using a remote Redis server:
```bash
# With password
REDIS_URL=redis://:your-password@redis.example.com:6379

# With username and password
REDIS_URL=redis://username:password@redis.example.com:6379

# With database selection
REDIS_URL=redis://localhost:6379/0
```

### Step 3: Start Redis

Make sure Redis is running and accessible:

```bash
# Test Redis connection
redis-cli ping
# Expected output: PONG
```

### Step 4: Restart the Relay

```bash
# Development mode
deno task dev

# Production mode
deno task start
```

### Step 5: Verify Operation

Check the health endpoint:
```bash
curl http://localhost:8000/health
```

Expected response:
```json
{
  "status": "ok",
  "clickhouse": "connected",
  "redis": "connected"
}
```

If Redis is not connected, you'll see:
```json
{
  "status": "error",
  "error": "Connection refused"
}
```

### Step 6: Test Real-Time Subscriptions

See [TESTING.md](./TESTING.md) for comprehensive testing instructions.

Quick test:
```bash
# Terminal 1 - Subscribe
echo '["REQ","test",{"kinds":[1]}]' | websocat ws://localhost:8000

# Terminal 2 - Publish (use a real signed event)
echo '["EVENT",{...}]' | websocat ws://localhost:8000

# Terminal 1 should receive the event in real-time!
```

## Configuration Changes

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8000` | HTTP server port |
| `DATABASE_URL` | Yes | - | ClickHouse connection URL |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection URL |

### Example Configurations

**Development (local services):**
```bash
PORT=8000
DATABASE_URL=http://localhost:8123/nostr
REDIS_URL=redis://localhost:6379
```

**Production (managed services):**
```bash
PORT=8000
DATABASE_URL=http://clickhouse.internal:8123/nostr
REDIS_URL=redis://:secure-password@redis.internal:6379/0
```

**Docker Compose:**
```bash
PORT=8000
DATABASE_URL=http://clickhouse:8123/nostr
REDIS_URL=redis://redis:6379
```

## Breaking Changes

### None for Clients

The Nostr protocol interface remains unchanged. Clients don't need any updates.

### For Relay Operators

1. **Redis is now required** - The relay will not start without Redis
2. **Health check response changed** - Now includes Redis status
3. **Metrics remain the same** - All Prometheus metrics are unchanged

## Rollback Plan

If you need to rollback to the previous version:

```bash
# Checkout previous commit
git checkout <previous-commit-hash>

# Restart relay (Redis not needed)
deno task start
```

Note: The previous version had non-functional subscriptions, so rolling back is not recommended.

## Troubleshooting

### Relay won't start

**Error:** `Connection refused` or `ECONNREFUSED`

**Solution:** Make sure Redis is running:
```bash
redis-cli ping
# Should return: PONG
```

Start Redis if needed:
```bash
docker start redis
# or
brew services start redis
# or
sudo systemctl start redis
```

### Events not delivered in real-time

**Check 1:** Verify Redis connection
```bash
curl http://localhost:8000/health
```

**Check 2:** Monitor Redis pub/sub
```bash
redis-cli PUBSUB NUMSUB nostr:events
# Should show number of subscribers
```

**Check 3:** Enable debug logging
```bash
DEBUG=1 deno task dev
```

### High Redis connection count

**Expected behavior:** One Redis connection per WebSocket connection plus one publisher.

If you have 100 active WebSocket connections:
- 100 Redis subscriber connections
- 1 Redis publisher connection
- Total: 101 Redis connections

This is normal and expected.

**To limit:** Reduce max WebSocket connections or use connection pooling (future optimization).

### Memory usage increased

**Check:** Monitor active connections
```bash
curl http://localhost:8000/metrics | grep nostr_connections_active
```

Each connection maintains:
- WebSocket connection
- Redis subscriber connection
- Subscription filters map

**Solution:** Set connection limits at reverse proxy level (Nginx, Caddy, etc.)

### Redis memory usage

**Normal:** Redis pub/sub uses minimal memory (messages are not stored)

**Check Redis memory:**
```bash
redis-cli INFO memory
```

**If high:** Check for stuck subscribers
```bash
redis-cli CLIENT LIST
```

## Performance Considerations

### Before Migration
- Events were stored but not delivered in real-time
- Subscriptions existed but didn't work
- No horizontal scaling

### After Migration
- Real-time event delivery with sub-millisecond latency
- Each WebSocket connection needs one Redis connection
- Horizontal scaling supported
- Slightly higher memory usage per connection

### Scaling Recommendations

**Small deployments (< 100 concurrent users):**
- Single relay instance
- Local Redis
- Local ClickHouse

**Medium deployments (100-1000 concurrent users):**
- 2-3 relay instances behind load balancer
- Managed Redis (e.g., AWS ElastiCache)
- ClickHouse cluster

**Large deployments (> 1000 concurrent users):**
- Multiple relay instances (auto-scaling)
- Redis Cluster
- ClickHouse cluster with replication
- CDN for static endpoints

## Monitoring After Migration

### Key Metrics to Watch

```bash
# Active connections (should match Redis subscribers)
nostr_connections_active

# Active subscriptions (should be <= connections * 20)
nostr_subscriptions_active

# Events being stored and published
nostr_events_stored

# Query performance
nostr_queries_total
```

### Redis Metrics

```bash
# Subscribers to events channel
redis-cli PUBSUB NUMSUB nostr:events

# Total client connections
redis-cli CLIENT LIST | wc -l

# Memory usage
redis-cli INFO memory | grep used_memory_human
```

### Health Checks

Update your monitoring to check the new health endpoint:

```bash
# Before: Only checked HTTP 200
curl -f http://localhost:8000/health

# After: Check JSON response
curl http://localhost:8000/health | jq -e '.redis == "connected"'
```

## Getting Help

If you encounter issues:

1. Check [TESTING.md](./TESTING.md) for testing procedures
2. Check [REDIS_PUBSUB.md](./REDIS_PUBSUB.md) for architecture details
3. Enable debug logging: `DEBUG=1 deno task dev`
4. Check Redis: `redis-cli MONITOR`
5. Check ClickHouse: `docker logs clickhouse`
6. Open an issue with logs and configuration

## FAQ

**Q: Do I need to migrate my data?**
A: No, ClickHouse data remains unchanged. Only the real-time delivery mechanism changed.

**Q: Can I use Redis Cluster?**
A: Yes, Redis Cluster is supported. Use the cluster URL in `REDIS_URL`.

**Q: What if Redis goes down?**
A: Events will still be stored in ClickHouse, but real-time delivery will stop. Historical queries will continue to work.

**Q: Can I use Redis with authentication?**
A: Yes, include credentials in the URL: `redis://:password@host:6379`

**Q: Does this support Redis Sentinel?**
A: Not currently. This is a potential future enhancement.

**Q: How much Redis memory do I need?**
A: Minimal. Pub/sub doesn't store messages. 256MB is sufficient for most deployments.

**Q: Can I share Redis with other applications?**
A: Yes, but use a dedicated database: `redis://localhost:6379/1`
