# Bulk Import Guide

## Quick Import for 1TB JSONL File

### 1. Configure Environment

Create or update your `.env` file with these import-specific settings:

```bash
# Basic database config (same as server)
CLICKHOUSE_HOST=localhost
CLICKHOUSE_HTTP_PORT=8123
CLICKHOUSE_DATABASE=nostr
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=

# Import performance tuning
IMPORT_BATCH_SIZE=50000          # Events per batch (adjust based on memory)
PROGRESS_INTERVAL=10             # Progress update frequency (seconds)
```

### 2. Run the Import

```bash
# Basic import
deno task import /path/to/your/events.jsonl

# Or with custom batch size for very large files
IMPORT_BATCH_SIZE=100000 deno task import /path/to/your/events.jsonl
```

### 3. Performance Optimization

For a 1TB file, use these settings:

```bash
# High-performance settings (requires more RAM)
IMPORT_BATCH_SIZE=100000
PROGRESS_INTERVAL=30

# For systems with limited RAM
IMPORT_BATCH_SIZE=25000
PROGRESS_INTERVAL=5
```

### 4. Monitor Progress

The import script provides real-time progress:
- File size and estimated line count
- Processing rate (lines/second, events/second)  
- Progress percentage and ETA
- Batch completion status
- Error tracking

### 5. Post-Import Verification

After import completes, verify the data:

```sql
-- Check total events in ClickHouse
SELECT count(*) FROM events;

-- Verify recent imports
SELECT count(*) FROM events WHERE created_at >= now() - INTERVAL 1 DAY;

-- Check data distribution by kind
SELECT kind, count(*) FROM events GROUP BY kind ORDER BY count(*) DESC;
```

## Alternative Methods

### Method 1: ClickHouse Native Import (Fastest)

If you have direct ClickHouse access:

```bash
# Convert to ClickHouse format and use native import
clickhouse-client --database=nostr --query="INSERT INTO events FORMAT JSONEachRow" < events.jsonl
```

### Method 2: Split and Parallel Import

For extremely large files (>1TB):

```bash
# Split file into chunks
split -l 1000000 events.jsonl chunk_

# Import in parallel (adjust based on CPU cores)
for chunk in chunk_*; do
  deno task import "$chunk" &
done
wait
```

## Performance Tips

1. **Memory**: Allocate sufficient RAM for batch processing
2. **Disk**: Use SSD storage for better I/O performance  
3. **Network**: Place import script on same network as ClickHouse
4. **Batch Size**: Start with 50K, adjust based on memory usage
5. **Monitoring**: Watch ClickHouse system tables during import

## Troubleshooting

### Memory Issues
```bash
# Reduce batch size
IMPORT_BATCH_SIZE=25000 deno task import events.jsonl
```

### Connection Issues
```bash
# Check ClickHouse connectivity
curl http://localhost:8123/ping
```

### Slow Performance
```bash
# Increase batch size if memory allows
IMPORT_BATCH_SIZE=100000 deno task import events.jsonl
```

## Expected Performance

- **50K batch size**: ~10K-50K events/second
- **100K batch size**: ~20K-100K events/second  
- **1TB file**: ~2-8 hours depending on hardware
- **Memory usage**: ~100-500MB depending on batch size