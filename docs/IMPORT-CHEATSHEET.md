# Import Cheatsheet

Quick reference for the batch import feature.

## Basic Commands

```bash
# Basic import
deno task import events.jsonl

# Fast import (skip validation)
deno task import events.jsonl --skip-validation

# Safe import (check duplicates)
deno task import events.jsonl --skip-duplicates

# Optimized import
deno task import events.jsonl --batch-size 10000 --parallel 8
```

## Generate Test Data

```bash
# 10,000 events
deno task generate-test-events 10000 test.jsonl

# 1 million events
deno task generate-test-events 1000000 test.jsonl

# Mixed event kinds
deno task generate-test-events 100000 test.jsonl --kinds 1,3,6,7

# With invalid events
deno task generate-test-events 10000 test.jsonl --invalid --invalid-rate 0.05
```

## Common Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `--batch-size` | 100-50000 | 5000 | Events per batch |
| `--parallel` | 1-CPU cores | 4 | Validation workers |
| `--progress-interval` | 1-60 | 5 | Report interval (sec) |
| `--skip-validation` | flag | false | Skip signature check |
| `--skip-duplicates` | flag | false | Check for duplicates |

## Performance Presets

### Maximum Speed (Trusted Data)
```bash
deno task import events.jsonl \
  --skip-validation \
  --batch-size 20000 \
  --parallel 16
```
**~100,000+ events/sec**

### Balanced
```bash
deno task import events.jsonl \
  --batch-size 10000 \
  --parallel 8
```
**~20,000 events/sec**

### Maximum Safety
```bash
deno task import events.jsonl \
  --skip-duplicates \
  --batch-size 5000 \
  --parallel 4
```
**~5,000 events/sec**

### Low Memory
```bash
deno task import events.jsonl \
  --batch-size 1000 \
  --parallel 2
```
**~2,000 events/sec, ~60MB RAM**

## File Size Estimates

| Events | File Size | Time (validated) | Time (skip) |
|--------|-----------|------------------|-------------|
| 10K | ~5 MB | 4 sec | 0.5 sec |
| 100K | ~50 MB | 40 sec | 5 sec |
| 1M | ~500 MB | 7 min | 45 sec |
| 10M | ~5 GB | 70 min | 7 min |
| 100M | ~50 GB | 12 hours | 70 min |

## Troubleshooting

| Problem | Quick Fix |
|---------|-----------|
| Too slow | Add `--skip-validation --batch-size 20000 --parallel 16` |
| Out of memory | Add `--batch-size 1000` |
| DB connection error | Check `DATABASE_URL` in `.env` |
| Invalid events | Review source data, check error messages |
| Duplicates | Add `--skip-duplicates` |

## File Format

Each line must be a valid JSON Nostr event:

```json
{"id":"abc...","pubkey":"def...","created_at":1234567890,"kind":1,"tags":[],"content":"Hello","sig":"xyz..."}
```

## Progress Output

```
📂 Starting import from: events.jsonl
⚙️  Options: { batchSize: 5000, ... }
📊 Progress: 50,000 lines, 49,823 valid, 177 invalid, 0 duplicates, 10,000 lines/sec
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

## Programmatic Usage

```typescript
import { EventImporter } from "./src/import.ts";

const importer = new EventImporter({
  batchSize: 10000,
  skipValidation: false,
  skipDuplicates: true,
  parallelValidation: 8,
});

await importer.importFile("events.jsonl");
await importer.close();
```

## Environment Variables

```bash
# Required
DATABASE_URL=http://localhost:8123/nostr

# Optional (for duplicate checking)
REDIS_URL=redis://localhost:6379
```

## Tips

- ✅ Test with small files first
- ✅ Use `--skip-validation` only for trusted data
- ✅ Use `--skip-duplicates` when re-importing
- ✅ Set `--parallel` to your CPU core count
- ✅ Use screen/tmux for long imports
- ✅ Monitor system resources
- ✅ Backup database before large imports

## Links

- [Quick Start Guide](IMPORT-QUICKSTART.md)
- [Full Documentation](IMPORT.md)
- [Feature Summary](IMPORT-SUMMARY.md)
- [Example Code](../examples/import-example.ts)
