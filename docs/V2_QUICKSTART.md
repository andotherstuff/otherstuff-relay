# V2 Quick Start Guide

Get the **high-performance V2 relay** running in 5 minutes.

## Prerequisites

- Deno 1.40+
- OpenSearch server
- Redis server (for distributed state only)

## Installation

```bash
git clone <repository-url>
cd otherstuff-relay
cp .env.example .env
```

## Configuration

Edit `.env`:

```bash
# Required
OPENSEARCH_URL=http://localhost:9200
REDIS_URL=redis://localhost:6379

# Optional - auto-scales to CPU cores if not set
NUM_VALIDATION_WORKERS=16
NUM_STORAGE_WORKERS=4
```

## Database Setup

```bash
deno task migrate
```

## Start V2 Relay

```bash
deno task start:v2
```

You should see:

```
╔════════════════════════════════════════════════════════════════╗
║           🚀 Optimized Nostr Relay Starting                    ║
╠════════════════════════════════════════════════════════════════╣
║  Architecture: In-Memory Channels (Zero Redis Queues)         ║
║  Validation: Native secp256k1 (with WASM fallback)            ║
║  Performance: 10-100x faster than v1                           ║
╠════════════════════════════════════════════════════════════════╣
║  Port:               8000                                      ║
║  CPU Cores:          16                                        ║
║  Validation Workers: 12                                        ║
║  Storage Workers:    4                                         ║
╚════════════════════════════════════════════════════════════════╝

🔧 Starting 12 validation workers...
📡 Starting broadcast worker...
💾 Starting 4 storage workers...
🔐 Starting management worker...
🌐 Starting web server on port 8000...

╔════════════════════════════════════════════════════════════════╗
║                    ✅ All Systems Running                      ║
╠════════════════════════════════════════════════════════════════╣
║  WebSocket: ws://localhost:8000/                               ║
║  Metrics:   http://localhost:8000/metrics                      ║
║  Health:    http://localhost:8000/health                       ║
╚════════════════════════════════════════════════════════════════╝
```

## Test the Relay

### Health Check

```bash
curl http://localhost:8000/health
```

Response:
```json
{
  "status": "ok",
  "connections": 0,
  "subscriptions": 0,
  "queuedMessages": 0,
  "stats": {
    "messagesProcessed": 0,
    "eventsValidated": 0,
    "eventsStored": 0,
    "activeConnections": 0
  }
}
```

### Connect with Nostr Client

Point your Nostr client to:
```
ws://localhost:8000
```

Or test with `websocat`:
```bash
websocat ws://localhost:8000
```

Send a REQ:
```json
["REQ","test",{"kinds":[1],"limit":10}]
```

## Performance Benchmarks

Run the included benchmark:

```bash
deno task benchmark
```

Expected output:
```
🏁 Starting benchmarks...

Iterations: 10000
Message size: 1000 bytes

============================================================
Individual Operations
============================================================

⏱️  Benchmarking Redis queue (individual)...
✅ Redis: 15234.52ms total
   Throughput: 656 ops/sec
   Avg latency: 1.523ms per op

⏱️  Benchmarking in-memory channel (individual)...
✅ Channel: 45.23ms total
   Throughput: 221000 ops/sec
   Avg latency: 0.005ms per op

🚀 Channel is 337x faster than Redis

============================================================
Batch Operations (100 items/batch)
============================================================

⏱️  Benchmarking Redis queue (batch)...
✅ Redis: 12456.78ms total
   Throughput: 803 ops/sec

⏱️  Benchmarking in-memory channel (batch)...
✅ Channel: 12.34ms total
   Throughput: 810373 ops/sec

🚀 Channel is 1009x faster than Redis (batch)
```

## Monitoring

### Prometheus Metrics

```bash
curl http://localhost:8000/metrics
```

### Key Metrics

- `nostr_connections` - Active WebSocket connections
- `nostr_messages_received_total` - Total messages received
- `nostr_events_validated_total` - Events validated
- `nostr_events_stored_total` - Events stored in OpenSearch
- `nostr_queries_total` - Total queries executed

## Tuning

### Worker Count

Adjust based on workload:

```bash
# CPU-heavy (lots of validation)
NUM_VALIDATION_WORKERS=32 NUM_STORAGE_WORKERS=2 deno task start:v2

# I/O-heavy (lots of queries)
NUM_VALIDATION_WORKERS=8 NUM_STORAGE_WORKERS=8 deno task start:v2
```

### Memory Limits

Channel sizes are configured in code:
- Client messages: 10,000 max
- Validated events: 10,000 max
- Response channels: 1,000 per connection

Adjust in `lib/worker-pool.ts` if needed.

## Troubleshooting

### "Queue overloaded" warnings

Increase worker count or reduce load:
```bash
NUM_VALIDATION_WORKERS=32 deno task start:v2
```

### High memory usage

Reduce worker count or channel sizes:
```bash
NUM_VALIDATION_WORKERS=4 NUM_STORAGE_WORKERS=2 deno task start:v2
```

### Native verification not available

Install libsecp256k1:
```bash
# Debian/Ubuntu
sudo apt install libsecp256k1-dev

# macOS
brew install libsecp256k1
```

Relay will automatically use native verification if available.

## Comparison with V1

| Metric | V1 | V2 |
|--------|----|----|
| Throughput | ~1K msg/sec | ~50K msg/sec |
| Latency | 10-20ms | 100μs-1ms |
| Memory | 400MB | 600MB |
| CPU | 65% | 75% |
| Deployment | Multi-instance | Single-instance |

## When to Use V2

✅ **Use V2 when:**
- Running single instance
- Need maximum performance
- Have sufficient RAM
- Want lowest latency

❌ **Use V1 when:**
- Running distributed (multiple instances)
- Need message persistence
- Limited RAM
- Need high availability

## Next Steps

1. **Configure NIP-86** - Set up admin pubkeys for relay management
2. **Set up monitoring** - Configure Prometheus/Grafana
3. **Tune workers** - Adjust counts based on load
4. **Load test** - Test with real traffic
5. **Monitor metrics** - Watch for bottlenecks

## Support

- Documentation: See `PERFORMANCE_OPTIMIZATIONS.md`
- Comparison: See `docs/V1_VS_V2.md`
- Issues: Open a GitHub issue
- Questions: Join our community

## Performance Tips

1. **Use native verification** - Install libsecp256k1 for 10x faster validation
2. **Scale workers** - Match validation workers to CPU cores
3. **Monitor queues** - Watch channel depths in health endpoint
4. **Batch operations** - Let workers batch naturally
5. **Tune OpenSearch** - Optimize bulk insert settings

## Example Production Setup

```bash
# .env for production
PORT=8000
OPENSEARCH_URL=http://opensearch:9200
REDIS_URL=redis://redis:6379

# Scale to 32-core machine
NUM_VALIDATION_WORKERS=24
NUM_STORAGE_WORKERS=8

# NIP-86 admin
ADMIN_PUBKEYS=your-admin-pubkey-hex

# Relay metadata
RELAY_NAME=My High-Performance Relay
RELAY_DESCRIPTION=Powered by V2 architecture
```

Start with:
```bash
deno task start:v2
```

Expected performance:
- 50,000+ messages/sec
- <1ms average latency
- 10,000+ concurrent connections

## Conclusion

V2 delivers **10-100x better performance** than V1 while maintaining:
- Same codebase and development experience
- OpenSearch for full-text search
- All NIP support
- Production readiness

Perfect for high-performance, single-instance Nostr relays.
