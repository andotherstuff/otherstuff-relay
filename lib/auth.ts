/**
 * NIP-98 HTTP Authentication
 * Validates Nostr auth events for HTTP requests
 */

import { type Event as NostrEvent, verifyEvent } from "nostr-tools";
import { createHash } from "node:crypto";

export interface AuthValidationResult {
  valid: boolean;
  pubkey?: string;
  error?: string;
}

/**
 * Extract and decode the NIP-98 auth event from Authorization header
 */
export function extractAuthEvent(
  authHeader: string | null | undefined,
): NostrEvent | null {
  if (!authHeader) {
    return null;
  }

  // Authorization header format: "Nostr <base64-encoded-event>"
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Nostr") {
    return null;
  }

  try {
    const decoded = atob(parts[1]);
    const event = JSON.parse(decoded) as NostrEvent;
    return event;
  } catch {
    return null;
  }
}

/**
 * Validate a NIP-98 auth event
 * @param event The auth event to validate
 * @param url The absolute request URL (including query params)
 * @param method The HTTP method (GET, POST, etc.)
 * @param body The request body (for POST/PUT/PATCH)
 * @param timeWindowSeconds How many seconds old the event can be (default 60)
 */
export function validateAuthEvent(
  event: NostrEvent,
  url: string,
  method: string,
  body?: string,
  timeWindowSeconds = 60,
): AuthValidationResult {
  // 1. Check kind is 27235
  if (event.kind !== 27235) {
    return {
      valid: false,
      error: "Auth event must be kind 27235",
    };
  }

  // 2. Check created_at is within time window
  const now = Math.floor(Date.now() / 1000);
  const age = now - event.created_at;
  if (Math.abs(age) > timeWindowSeconds) {
    return {
      valid: false,
      error: `Auth event timestamp outside ${timeWindowSeconds}s window`,
    };
  }

  // 3. Verify signature
  if (!verifyEvent(event)) {
    return {
      valid: false,
      error: "Invalid event signature",
    };
  }

  // 4. Check 'u' tag matches URL exactly
  const uTag = event.tags.find((tag) => tag[0] === "u");
  try {
    if (!uTag || new URL(uTag[1]).href !== new URL(url).href) {
      return {
        valid: false,
        error: "URL in 'u' tag does not match request URL",
      };
    }
  } catch {
    return {
      valid: false,
      error: "Invalid URL in 'u' tag",
    };
  }

  // 5. Check 'method' tag matches HTTP method
  const methodTag = event.tags.find((tag) => tag[0] === "method");
  if (!methodTag || methodTag[1] !== method) {
    return {
      valid: false,
      error: "Method in 'method' tag does not match request method",
    };
  }

  // 6. For requests with body, check payload hash if present
  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    const payloadTag = event.tags.find((tag) => tag[0] === "payload");
    if (payloadTag) {
      const expectedHash = createHash("sha256").update(body).digest("hex");
      if (payloadTag[1] !== expectedHash) {
        return {
          valid: false,
          error: "Payload hash does not match request body",
        };
      }
    }
  }

  return {
    valid: true,
    pubkey: event.pubkey,
  };
}

/**
 * Check if a pubkey is authorized as an admin
 */
export function isAuthorizedAdmin(
  pubkey: string,
  adminPubkeys: string[],
): boolean {
  return adminPubkeys.includes(pubkey);
}
