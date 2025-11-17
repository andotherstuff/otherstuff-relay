import { assertEquals } from "@std/assert";
import { Channel, BroadcastChannel, ResponseRouter } from "./channel.ts";

Deno.test("Channel - push and pop", async () => {
  const channel = new Channel<number>();

  channel.push(1);
  channel.push(2);
  channel.push(3);

  const items = await channel.pop(2, 100);
  assertEquals(items, [1, 2]);

  const items2 = await channel.pop(2, 100);
  assertEquals(items2, [3]);
});

Deno.test("Channel - blocking pop", async () => {
  const channel = new Channel<string>();

  // Start a pop that will block
  const popPromise = channel.pop(1, 500);

  // Push after a delay
  setTimeout(() => {
    channel.push("hello");
  }, 100);

  const items = await popPromise;
  assertEquals(items, ["hello"]);
});

Deno.test("Channel - timeout on empty pop", async () => {
  const channel = new Channel<string>();

  const items = await channel.pop(1, 100);
  assertEquals(items, []);
});

Deno.test("Channel - backpressure", () => {
  const channel = new Channel<number>(3);

  assertEquals(channel.push(1), true);
  assertEquals(channel.push(2), true);
  assertEquals(channel.push(3), false); // At maxSize, signal backpressure
  assertEquals(channel.push(4), false); // Over maxSize, signal backpressure
});

Deno.test("Channel - batch operations", async () => {
  const channel = new Channel<number>();

  channel.pushBatch([1, 2, 3, 4, 5]);

  const items = await channel.pop(3, 100);
  assertEquals(items, [1, 2, 3]);

  const items2 = await channel.pop(10, 100);
  assertEquals(items2, [4, 5]);
});

Deno.test("BroadcastChannel - subscribe and broadcast", () => {
  const bc = new BroadcastChannel<string>();

  const received: string[] = [];
  bc.subscribe((msg) => received.push(msg));

  bc.broadcast("hello");
  bc.broadcast("world");

  assertEquals(received, ["hello", "world"]);
});

Deno.test("BroadcastChannel - unsubscribe", () => {
  const bc = new BroadcastChannel<string>();

  const received: string[] = [];
  const unsub = bc.subscribe((msg) => received.push(msg));

  bc.broadcast("hello");
  unsub();
  bc.broadcast("world");

  assertEquals(received, ["hello"]);
});

Deno.test("ResponseRouter - send and receive", async () => {
  const router = new ResponseRouter();

  router.send("conn1", "message1");
  router.send("conn1", "message2");
  router.send("conn2", "message3");

  const channel1 = router.getChannel<string>("conn1");
  const items1 = await channel1.pop(10, 100);
  assertEquals(items1, ["message1", "message2"]);

  const channel2 = router.getChannel<string>("conn2");
  const items2 = await channel2.pop(10, 100);
  assertEquals(items2, ["message3"]);
});

Deno.test("ResponseRouter - stats", () => {
  const router = new ResponseRouter();

  router.send("conn1", "msg1");
  router.send("conn1", "msg2");
  router.send("conn2", "msg3");

  const stats = router.stats();
  assertEquals(stats.connections, 2);
  assertEquals(stats.totalQueued, 3);
});

Deno.test("ResponseRouter - remove channel", () => {
  const router = new ResponseRouter();

  router.send("conn1", "msg1");
  router.removeChannel("conn1");

  const stats = router.stats();
  assertEquals(stats.connections, 0);
  assertEquals(stats.totalQueued, 0);
});
