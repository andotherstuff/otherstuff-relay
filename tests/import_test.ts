/**
 * Tests for the batch import functionality
 */
import { assertEquals } from "jsr:@std/assert";
import { EventImporter } from "../src/import.ts";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { setNostrWasm } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";

// Initialize WASM for tests
const wasm = await initNostrWasm();
setNostrWasm(wasm);

Deno.test("EventImporter - validates event structure", async () => {
  const importer = new EventImporter();
  
  // Valid event structure
  const validEvent = {
    id: "abc123",
    pubkey: "def456",
    created_at: 1234567890,
    kind: 1,
    tags: [],
    content: "test",
    sig: "789xyz",
  };
  
  // @ts-ignore: accessing private method for testing
  assertEquals(importer.isValidEventStructure(validEvent), true);
  
  // Invalid event structures
  // @ts-ignore: accessing private method for testing
  assertEquals(importer.isValidEventStructure(null), false);
  // @ts-ignore: accessing private method for testing
  assertEquals(importer.isValidEventStructure({}), false);
  // @ts-ignore: accessing private method for testing
  assertEquals(importer.isValidEventStructure({ id: "test" }), false);
  
  await importer.close();
});

Deno.test("EventImporter - creates test JSONL file", async () => {
  const testFile = await Deno.makeTempFile({ suffix: ".jsonl" });
  
  try {
    // Generate a small test file
    const sk = generateSecretKey();
    const encoder = new TextEncoder();
    const file = await Deno.open(testFile, { write: true, truncate: true });
    
    // Write 10 test events
    for (let i = 0; i < 10; i++) {
      const event = finalizeEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: `Test event ${i}`,
      }, sk);
      
      await file.write(encoder.encode(JSON.stringify(event) + "\n"));
    }
    
    file.close();
    
    // Verify file exists and has content
    const stat = await Deno.stat(testFile);
    assertEquals(stat.isFile, true);
    assertEquals(stat.size > 0, true);
    
  } finally {
    // Cleanup
    try {
      await Deno.remove(testFile);
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("EventImporter - handles empty file", async () => {
  const testFile = await Deno.makeTempFile({ suffix: ".jsonl" });
  
  try {
    const importer = new EventImporter({
      skipValidation: true,
      batchSize: 100,
    });
    
    // Import empty file (should not throw)
    await importer.importFile(testFile);
    await importer.close();
    
  } finally {
    await Deno.remove(testFile);
  }
});

Deno.test("EventImporter - handles malformed JSON", async () => {
  const testFile = await Deno.makeTempFile({ suffix: ".jsonl" });
  
  try {
    const encoder = new TextEncoder();
    await Deno.writeFile(testFile, encoder.encode("not valid json\n"));
    
    const importer = new EventImporter({
      skipValidation: true,
      batchSize: 100,
    });
    
    // Should handle error gracefully
    await importer.importFile(testFile);
    await importer.close();
    
  } finally {
    await Deno.remove(testFile);
  }
});
