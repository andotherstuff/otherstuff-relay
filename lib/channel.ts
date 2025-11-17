/**
 * High-performance in-memory message channels
 * Replaces Redis queues for inter-worker communication
 */

export interface Message<T> {
  data: T;
  timestamp: number;
}

/**
 * Fast in-memory FIFO queue with backpressure
 */
export class Channel<T> {
  private queue: T[] = [];
  private waiters: Array<(value: T[]) => void> = [];
  private closed = false;
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  /**
   * Push item to queue (non-blocking)
   * Returns false if queue is full (backpressure signal)
   */
  push(item: T): boolean {
    if (this.closed) {
      throw new Error("Channel is closed");
    }

    this.queue.push(item);

    // Wake up any waiting consumers
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      const batch = this.queue.splice(0, Math.min(100, this.queue.length));
      waiter(batch);
    }

    // Signal backpressure if queue is too large
    return this.queue.length < this.maxSize;
  }

  /**
   * Push multiple items at once
   */
  pushBatch(items: T[]): boolean {
    if (this.closed) {
      throw new Error("Channel is closed");
    }

    this.queue.push(...items);

    // Wake up waiters
    while (this.waiters.length > 0 && this.queue.length > 0) {
      const waiter = this.waiters.shift()!;
      const batch = this.queue.splice(0, Math.min(100, this.queue.length));
      waiter(batch);
    }

    return this.queue.length < this.maxSize;
  }

  /**
   * Pop up to `count` items (blocking if queue is empty)
   * Returns immediately if items are available
   * Waits up to `timeoutMs` if queue is empty
   */
  pop(count = 1, timeoutMs = 1000): Promise<T[]> {
    if (this.closed && this.queue.length === 0) {
      return Promise.resolve([]);
    }

    // Fast path: items already available
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.splice(0, Math.min(count, this.queue.length)));
    }

    // Slow path: wait for items
    return new Promise<T[]>((resolve) => {
      const timeout = setTimeout(() => {
        // Remove this waiter from the list
        const idx = this.waiters.indexOf(resolve);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        resolve([]);
      }, timeoutMs);

      this.waiters.push((items: T[]) => {
        clearTimeout(timeout);
        resolve(items);
      });
    });
  }

  /**
   * Get current queue length
   */
  length(): number {
    return this.queue.length;
  }

  /**
   * Close the channel
   */
  close(): void {
    this.closed = true;
    // Wake up all waiters with empty array
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter([]);
    }
  }

  /**
   * Check if channel is closed
   */
  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Broadcast channel for one-to-many communication
 */
export class BroadcastChannel<T> {
  private subscribers: Set<(item: T) => void> = new Set();

  /**
   * Subscribe to messages
   * Returns unsubscribe function
   */
  subscribe(handler: (item: T) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /**
   * Broadcast message to all subscribers
   */
  broadcast(item: T): void {
    for (const handler of this.subscribers) {
      try {
        handler(item);
      } catch (err) {
        console.error("Broadcast handler error:", err);
      }
    }
  }

  /**
   * Get subscriber count
   */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Clear all subscribers
   */
  clear(): void {
    this.subscribers.clear();
  }
}

/**
 * Response router for connection-specific responses
 */
export class ResponseRouter {
  // deno-lint-ignore no-explicit-any
  private routes: Map<string, Channel<any>> = new Map();

  /**
   * Get or create a response channel for a connection
   */
  getChannel<T>(connId: string): Channel<T> {
    if (!this.routes.has(connId)) {
      this.routes.set(connId, new Channel<T>(1000));
    }
    return this.routes.get(connId) as Channel<T>;
  }

  /**
   * Remove a connection's response channel
   */
  removeChannel(connId: string): void {
    const channel = this.routes.get(connId);
    if (channel) {
      channel.close();
      this.routes.delete(connId);
    }
  }

  /**
   * Send response to a specific connection
   */
  send<T>(connId: string, message: T): boolean {
    const channel = this.getChannel<T>(connId);
    return channel.push(message);
  }

  /**
   * Get stats
   */
  stats(): { connections: number; totalQueued: number } {
    let totalQueued = 0;
    for (const channel of this.routes.values()) {
      totalQueued += channel.length();
    }
    return {
      connections: this.routes.size,
      totalQueued,
    };
  }
}
