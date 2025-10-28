# Batch Import Guide

This guide explains how to import large JSONL files of Nostr events into the relay.

## Overview

The batch import utility is designed to efficiently import 10GB+ JSONL files containing Nostr events. It features:

- **Streaming processing**: Memory-efficient reading of large files
- **Parallel validation**: Multi-threaded cryptographic signature verification
- **Batch insertion**: Optimized bulk inserts to ClickHouse
- **Duplicate detection**: Optional checking for existing events
- **Progress tracking**: Real-time statistics and progress reports
- **Fault tolerance**: Error handling and recovery

## Quick Start

### Basic Import

Import a JSONL file with default settings:

```bash
deno task import events.jsonl
```

### Fast Import (Skip Validation)

For trusted data sources, skip cryptographic validation:

```bash
deno task import events.jsonl --skip-validation
```

**⚠️ Warning**: Only use `--skip-validation` with trusted data. Invalid events will corrupt your database.

### Safe Import (Check Duplicates)

Check for and skip duplicate events:

```bash
deno task import events.jsonl --skip-duplicates
```

**Note**: This is slower as it queries the database for each batch.

## Command-Line Options

### File Path (Required)

The first argument is the path to the JSONL file:

```bash
deno task import /path/to/events.jsonl
```

### --batch-size <n>

Number of events to batch before inserting into ClickHouse.

- **Default**: 5000
- **Range**: 100 - 50000
- **Recommendation**: 
  - 5000-10000 for balanced performance
  - 20000+ for maximum throughput (requires more memory)

```bash
deno task import events.jsonl --batch-size 10000
```

### --skip-validation

Skip cryptographic signature verification of events.

- **Use case**: Importing from trusted sources
- **Performance gain**: 5-10x faster
- **Risk**: Invalid events will be imported

```bash
deno task import events.jsonl --skip-validation
```

### --skip-duplicates

Check the database for existing events before inserting.

- **Use case**: Re-importing or merging datasets
- **Performance impact**: 2-3x slower
- **Benefit**: Prevents duplicate events

```bash
deno task import events.jsonl --skip-duplicates
```

### --parallel <n>

Number of parallel workers for event validation.

- **Default**: 4
- **Range**: 1 - CPU cores
- **Recommendation**: Set to number of CPU cores for maximum speed

```bash
deno task import events.jsonl --parallel 8
```

### --progress-interval <n>

How often to print progress reports (in seconds).

- **Default**: 5
- **Range**: 1 - 60

```bash
deno task import events.jsonl --progress-interval 10
```

## File Format

The input file must be in JSONL (JSON Lines) format, with one valid Nostr event per line:

```jsonl
{"id":"abc123...","pubkey":"def456...","created_at":1234567890,"kind":1,"tags":[],"content":"Hello world","sig":"789xyz..."}
{"id":"ghi789...","pubkey":"jkl012...","created_at":1234567891,"kind":1,"tags":[["e","abc123..."]],"content":"Reply","sig":"345uvw..."}
```

### Event Structure

Each event must have the following fields:

- `id` (string): Event ID (hex)
- `pubkey` (string): Public key (hex)
- `created_at` (number): Unix timestamp
- `kind` (number): Event kind
- `tags` (array): Array of tag arrays
- `content` (string): Event content
- `sig` (string): Signature (hex)

## Performance Tuning

### Maximum Throughput

For the fastest import on a powerful machine:

```bash
deno task import events.jsonl \
  --skip-validation \
  --batch-size 20000 \
  --parallel 16
```

**Expected rate**: 100,000+ events/second

### Balanced Performance

Good balance of speed and safety:

```bash
deno task import events.jsonl \
  --batch-size 10000 \
  --parallel 8
```

**Expected rate**: 10,000-20,000 events/second

### Safe Import

Maximum safety with duplicate checking:

```bash
deno task import events.jsonl \
  --skip-duplicates \
  --batch-size 5000 \
  --parallel 4
```

**Expected rate**: 2,000-5,000 events/second

## Memory Usage

The importer uses streaming and batching to minimize memory usage:

- **Base memory**: ~50MB
- **Per batch**: ~10MB per 5,000 events
- **Validation workers**: ~5MB per worker

### Example

With `--batch-size 10000 --parallel 8`:
- Base: 50MB
- Batch buffer: 20MB
- Workers: 40MB
- **Total**: ~110MB

## Import Examples

### Import 1GB File

```bash
deno task import events-1gb.jsonl
```

Expected time: 1-2 minutes

### Import 10GB File

```bash
deno task import events-10gb.jsonl \
  --batch-size 10000 \
  --parallel 8
```

Expected time: 10-20 minutes

### Import 100GB File

```bash
deno task import events-100gb.jsonl \
  --batch-size 20000 \
  --parallel 16 \
  --progress-interval 30
```

Expected time: 2-3 hours

## Progress Output

During import, you'll see periodic progress reports:

```
📂 Starting import from: events.jsonl
⚙️  Options: { batchSize: 5000, skipValidation: false, skipDuplicates: false, parallelValidation: 4 }
📊 Progress: 50,000 lines, 49,823 valid, 177 invalid, 0 duplicates, 10,000 lines/sec
📊 Progress: 100,000 lines, 99,654 valid, 346 invalid, 0 duplicates, 10,000 lines/sec
...
============================================================
📈 Import Complete!
============================================================
Total lines processed: 1,000,000
Valid events:          998,234
Invalid events:        1,766
Duplicate events:      0
Errors:                0
Time elapsed:          100.52s
Processing rate:       9,951 lines/sec
============================================================
```

## Error Handling

### Invalid JSON

Lines with invalid JSON are logged and skipped:

```
Error parsing line 12345: SyntaxError: Unexpected token
```

### Invalid Events

Events with invalid structure are counted as invalid:

```
📊 Progress: ... 177 invalid ...
```

### Database Errors

If a batch insert fails, the error is logged and the import continues:

```
Failed to insert batch of 5000 events: Connection timeout
```

### Recovery

The importer is designed to be resumable:

1. Note the line number where the import failed
2. Split the file to start from that line:
   ```bash
   tail -n +12345 events.jsonl > events-resume.jsonl
   ```
3. Resume the import:
   ```bash
   deno task import events-resume.jsonl
   ```

## Programmatic Usage

You can also use the importer in your own scripts:

```typescript
import { EventImporter } from "./src/import.ts";

const importer = new EventImporter({
  batchSize: 10000,
  skipValidation: false,
  skipDuplicates: true,
  parallelValidation: 8,
  progressInterval: 10,
});

try {
  await importer.importFile("events.jsonl");
} finally {
  await importer.close();
}
```

## Troubleshooting

### Out of Memory

If you get OOM errors:

1. Reduce batch size: `--batch-size 2000`
2. Reduce parallelism: `--parallel 2`
3. Increase system memory or use swap

### Slow Performance

If import is slower than expected:

1. Check ClickHouse performance (CPU, disk I/O)
2. Increase batch size: `--batch-size 20000`
3. Increase parallelism: `--parallel 16`
4. Consider `--skip-validation` for trusted data

### Database Connection Errors

If you see connection errors:

1. Verify ClickHouse is running
2. Check DATABASE_URL in .env
3. Ensure ClickHouse has enough connections available
4. Try reducing batch size to reduce connection time

### Duplicate Events

If you're getting duplicate events:

1. Use `--skip-duplicates` flag
2. Or clean up duplicates after import:
   ```sql
   OPTIMIZE TABLE nostr_events FINAL DEDUPLICATE BY id;
   ```

## Best Practices

1. **Test with small files first**: Validate your data format with a small sample
2. **Monitor system resources**: Watch CPU, memory, and disk I/O during import
3. **Use screen/tmux**: For long imports, use a terminal multiplexer to prevent disconnection
4. **Backup before importing**: Always backup your database before large imports
5. **Validate data source**: Only use `--skip-validation` with trusted sources
6. **Check final stats**: Review the final statistics to ensure expected results

## Comparison with Live Import

| Feature | Batch Import | Live Relay |
|---------|-------------|------------|
| Speed | 10,000+ events/sec | 1,000-2,000 events/sec |
| Validation | Optional | Always |
| Duplicates | Optional check | No check |
| Use case | Historical data | Real-time events |
| Memory | Low (streaming) | Higher (queues) |

Use batch import for:
- Initial database population
- Historical data imports
- Migrating from other relays
- Merging datasets

Use live relay for:
- Real-time event streaming
- Client connections
- Normal operation
