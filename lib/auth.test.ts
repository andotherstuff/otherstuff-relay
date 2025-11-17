import { assertEquals } from "@std/assert";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import {
  extractAuthEvent,
  isAuthorizedAdmin,
  validateAuthEvent,
} from "./auth.ts";
import { createHash } from "node:crypto";

Deno.test("extractAuthEvent - valid authorization header", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", "http://localhost:8000/"],
        ["method", "POST"],
      ],
      content: "",
    },
    sk,
  );

  const encoded = btoa(JSON.stringify(event));
  const authHeader = `Nostr ${encoded}`;

  const extracted = extractAuthEvent(authHeader);
  assertEquals(extracted?.id, event.id);
  assertEquals(extracted?.kind, 27235);
});

Deno.test("extractAuthEvent - invalid format", () => {
  assertEquals(extractAuthEvent(null), null);
  assertEquals(extractAuthEvent(""), null);
  assertEquals(extractAuthEvent("Bearer token"), null);
  assertEquals(extractAuthEvent("Nostr"), null);
  assertEquals(extractAuthEvent("Nostr invalid-base64"), null);
});

Deno.test("validateAuthEvent - valid event", () => {
  const sk = generateSecretKey();
  const url = "http://localhost:8000/";
  const method = "POST";
  const body = JSON.stringify({ method: "supportedmethods", params: [] });

  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ],
      content: "",
    },
    sk,
  );

  const result = validateAuthEvent(event, url, method, body);
  assertEquals(result.valid, true);
  assertEquals(result.pubkey, getPublicKey(sk));
});

Deno.test("validateAuthEvent - wrong kind", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", "http://localhost:8000/"],
        ["method", "POST"],
      ],
      content: "",
    },
    sk,
  );

  const result = validateAuthEvent(
    event,
    "http://localhost:8000/",
    "POST",
  );
  assertEquals(result.valid, false);
  assertEquals(result.error, "Auth event must be kind 27235");
});

Deno.test("validateAuthEvent - expired timestamp", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000) - 120, // 2 minutes ago
      tags: [
        ["u", "http://localhost:8000/"],
        ["method", "POST"],
      ],
      content: "",
    },
    sk,
  );

  const result = validateAuthEvent(
    event,
    "http://localhost:8000/",
    "POST",
    undefined,
    60, // 60 second window
  );
  assertEquals(result.valid, false);
  assertEquals(result.error?.includes("timestamp outside"), true);
});

Deno.test("validateAuthEvent - URL mismatch", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", "http://localhost:8000/"],
        ["method", "POST"],
      ],
      content: "",
    },
    sk,
  );

  const result = validateAuthEvent(
    event,
    "http://localhost:8000/different",
    "POST",
  );
  assertEquals(result.valid, false);
  assertEquals(result.error, "URL in 'u' tag does not match request URL");
});

Deno.test("validateAuthEvent - method mismatch", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", "http://localhost:8000/"],
        ["method", "POST"],
      ],
      content: "",
    },
    sk,
  );

  const result = validateAuthEvent(
    event,
    "http://localhost:8000/",
    "GET",
  );
  assertEquals(result.valid, false);
  assertEquals(
    result.error,
    "Method in 'method' tag does not match request method",
  );
});

Deno.test("validateAuthEvent - payload hash mismatch", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", "http://localhost:8000/"],
        ["method", "POST"],
        ["payload", "wrong-hash"],
      ],
      content: "",
    },
    sk,
  );

  const result = validateAuthEvent(
    event,
    "http://localhost:8000/",
    "POST",
    "some body content",
  );
  assertEquals(result.valid, false);
  assertEquals(result.error, "Payload hash does not match request body");
});

Deno.test("isAuthorizedAdmin - authorized", () => {
  const pubkey = "a".repeat(64);
  const adminPubkeys = [pubkey, "b".repeat(64)];

  assertEquals(isAuthorizedAdmin(pubkey, adminPubkeys), true);
});

Deno.test("isAuthorizedAdmin - unauthorized", () => {
  const pubkey = "a".repeat(64);
  const adminPubkeys = ["b".repeat(64), "c".repeat(64)];

  assertEquals(isAuthorizedAdmin(pubkey, adminPubkeys), false);
});

Deno.test("isAuthorizedAdmin - empty admin list", () => {
  const pubkey = "a".repeat(64);
  const adminPubkeys: string[] = [];

  assertEquals(isAuthorizedAdmin(pubkey, adminPubkeys), false);
});
