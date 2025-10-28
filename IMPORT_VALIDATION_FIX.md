# Import Validation Fix

## Problem

The import script was failing when encountering events with invalid numeric values, specifically:
- Negative `kind` values (e.g., `-1`)
- Negative `created_at` values
- Non-integer values
- Values exceeding UInt32 maximum (4,294,967,295)

These invalid events would pass the basic validation and reach ClickHouse, which would then reject them with errors like:

```
Error: Unsigned type must not contain '-' symbol: (while reading the value of key kind)
type: "CANNOT_PARSE_NUMBER"
```

## Solution

Enhanced the `isValidEventStructure()` method to perform comprehensive validation **before** attempting to insert into ClickHouse:

### 1. Numeric Field Validation

Added validation for `kind` and `created_at` fields:
- Must be non-negative (`>= 0`)
- Must be integers (no decimals)
- Must not exceed UInt32 maximum (`<= 4,294,967,295`)

### 2. String Field Validation

Added validation for `id`, `pubkey`, and `sig` fields:
- Must be exact length (64 chars for id/pubkey, 128 for sig)
- Must be valid hexadecimal strings
- Prevents malformed or corrupted event data

### 3. Tags Validation

Added proper validation for the `tags` field:
- Must be an array of arrays
- Each inner array must contain only strings
- Prevents type errors during ClickHouse insertion

### 4. Improved Error Reporting

Added a new `getValidationError()` method that provides detailed diagnostic information:
- Shows exactly which field failed validation
- Shows the actual value and expected value
- Logs first 10 invalid events for debugging

Example output:
```
⚠️  Invalid event structure at line 3389527: kind is -1, must be >= 0
```

## Benefits

1. **Fail Fast**: Invalid events are rejected immediately during parsing, not during database insertion
2. **Better Performance**: Prevents wasted database operations on invalid data
3. **Clear Diagnostics**: Detailed error messages help identify data quality issues
4. **Data Integrity**: Ensures only valid Nostr events reach the database
5. **No Silent Failures**: All validation failures are counted and reported

## Testing

The changes have been validated:
- ✅ TypeScript type checking passes (`deno check .`)
- ✅ Linting passes (`deno lint`)
- ✅ All validation rules align with Nostr protocol and ClickHouse schema

## Usage

No changes to the command-line interface. The import script will now automatically reject invalid events:

```bash
# Import will now block invalid events automatically
deno task import events.jsonl

# Progress output will show invalid events
📊 Progress: 3,389,527 lines, 3,200,000 valid, 189,527 invalid, 0 duplicates, 1,234 lines/sec
```

## Validation Rules

### Required Fields and Types
- `id`: string, 64 hex chars
- `pubkey`: string, 64 hex chars
- `created_at`: UInt32 (0 to 4,294,967,295)
- `kind`: UInt32 (0 to 4,294,967,295)
- `tags`: Array<Array<string>>
- `content`: string
- `sig`: string, 128 hex chars

### Common Invalid Scenarios (Now Blocked)
- ❌ Negative kind values
- ❌ Negative timestamps
- ❌ Decimal/float values for kind or created_at
- ❌ Invalid hex strings (non-hex characters)
- ❌ Wrong length id/pubkey/sig
- ❌ Malformed tags arrays
- ❌ Timestamps beyond year 2106 (UInt32 max)
