/**
 * IMMORTAL QUEUE - A queue that can NEVER die
 * 
 * Features:
 * - Adaptive backpressure (slows down instead of dying)
 * - Circuit breaker (auto-recovery from overload)
 * - Priority queuing (important messages first)
 * - Rate limiting per connection
 * - Sync queue tracking (no race conditions)
 * - Graceful degradation
 */

export enum Priority {
  CRITICAL = 0,  // AUTH, CLOSE - always process
  HIGH = 1,      // REQ - queries should be fast
  NORMAL = 2,    // EVENT - can wait
  LOW = 3,       // Bulk operations
}

export interface QueuedMessage<T> {
  data: T;
  priority: Priority;
  timestamp: number;
  connId: string;
}

export enum QueueState {
  HEALTHY = "healthy",       // < 50% capacity
  DEGRADED = "degraded",     // 50-80% capacity
  OVERLOADED = "overloaded", // 80-95% capacity
  CRITICAL = "critical",     // > 95% capacity
}

export interface QueueStats {
  state: QueueState;
  length: number;
  capacity: number;
  utilization: number;
  droppedMessages: number;
  processedMessages: number;
  avgProcessingTime: number;
}

/**
 * Immortal queue with adaptive backpressure
 */
export class ImmortalQueue<T> {
  private queues: Map<Priority, QueuedMessage<T>[]> = new Map([
    [Priority.CRITICAL, []],
    [Priority.HIGH, []],
    [Priority.NORMAL, []],
    [Priority.LOW, []],
  ]);

  private capacity: number;
  private droppedMessages = 0;
  private processedMessages = 0;
  private processingTimes: number[] = [];
  private maxProcessingTimes = 1000;

  // Rate limiting per connection
  private connectionRates: Map<string, {
    count: number;
    lastReset: number;
    blocked: boolean;
  }> = new Map();

  private rateLimit = 100; // messages per second per connection
  private rateLimitWindow = 1000; // 1 second

  // Circuit breaker
  private circuitOpen = false;
  private circuitOpenUntil = 0;
  private circuitBreakerThreshold = 0.95; // 95% capacity
  private circuitBreakerCooldown = 5000; // 5 seconds

  constructor(capacity = 100000) {
    this.capacity = capacity;
  }

  /**
   * Get current queue state (sync, no async calls)
   */
  getState(): QueueState {
    const utilization = this.getUtilization();
    
    if (utilization < 0.5) return QueueState.HEALTHY;
    if (utilization < 0.8) return QueueState.DEGRADED;
    if (utilization < 0.95) return QueueState.OVERLOADED;
    return QueueState.CRITICAL;
  }

  /**
   * Get queue length (sync)
   */
  length(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Get utilization (0-1)
   */
  getUtilization(): number {
    return this.length() / this.capacity;
  }

  /**
   * Check if connection is rate limited
   */
  private isRateLimited(connId: string): boolean {
    const now = Date.now();
    let info = this.connectionRates.get(connId);

    if (!info) {
      info = { count: 0, lastReset: now, blocked: false };
      this.connectionRates.set(connId, info);
    }

    // Reset counter if window expired
    if (now - info.lastReset > this.rateLimitWindow) {
      info.count = 0;
      info.lastReset = now;
      info.blocked = false;
    }

    // Check rate limit
    if (info.count >= this.rateLimit) {
      info.blocked = true;
      return true;
    }

    info.count++;
    return false;
  }

  /**
   * Check circuit breaker
   */
  private checkCircuitBreaker(): boolean {
    const now = Date.now();

    // Circuit is open (rejecting requests)
    if (this.circuitOpen) {
      if (now < this.circuitOpenUntil) {
        return true; // Still open
      } else {
        // Cooldown expired, close circuit
        this.circuitOpen = false;
        console.log("🔧 Circuit breaker CLOSED - accepting requests again");
        return false;
      }
    }

    // Check if we should open circuit
    const utilization = this.getUtilization();
    if (utilization > this.circuitBreakerThreshold) {
      this.circuitOpen = true;
      this.circuitOpenUntil = now + this.circuitBreakerCooldown;
      console.warn(
        `⚡ Circuit breaker OPEN - queue at ${(utilization * 100).toFixed(1)}% capacity`,
      );
      return true;
    }

    return false;
  }

  /**
   * Push message to queue with adaptive backpressure
   * Returns: { accepted: boolean, reason?: string, state: QueueState }
   */
  push(
    data: T,
    connId: string,
    priority: Priority = Priority.NORMAL,
  ): { accepted: boolean; reason?: string; state: QueueState } {
    const state = this.getState();

    // Check circuit breaker first
    if (this.checkCircuitBreaker()) {
      this.droppedMessages++;
      return {
        accepted: false,
        reason: "circuit breaker open - relay recovering from overload",
        state,
      };
    }

    // Check rate limiting
    if (this.isRateLimited(connId)) {
      this.droppedMessages++;
      return {
        accepted: false,
        reason: "rate limited - too many messages from this connection",
        state,
      };
    }

    // Adaptive backpressure based on state
    switch (state) {
      case QueueState.HEALTHY:
        // Accept everything
        break;

      case QueueState.DEGRADED:
        // Drop LOW priority messages
        if (priority === Priority.LOW) {
          this.droppedMessages++;
          return {
            accepted: false,
            reason: "low priority messages dropped - queue degraded",
            state,
          };
        }
        break;

      case QueueState.OVERLOADED:
        // Drop LOW and NORMAL priority messages
        if (priority === Priority.LOW || priority === Priority.NORMAL) {
          this.droppedMessages++;
          return {
            accepted: false,
            reason: "non-critical messages dropped - queue overloaded",
            state,
          };
        }
        break;

      case QueueState.CRITICAL:
        // Only accept CRITICAL priority
        if (priority !== Priority.CRITICAL) {
          this.droppedMessages++;
          return {
            accepted: false,
            reason: "only critical messages accepted - queue critical",
            state,
          };
        }
        break;
    }

    // Check hard capacity limit
    if (this.length() >= this.capacity) {
      this.droppedMessages++;
      return {
        accepted: false,
        reason: "queue at maximum capacity",
        state,
      };
    }

    // Accept the message
    const queue = this.queues.get(priority)!;
    queue.push({
      data,
      priority,
      timestamp: Date.now(),
      connId,
    });

    return { accepted: true, state };
  }

  /**
   * Pop messages from queue (highest priority first)
   */
  pop(count = 1): QueuedMessage<T>[] {
    const results: QueuedMessage<T>[] = [];
    const startTime = performance.now();

    // Pop from queues in priority order
    for (const priority of [Priority.CRITICAL, Priority.HIGH, Priority.NORMAL, Priority.LOW]) {
      const queue = this.queues.get(priority)!;
      
      while (results.length < count && queue.length > 0) {
        const msg = queue.shift()!;
        results.push(msg);
      }

      if (results.length >= count) break;
    }

    // Track processing time
    if (results.length > 0) {
      const processingTime = performance.now() - startTime;
      this.processingTimes.push(processingTime);
      if (this.processingTimes.length > this.maxProcessingTimes) {
        this.processingTimes.shift();
      }
      this.processedMessages += results.length;
    }

    return results;
  }

  /**
   * Get queue statistics
   */
  getStats(): QueueStats {
    const avgProcessingTime = this.processingTimes.length > 0
      ? this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length
      : 0;

    return {
      state: this.getState(),
      length: this.length(),
      capacity: this.capacity,
      utilization: this.getUtilization(),
      droppedMessages: this.droppedMessages,
      processedMessages: this.processedMessages,
      avgProcessingTime,
    };
  }

  /**
   * Clean up stale connection rate limiters
   */
  cleanup(maxAge = 60000): void {
    const now = Date.now();
    for (const [connId, info] of this.connectionRates) {
      if (now - info.lastReset > maxAge) {
        this.connectionRates.delete(connId);
      }
    }
  }

  /**
   * Reset circuit breaker (manual recovery)
   */
  resetCircuitBreaker(): void {
    this.circuitOpen = false;
    this.circuitOpenUntil = 0;
    console.log("🔧 Circuit breaker manually reset");
  }

  /**
   * Adjust capacity dynamically
   */
  setCapacity(newCapacity: number): void {
    this.capacity = newCapacity;
    console.log(`📊 Queue capacity adjusted to ${newCapacity}`);
  }

  /**
   * Adjust rate limit
   */
  setRateLimit(messagesPerSecond: number): void {
    this.rateLimit = messagesPerSecond;
    console.log(`⏱️  Rate limit adjusted to ${messagesPerSecond} msg/sec per connection`);
  }
}
