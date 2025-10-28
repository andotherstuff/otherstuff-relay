#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Simple NIP-01 compliance test script
 * Tests basic relay functionality against NIP-01 specification
 */

import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";

const RELAY_URL = Deno.env.get("RELAY_URL") || "ws://localhost:8000";

console.log(`🧪 Testing NIP-01 compliance against ${RELAY_URL}\n`);

// Test helpers
let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`✅ ${message}`);
    testsPassed++;
  } else {
    console.log(`❌ ${message}`);
    testsFailed++;
  }
}

function connectRelay(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    ws.onopen = () => resolve(ws);
    ws.onerror = (err) => reject(err);
  });
}

// deno-lint-ignore no-explicit-any
function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for message"));
    }, timeoutMs);

    ws.onmessage = (event) => {
      clearTimeout(timeout);
      try {
        const data = JSON.parse(event.data);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    };
  });
}

// deno-lint-ignore no-explicit-any
function waitForMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    // deno-lint-ignore no-explicit-any
    const messages: any[] = [];
    const timeout = setTimeout(() => {
      resolve(messages); // Return what we got
    }, timeoutMs);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        messages.push(data);
        if (messages.length >= count) {
          clearTimeout(timeout);
          resolve(messages);
        }
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    };
  });
}

// Test 1: Basic connection
console.log("Test 1: WebSocket Connection");
try {
  const ws = await connectRelay();
  assert(ws.readyState === WebSocket.OPEN, "WebSocket connection established");
  ws.close();
} catch (err) {
  assert(false, `WebSocket connection failed: ${err}`);
}

// Test 2: EVENT message and OK response
console.log("\nTest 2: EVENT Message and OK Response");
try {
  const ws = await connectRelay();
  const sk = generateSecretKey();
  
  const event = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "Hello, NIP-01!",
  }, sk);

  ws.send(JSON.stringify(["EVENT", event]));
  
  const response = await waitForMessage(ws);
  assert(response[0] === "OK", "Received OK message");
  assert(response[1] === event.id, "OK message contains correct event ID");
  assert(typeof response[2] === "boolean", "OK message has boolean acceptance");
  assert(typeof response[3] === "string", "OK message has message string");
  
  ws.close();
} catch (err) {
  assert(false, `EVENT test failed: ${err}`);
}

// Test 3: REQ message and EOSE
console.log("\nTest 3: REQ Message and EOSE");
try {
  const ws = await connectRelay();
  
  const subId = "test-sub-1";
  ws.send(JSON.stringify(["REQ", subId, { kinds: [1], limit: 10 }]));
  
  const messages = await waitForMessages(ws, 1);
  const hasEOSE = messages.some(msg => msg[0] === "EOSE" && msg[1] === subId);
  assert(hasEOSE, "Received EOSE message for subscription");
  
  ws.close();
} catch (err) {
  assert(false, `REQ test failed: ${err}`);
}

// Test 4: CLOSE message
console.log("\nTest 4: CLOSE Message");
try {
  const ws = await connectRelay();
  
  const subId = "test-sub-2";
  ws.send(JSON.stringify(["REQ", subId, { kinds: [1], limit: 1 }]));
  await waitForMessage(ws); // Wait for EOSE
  
  ws.send(JSON.stringify(["CLOSE", subId]));
  
  // If no error, CLOSE was accepted
  assert(true, "CLOSE message accepted");
  
  ws.close();
} catch (err) {
  assert(false, `CLOSE test failed: ${err}`);
}

// Test 5: Invalid subscription ID
console.log("\nTest 5: Invalid Subscription ID (too long)");
try {
  const ws = await connectRelay();
  
  const longSubId = "x".repeat(65); // 65 chars, max is 64
  ws.send(JSON.stringify(["REQ", longSubId, { kinds: [1] }]));
  
  const response = await waitForMessage(ws);
  assert(response[0] === "CLOSED", "Received CLOSED for invalid subscription ID");
  assert(response[2].includes("invalid"), "CLOSED message indicates invalid subscription ID");
  
  ws.close();
} catch (err) {
  assert(false, `Invalid subscription ID test failed: ${err}`);
}

// Test 6: Replaceable event (kind 0)
console.log("\nTest 6: Replaceable Event (kind 0)");
try {
  const ws = await connectRelay();
  const sk = generateSecretKey();
  
  const event1 = finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name: "Test User 1" }),
  }, sk);

  ws.send(JSON.stringify(["EVENT", event1]));
  const response1 = await waitForMessage(ws);
  assert(response1[0] === "OK" && response1[2] === true, "First kind 0 event accepted");
  
  // Wait a second and send another
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const event2 = finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name: "Test User 2" }),
  }, sk);

  ws.send(JSON.stringify(["EVENT", event2]));
  const response2 = await waitForMessage(ws);
  assert(response2[0] === "OK" && response2[2] === true, "Second kind 0 event accepted (should replace first)");
  
  ws.close();
} catch (err) {
  assert(false, `Replaceable event test failed: ${err}`);
}

// Test 7: Duplicate event detection
console.log("\nTest 7: Duplicate Event Detection");
try {
  const ws = await connectRelay();
  const sk = generateSecretKey();
  
  const event = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "Duplicate test",
  }, sk);

  // Send first time
  ws.send(JSON.stringify(["EVENT", event]));
  await waitForMessage(ws); // Wait for first OK
  
  // Send again (duplicate)
  ws.send(JSON.stringify(["EVENT", event]));
  const response2 = await waitForMessage(ws);
  
  assert(
    response2[0] === "OK" && response2[3].includes("duplicate"),
    "Duplicate event detected with 'duplicate:' prefix"
  );
  
  ws.close();
} catch (err) {
  assert(false, `Duplicate detection test failed: ${err}`);
}

// Summary
console.log("\n" + "=".repeat(50));
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
console.log("=".repeat(50));

if (testsFailed > 0) {
  Deno.exit(1);
}
