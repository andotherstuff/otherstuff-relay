/**
 * Generate a test JSONL file with sample Nostr events
 * Useful for testing the import functionality
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { setNostrWasm } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";

interface GenerateOptions {
  count: number;
  outputFile: string;
  kinds?: number[];
  includeInvalid?: boolean;
  invalidRate?: number;
}

async function generateTestEvents(options: GenerateOptions): Promise<void> {
  const {
    count,
    outputFile,
    kinds = [1], // Default to kind 1 (text notes)
    includeInvalid = false,
    invalidRate = 0.01, // 1% invalid by default
  } = options;

  console.log(`🔧 Generating ${count.toLocaleString()} test events...`);
  console.log(`📝 Output file: ${outputFile}`);

  // Initialize WASM for signing
  const wasm = await initNostrWasm();
  setNostrWasm(wasm);

  // Generate some test keys
  const numKeys = Math.min(100, Math.ceil(count / 10)); // 10 events per key on average
  const keys: { secret: Uint8Array; public: string }[] = [];

  console.log(`🔑 Generating ${numKeys} test keys...`);
  for (let i = 0; i < numKeys; i++) {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    keys.push({ secret: sk, public: pk });
  }

  // Open file for writing
  const file = await Deno.open(outputFile, {
    write: true,
    create: true,
    truncate: true,
  });

  const encoder = new TextEncoder();
  let validCount = 0;
  let invalidCount = 0;

  try {
    for (let i = 0; i < count; i++) {
      // Select random key
      const key = keys[Math.floor(Math.random() * keys.length)];

      // Select random kind
      const kind = kinds[Math.floor(Math.random() * kinds.length)];

      // Generate timestamp (spread over last 30 days)
      const now = Math.floor(Date.now() / 1000);
      const created_at = now - Math.floor(Math.random() * 30 * 24 * 60 * 60);

      // Generate content
      const content = generateContent(kind, i);

      // Generate tags
      const tags = generateTags(kind, i);

      // Create event
      const event = finalizeEvent(
        {
          kind,
          created_at,
          tags,
          content,
        },
        key.secret
      );

      // Optionally corrupt the event to make it invalid
      if (includeInvalid && Math.random() < invalidRate) {
        // Corrupt the signature
        event.sig = event.sig.slice(0, -4) + "0000";
        invalidCount++;
      } else {
        validCount++;
      }

      // Write to file
      await file.write(encoder.encode(JSON.stringify(event) + "\n"));

      // Progress report
      if ((i + 1) % 10000 === 0) {
        console.log(`📊 Generated ${(i + 1).toLocaleString()} events...`);
      }
    }
  } finally {
    file.close();
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ Generation complete!");
  console.log("=".repeat(60));
  console.log(`Total events:     ${count.toLocaleString()}`);
  console.log(`Valid events:     ${validCount.toLocaleString()}`);
  console.log(`Invalid events:   ${invalidCount.toLocaleString()}`);
  console.log(`Output file:      ${outputFile}`);
  console.log(`File size:        ${await getFileSize(outputFile)}`);
  console.log("=".repeat(60) + "\n");
}

function generateContent(kind: number, index: number): string {
  switch (kind) {
    case 0: // Profile metadata
      return JSON.stringify({
        name: `TestUser${index}`,
        about: `Test user ${index} for import testing`,
        picture: `https://example.com/avatar${index}.jpg`,
      });
    case 1: // Text note
      return `This is test note #${index}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`;
    case 3: // Contact list
      return "";
    case 4: // Encrypted DM
      return `Encrypted message ${index}`;
    case 5: // Event deletion
      return "";
    case 6: // Repost
      return "";
    case 7: // Reaction
      return ["+", "❤️", "🔥", "👍"][Math.floor(Math.random() * 4)];
    default:
      return `Test event ${index} of kind ${kind}`;
  }
}

function generateTags(kind: number, _index: number): string[][] {
  const tags: string[][] = [];

  switch (kind) {
    case 0: // Profile metadata
      break;
    case 1: // Text note
      // Occasionally add reply tags
      if (Math.random() < 0.3) {
        tags.push(["e", randomEventId(), "", "reply"]);
      }
      // Occasionally add mentions
      if (Math.random() < 0.2) {
        tags.push(["p", randomPubkey()]);
      }
      break;
    case 3: // Contact list
      // Add some random contacts
      for (let i = 0; i < 10; i++) {
        tags.push(["p", randomPubkey()]);
      }
      break;
    case 5: // Event deletion
      tags.push(["e", randomEventId()]);
      break;
    case 6: // Repost
      tags.push(["e", randomEventId()]);
      tags.push(["p", randomPubkey()]);
      break;
    case 7: // Reaction
      tags.push(["e", randomEventId()]);
      tags.push(["p", randomPubkey()]);
      break;
  }

  return tags;
}

function randomEventId(): string {
  return Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

function randomPubkey(): string {
  return Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

async function getFileSize(path: string): Promise<string> {
  const stat = await Deno.stat(path);
  const bytes = stat.size;

  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// CLI interface
if (import.meta.main) {
  const args = Deno.args;

  if (args.length < 2) {
    console.log(`
Usage: deno run -A scripts/generate-test-events.ts <count> <output.jsonl> [options]

Arguments:
  count              Number of events to generate
  output.jsonl       Output file path

Options:
  --kinds <n,n,n>    Event kinds to generate (default: 1)
  --invalid          Include invalid events
  --invalid-rate <n> Rate of invalid events (default: 0.01)

Examples:
  # Generate 10,000 text notes
  deno run -A scripts/generate-test-events.ts 10000 test-events.jsonl

  # Generate 1 million mixed events
  deno run -A scripts/generate-test-events.ts 1000000 test-events.jsonl --kinds 1,3,6,7

  # Generate events with 5% invalid
  deno run -A scripts/generate-test-events.ts 100000 test-events.jsonl --invalid --invalid-rate 0.05
    `);
    Deno.exit(1);
  }

  const count = parseInt(args[0]);
  const outputFile = args[1];
  const options: GenerateOptions = { count, outputFile };

  // Parse options
  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case "--kinds":
        options.kinds = args[++i].split(",").map((k) => parseInt(k));
        break;
      case "--invalid":
        options.includeInvalid = true;
        break;
      case "--invalid-rate":
        options.invalidRate = parseFloat(args[++i]);
        break;
    }
  }

  await generateTestEvents(options);
}
