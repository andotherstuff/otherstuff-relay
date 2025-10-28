# Import Quick Start Guide

Get started with importing Nostr events in 5 minutes.

## Step 1: Generate Test Data

Create a test JSONL file with 10,000 events:

```bash
deno task generate-test-events 10000 test-events.jsonl
```

Output:
```
🔧 Generating 10,000 test events...
📝 Output file: test-events.jsonl
🔑 Generating 100 test keys...
📊 Generated 10,000 events...
============================================================
✅ Generation complete!
============================================================
Total events:     10,000
Valid events:     10,000
Invalid events:   0
Output file:      test-events.jsonl
File size:        5.23 MB
============================================================
```

## Step 2: Import the Data

Import the test file into your relay:

```bash
deno task import test-events.jsonl
```

Output:
```
📂 Starting import from: test-events.jsonl
⚙️  Options: { batchSize: 5000, skipValidation: false, skipDuplicates: false, parallelValidation: 4 }
📊 Progress: 5,000 lines, 5,000 valid, 0 invalid, 0 duplicates, 2,500 lines/sec
📊 Progress: 10,000 lines, 10,000 valid, 0 invalid, 0 duplicates, 2,500 lines/sec
============================================================
📈 Import Complete!
============================================================
Total lines processed: 10,000
Valid events:          10,000
Invalid events:        0
Duplicate events:      0
Errors:                0
Time elapsed:          4.00s
Processing rate:       2,500 lines/sec
============================================================
```

## Step 3: Verify the Import

Query your relay to verify the events were imported:

```bash
# Using websocat or any Nostr client
echo '["REQ","test",{"limit":10}]' | websocat ws://localhost:8000
```

## Common Use Cases

### Fast Import (Trusted Data)

Skip signature validation for 5-10x faster import:

```bash
deno task import events.jsonl --skip-validation
```

**Use when:**
- Importing from a trusted relay backup
- Data has already been validated
- Speed is critical

**Don't use when:**
- Data source is untrusted
- Data integrity is uncertain

### Safe Import (Prevent Duplicates)

Check for and skip duplicate events:

```bash
deno task import events.jsonl --skip-duplicates
```

**Use when:**
- Re-importing after a failed import
- Merging data from multiple sources
- Unsure if events already exist

**Don't use when:**
- Importing into an empty database (unnecessary overhead)
- Certain events are new (adds 2-3x overhead)

### Large File Import

Optimize for a 10GB+ file:

```bash
deno task import large-events.jsonl \
  --batch-size 10000 \
  --parallel 8 \
  --progress-interval 30
```

**Settings explained:**
- `--batch-size 10000`: Process 10,000 events per batch (higher = faster but more memory)
- `--parallel 8`: Use 8 CPU cores for validation (set to your CPU count)
- `--progress-interval 30`: Report progress every 30 seconds (reduces log spam)

## Performance Expectations

| File Size | Event Count | Time (validated) | Time (skip validation) |
|-----------|-------------|------------------|------------------------|
| 100 MB    | 100,000     | ~40 seconds      | ~5 seconds             |
| 1 GB      | 1,000,000   | ~7 minutes       | ~45 seconds            |
| 10 GB     | 10,000,000  | ~70 minutes      | ~7 minutes             |
| 100 GB    | 100,000,000 | ~12 hours        | ~70 minutes            |

*Times are approximate and depend on hardware (tested on 8-core CPU, SSD)*

## Troubleshooting

### Import is slow

**Solution 1**: Increase batch size and parallelism
```bash
deno task import events.jsonl --batch-size 20000 --parallel 16
```

**Solution 2**: Skip validation if data is trusted
```bash
deno task import events.jsonl --skip-validation
```

### Out of memory

**Solution**: Reduce batch size
```bash
deno task import events.jsonl --batch-size 1000
```

### Database connection errors

**Solution**: Check ClickHouse is running and DATABASE_URL is correct
```bash
# Check ClickHouse status
curl http://localhost:8123/ping

# Verify DATABASE_URL in .env
cat .env | grep DATABASE_URL
```

### Invalid events

**Solution**: Review the error messages and fix the source data
```bash
# Generate test data with some invalid events to see error handling
deno task generate-test-events 1000 test-invalid.jsonl --invalid --invalid-rate 0.1
deno task import test-invalid.jsonl
```

## Next Steps

- Read the [full import documentation](IMPORT.md) for advanced usage
- Learn about [tuning for performance](IMPORT.md#performance-tuning)
- Explore [programmatic usage](../examples/import-example.ts)
- Check out [test examples](../tests/import_test.ts)

## Tips

1. **Start small**: Test with 1,000-10,000 events before importing millions
2. **Use screen/tmux**: For long imports, use a terminal multiplexer to prevent disconnection
3. **Monitor resources**: Watch CPU, memory, and disk I/O during import
4. **Backup first**: Always backup your database before large imports
5. **Validate source**: Check a sample of events before importing the full file

## Getting Help

If you encounter issues:

1. Check the error message in the output
2. Review the [troubleshooting section](IMPORT.md#troubleshooting)
3. Open an issue on GitHub with:
   - Command you ran
   - Error message
   - File size and event count
   - System specs (CPU, RAM, disk)
