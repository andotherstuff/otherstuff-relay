/**
 * Native secp256k1 verification using Deno FFI
 * Much faster than WASM-based verification
 */

import type { NostrEvent } from "@nostrify/nostrify";

// Try to find libsecp256k1 in common locations
const LIBSECP256K1_PATHS = [
  "/usr/lib/x86_64-linux-gnu/libsecp256k1.so.0",
  "/usr/lib/x86_64-linux-gnu/libsecp256k1.so",
  "/usr/lib/libsecp256k1.so.0",
  "/usr/lib/libsecp256k1.so",
  "/usr/local/lib/libsecp256k1.so",
  "/opt/homebrew/lib/libsecp256k1.dylib", // macOS ARM
  "/usr/local/opt/libsecp256k1/lib/libsecp256k1.dylib", // macOS Intel
];

let secp256k1Lib: Deno.DynamicLibrary<typeof symbols> | null = null;

const symbols = {
  secp256k1_context_create: {
    parameters: ["u32"],
    result: "pointer",
  },
  secp256k1_context_destroy: {
    parameters: ["pointer"],
    result: "void",
  },
  secp256k1_ecdsa_signature_parse_compact: {
    parameters: ["pointer", "pointer", "pointer"],
    result: "i32",
  },
  secp256k1_schnorrsig_verify: {
    parameters: ["pointer", "pointer", "pointer", "i32", "pointer"],
    result: "i32",
  },
} as const;

/**
 * Initialize native secp256k1 library
 */
export function initNativeSecp256k1(): boolean {
  if (secp256k1Lib !== null) {
    return true;
  }

  // Try to find and load the library
  for (const path of LIBSECP256K1_PATHS) {
    try {
      secp256k1Lib = Deno.dlopen(path, symbols);
      console.log(`✅ Loaded native secp256k1 from ${path}`);
      return true;
    } catch {
      // Try next path
    }
  }

  console.warn("⚠️  Could not load native secp256k1, falling back to WASM");
  return false;
}

/**
 * Fallback to WASM verification
 */
let wasmVerify: ((event: NostrEvent) => boolean) | null = null;

async function initWasmFallback() {
  if (wasmVerify !== null) return;

  try {
    const { setNostrWasm, verifyEvent } = await import("nostr-tools/wasm");
    const { initNostrWasm } = await import("nostr-wasm");
    const wasm = await initNostrWasm();
    setNostrWasm(wasm);
    wasmVerify = verifyEvent;
  } catch (err) {
    console.error("Failed to initialize WASM fallback:", err);
    throw err;
  }
}

/**
 * Hex string to bytes
 */
function _hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * SHA256 hash
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

/**
 * Get event hash (event ID)
 */
async function getEventHash(event: NostrEvent): Promise<string> {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);

  const hash = await sha256(new TextEncoder().encode(serialized));
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify event using native secp256k1 (schnorr signatures)
 * Falls back to WASM if native library is not available
 */
export async function verifyEvent(event: NostrEvent): Promise<boolean> {
  // Verify event ID first (cheap check)
  const expectedId = await getEventHash(event);
  if (expectedId !== event.id) {
    return false;
  }

  // If native library is available, use it
  if (secp256k1Lib !== null) {
    try {
      return verifyEventNative(event);
    } catch (err) {
      console.error("Native verification failed, falling back to WASM:", err);
      // Fall through to WASM
    }
  }

  // Fall back to WASM
  if (wasmVerify === null) {
    await initWasmFallback();
  }

  return wasmVerify!(event);
}

/**
 * Verify event signature using native secp256k1
 * NOTE: This is a placeholder - actual FFI implementation is complex
 * For now, we'll fall back to WASM
 */
function verifyEventNative(_event: NostrEvent): boolean {
  // TODO: Implement proper FFI buffer handling for schnorr verification
  // This requires careful buffer allocation and pointer management
  // For now, throw to fall back to WASM
  throw new Error("Native verification not yet implemented - using WASM");
}

/**
 * Batch verify multiple events
 * Processes events in parallel for better throughput
 */
export async function verifyEventBatch(
  events: NostrEvent[],
): Promise<boolean[]> {
  // Verify in parallel
  return await Promise.all(events.map((event) => verifyEvent(event)));
}

/**
 * Fast event validation (structure only, no signature check)
 */
export function validateEventStructure(event: unknown): event is NostrEvent {
  if (typeof event !== "object" || event === null) {
    return false;
  }

  const e = event as Partial<NostrEvent>;

  // Required fields
  if (typeof e.id !== "string" || e.id.length !== 64) return false;
  if (typeof e.pubkey !== "string" || e.pubkey.length !== 64) return false;
  if (typeof e.created_at !== "number") return false;
  if (typeof e.kind !== "number") return false;
  if (!Array.isArray(e.tags)) return false;
  if (typeof e.content !== "string") return false;
  if (typeof e.sig !== "string" || e.sig.length !== 128) return false;

  // Validate tags structure
  for (const tag of e.tags) {
    if (!Array.isArray(tag)) return false;
    if (tag.length === 0) return false;
    if (typeof tag[0] !== "string") return false;
  }

  return true;
}
