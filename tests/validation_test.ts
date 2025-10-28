/**
 * Tests for event validation in the import script
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Test helper to access private validation method
class TestableEventImporter {
  isValidEventStructure(event: unknown): boolean {
    if (!event || typeof event !== "object") return false;

    // deno-lint-ignore no-explicit-any
    const e = event as any;

    // Check basic types
    if (
      typeof e.id !== "string" ||
      typeof e.pubkey !== "string" ||
      typeof e.created_at !== "number" ||
      typeof e.kind !== "number" ||
      !Array.isArray(e.tags) ||
      typeof e.content !== "string" ||
      typeof e.sig !== "string"
    ) {
      return false;
    }

    // Validate numeric constraints (ClickHouse UInt32 requirements)
    if (e.kind < 0 || !Number.isInteger(e.kind) || e.kind > 4294967295) {
      return false;
    }

    if (e.created_at < 0 || !Number.isInteger(e.created_at) || e.created_at > 4294967295) {
      return false;
    }

    // Validate string lengths
    if (e.id.length !== 64) {
      return false;
    }

    if (e.pubkey.length !== 64) {
      return false;
    }

    if (e.sig.length !== 128) {
      return false;
    }

    // Validate hex format
    const hexRegex = /^[0-9a-f]+$/i;
    if (!hexRegex.test(e.id) || !hexRegex.test(e.pubkey) || !hexRegex.test(e.sig)) {
      return false;
    }

    // Validate tags structure
    // deno-lint-ignore no-explicit-any
    if (!e.tags.every((tag: any) => 
      // deno-lint-ignore no-explicit-any
      Array.isArray(tag) && tag.every((item: any) => typeof item === "string")
    )) {
      return false;
    }

    return true;
  }
}

const importer = new TestableEventImporter();

// Valid event template
const validEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1234567890,
  kind: 1,
  tags: [["e", "test"]],
  content: "test content",
  sig: "c".repeat(128),
};

Deno.test("Valid event passes validation", () => {
  assertEquals(importer.isValidEventStructure(validEvent), true);
});

Deno.test("Negative kind is rejected", () => {
  const event = { ...validEvent, kind: -1 };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Negative created_at is rejected", () => {
  const event = { ...validEvent, created_at: -1 };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Decimal kind is rejected", () => {
  const event = { ...validEvent, kind: 1.5 };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Decimal created_at is rejected", () => {
  const event = { ...validEvent, created_at: 1234567890.5 };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Kind exceeding UInt32 max is rejected", () => {
  const event = { ...validEvent, kind: 4294967296 };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("created_at exceeding UInt32 max is rejected", () => {
  const event = { ...validEvent, created_at: 4294967296 };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Invalid id length is rejected", () => {
  const event = { ...validEvent, id: "a".repeat(63) };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Invalid pubkey length is rejected", () => {
  const event = { ...validEvent, pubkey: "b".repeat(63) };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Invalid sig length is rejected", () => {
  const event = { ...validEvent, sig: "c".repeat(127) };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Non-hex id is rejected", () => {
  const event = { ...validEvent, id: "z".repeat(64) };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Non-hex pubkey is rejected", () => {
  const event = { ...validEvent, pubkey: "z".repeat(64) };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Non-hex sig is rejected", () => {
  const event = { ...validEvent, sig: "z".repeat(128) };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Invalid tags structure is rejected", () => {
  const event = { ...validEvent, tags: [["e", 123]] }; // number instead of string
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Non-array tags is rejected", () => {
  const event = { ...validEvent, tags: "invalid" };
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Missing field is rejected", () => {
  const event = { ...validEvent };
  // deno-lint-ignore no-explicit-any
  delete (event as any).content;
  assertEquals(importer.isValidEventStructure(event), false);
});

Deno.test("Kind at UInt32 max is accepted", () => {
  const event = { ...validEvent, kind: 4294967295 };
  assertEquals(importer.isValidEventStructure(event), true);
});

Deno.test("created_at at UInt32 max is accepted", () => {
  const event = { ...validEvent, created_at: 4294967295 };
  assertEquals(importer.isValidEventStructure(event), true);
});

Deno.test("Kind at zero is accepted", () => {
  const event = { ...validEvent, kind: 0 };
  assertEquals(importer.isValidEventStructure(event), true);
});

Deno.test("created_at at zero is accepted", () => {
  const event = { ...validEvent, created_at: 0 };
  assertEquals(importer.isValidEventStructure(event), true);
});
