/**
 * Lock-free ring buffer using SharedArrayBuffer and Atomics
 * Like strfry's inbox but for Deno
 * 
 * Zero network calls, zero locks, pure speed
 */

export class RingBuffer {
  private buffer: Uint8Array;
  private metadata: Int32Array;
  public capacity: number;
  private itemSize: number;

  // Metadata indices
  private static readonly HEAD = 0;
  private static readonly TAIL = 1;
  private static readonly COUNT = 2;

  constructor(capacity: number, itemSize: number, shared = false) {
    this.capacity = capacity;
    this.itemSize = itemSize;

    // Allocate shared or regular buffer
    const bufferSize = capacity * itemSize;
    const metadataSize = 3 * Int32Array.BYTES_PER_ELEMENT;

    if (shared && typeof SharedArrayBuffer !== "undefined") {
      const sharedBuffer = new SharedArrayBuffer(bufferSize + metadataSize);
      this.metadata = new Int32Array(sharedBuffer, 0, 3);
      this.buffer = new Uint8Array(sharedBuffer, metadataSize, bufferSize);
    } else {
      const regularBuffer = new ArrayBuffer(bufferSize + metadataSize);
      this.metadata = new Int32Array(regularBuffer, 0, 3);
      this.buffer = new Uint8Array(regularBuffer, metadataSize, bufferSize);
    }

    // Initialize metadata
    Atomics.store(this.metadata, RingBuffer.HEAD, 0);
    Atomics.store(this.metadata, RingBuffer.TAIL, 0);
    Atomics.store(this.metadata, RingBuffer.COUNT, 0);
  }

  /**
   * Push data to ring buffer (lock-free)
   * Returns true if successful, false if full
   */
  push(data: Uint8Array): boolean {
    if (data.length > this.itemSize) {
      throw new Error(`Data too large: ${data.length} > ${this.itemSize}`);
    }

    // Check if buffer is full
    const count = Atomics.load(this.metadata, RingBuffer.COUNT);
    if (count >= this.capacity) {
      return false; // Buffer full
    }

    // Atomically increment tail and get old value
    const tail = Atomics.load(this.metadata, RingBuffer.TAIL);
    const newTail = (tail + 1) % this.capacity;

    // Try to claim this slot
    const claimed = Atomics.compareExchange(
      this.metadata,
      RingBuffer.TAIL,
      tail,
      newTail,
    );

    if (claimed !== tail) {
      // Another thread claimed this slot, try again
      return this.push(data);
    }

    // Write data to buffer
    const offset = tail * this.itemSize;
    this.buffer.set(data, offset);

    // Increment count
    Atomics.add(this.metadata, RingBuffer.COUNT, 1);

    return true;
  }

  /**
   * Pop data from ring buffer (lock-free)
   * Returns null if empty
   */
  pop(): Uint8Array | null {
    // Check if buffer is empty
    const count = Atomics.load(this.metadata, RingBuffer.COUNT);
    if (count === 0) {
      return null; // Buffer empty
    }

    // Atomically increment head and get old value
    const head = Atomics.load(this.metadata, RingBuffer.HEAD);
    const newHead = (head + 1) % this.capacity;

    // Try to claim this slot
    const claimed = Atomics.compareExchange(
      this.metadata,
      RingBuffer.HEAD,
      head,
      newHead,
    );

    if (claimed !== head) {
      // Another thread claimed this slot, try again
      return this.pop();
    }

    // Read data from buffer
    const offset = head * this.itemSize;
    const data = this.buffer.slice(offset, offset + this.itemSize);

    // Find actual data length (stop at first null byte)
    let length = this.itemSize;
    for (let i = 0; i < this.itemSize; i++) {
      if (data[i] === 0) {
        length = i;
        break;
      }
    }

    // Decrement count
    Atomics.sub(this.metadata, RingBuffer.COUNT, 1);

    return data.slice(0, length);
  }

  /**
   * Pop all available items (batch operation)
   */
  popAll(maxItems = 1000): Uint8Array[] {
    const items: Uint8Array[] = [];
    
    for (let i = 0; i < maxItems; i++) {
      const item = this.pop();
      if (item === null) break;
      items.push(item);
    }

    return items;
  }

  /**
   * Get current count
   */
  length(): number {
    return Atomics.load(this.metadata, RingBuffer.COUNT);
  }

  /**
   * Check if empty
   */
  isEmpty(): boolean {
    return this.length() === 0;
  }

  /**
   * Check if full
   */
  isFull(): boolean {
    return this.length() >= this.capacity;
  }

  /**
   * Get utilization (0-1)
   */
  utilization(): number {
    return this.length() / this.capacity;
  }
}

/**
 * Message queue for JSON messages (convenience wrapper)
 */
export class MessageQueue {
  private buffer: RingBuffer;
  private maxMessageSize: number;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(capacity = 10000, maxMessageSize = 65536) {
    this.maxMessageSize = maxMessageSize;
    this.buffer = new RingBuffer(capacity, maxMessageSize, true);
  }

  /**
   * Push JSON message
   */
  push(message: unknown): boolean {
    const json = JSON.stringify(message);
    const data = this.encoder.encode(json);
    
    if (data.length > this.maxMessageSize) {
      throw new Error(`Message too large: ${data.length} bytes`);
    }

    return this.buffer.push(data);
  }

  /**
   * Pop JSON message
   */
  pop(): unknown | null {
    const data = this.buffer.pop();
    if (data === null) return null;

    const json = this.decoder.decode(data);
    return JSON.parse(json);
  }

  /**
   * Pop all messages
   */
  popAll(maxItems = 1000): unknown[] {
    const dataItems = this.buffer.popAll(maxItems);
    return dataItems.map((data) => {
      const json = this.decoder.decode(data);
      return JSON.parse(json);
    });
  }

  /**
   * Get queue stats
   */
  stats() {
    return {
      length: this.buffer.length(),
      capacity: this.buffer.capacity,
      utilization: this.buffer.utilization(),
      empty: this.buffer.isEmpty(),
      full: this.buffer.isFull(),
    };
  }
}
