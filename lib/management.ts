import type { RedisClientType } from "redis";
import type { NRelay } from "@nostrify/nostrify";

/**
 * NIP-86 Relay Management
 * Handles relay management state and operations
 */

export interface BannedPubkey {
  pubkey: string;
  reason?: string;
}

export interface AllowedPubkey {
  pubkey: string;
  reason?: string;
}

export interface BannedEvent {
  id: string;
  reason?: string;
}

export interface BlockedIP {
  ip: string;
  reason?: string;
}

/**
 * Management operations for NIP-86
 *
 * The relay parameter is optional:
 * - When provided: ban operations will DELETE events from the database
 * - When omitted: ban operations only record the ban in Redis (deletion must be handled separately)
 *
 * Usage:
 * - Server: Creates without relay (queues deletion operations to management-worker)
 * - Relay-worker: Creates with relay (can enforce bans during validation)
 * - Management-worker: Creates with relay (performs actual deletions)
 */
export class RelayManagement {
  private redis: RedisClientType;
  private relay?: NRelay;

  constructor(redis: RedisClientType, relay?: NRelay) {
    this.redis = redis;
    this.relay = relay;
  }

  // ============================================================================
  // Pubkey Management
  // ============================================================================

  /**
   * Ban a pubkey from publishing events
   *
   * This will DELETE all existing events from that pubkey in the database
   * and record the ban in Redis to prevent future insertions.
   *
   * Requires a relay to be provided to the constructor. If no relay is available,
   * this method will throw an error.
   *
   * @param pubkey - The pubkey to ban (hex format)
   * @param reason - Optional reason for the ban
   * @returns true if successful
   * @throws Error if no relay is available for deletion
   */
  async banPubkey(pubkey: string, reason?: string): Promise<boolean> {
    // Relay is required for deletion
    if (!this.relay || !this.relay.remove) {
      throw new Error(
        "Cannot ban pubkey: relay not available for deletion. " +
          "Use RelayManagement with a relay instance, or call recordBanPubkey() to only record the ban.",
      );
    }

    // Delete all events from this pubkey
    try {
      await this.relay.remove([{ authors: [pubkey] }]);
      console.log(`🗑️  Deleted all events from banned pubkey: ${pubkey}`);
    } catch (error) {
      console.error(
        `Failed to delete events from banned pubkey ${pubkey}:`,
        error,
      );
      throw error; // Don't record ban if deletion fails
    }

    // Record the ban in Redis
    await this.redis.hSet(
      "relay:banned:pubkeys",
      pubkey,
      reason || "",
    );
    return true;
  }

  /**
   * Record a pubkey ban in Redis without deleting events
   *
   * This is useful when deletion is handled separately (e.g., by a management worker)
   * or when you only want to prevent future insertions without deleting existing events.
   *
   * @param pubkey - The pubkey to ban (hex format)
   * @param reason - Optional reason for the ban
   * @returns true if successful
   */
  async recordBanPubkey(pubkey: string, reason?: string): Promise<boolean> {
    await this.redis.hSet(
      "relay:banned:pubkeys",
      pubkey,
      reason || "",
    );
    return true;
  }

  async listBannedPubkeys(): Promise<BannedPubkey[]> {
    const banned = await this.redis.hGetAll("relay:banned:pubkeys");
    return Object.entries(banned).map(([pubkey, reason]) => ({
      pubkey,
      reason: (reason as string) || undefined,
    }));
  }

  async allowPubkey(pubkey: string, reason?: string): Promise<boolean> {
    await this.redis.hSet(
      "relay:allowed:pubkeys",
      pubkey,
      reason || "",
    );
    return true;
  }

  async listAllowedPubkeys(): Promise<AllowedPubkey[]> {
    const allowed = await this.redis.hGetAll("relay:allowed:pubkeys");
    return Object.entries(allowed).map(([pubkey, reason]) => ({
      pubkey,
      reason: (reason as string) || undefined,
    }));
  }

  async isPubkeyBanned(pubkey: string): Promise<boolean> {
    const result = await this.redis.hExists("relay:banned:pubkeys", pubkey);
    return result === 1;
  }

  async isPubkeyAllowed(pubkey: string): Promise<boolean> {
    // If allowlist is empty, all pubkeys are allowed
    const allowlistSize = await this.redis.hLen("relay:allowed:pubkeys");
    if (allowlistSize === 0) {
      return true;
    }
    const result = await this.redis.hExists("relay:allowed:pubkeys", pubkey);
    return result === 1;
  }

  // ============================================================================
  // Event Management
  // ============================================================================

  /**
   * Ban a specific event by ID
   *
   * This will DELETE the event from the database and record the ban in Redis
   * to prevent future insertions.
   *
   * Requires a relay to be provided to the constructor. If no relay is available,
   * this method will throw an error.
   *
   * @param id - The event ID to ban (hex format)
   * @param reason - Optional reason for the ban
   * @returns true if successful
   * @throws Error if no relay is available for deletion
   */
  async banEvent(id: string, reason?: string): Promise<boolean> {
    // Relay is required for deletion
    if (!this.relay || !this.relay.remove) {
      throw new Error(
        "Cannot ban event: relay not available for deletion. " +
          "Use RelayManagement with a relay instance, or call recordBanEvent() to only record the ban.",
      );
    }

    // Delete the event
    try {
      await this.relay.remove([{ ids: [id] }]);
      console.log(`🗑️  Deleted banned event: ${id}`);
    } catch (error) {
      console.error(`Failed to delete banned event ${id}:`, error);
      throw error; // Don't record ban if deletion fails
    }

    // Record the ban in Redis
    await this.redis.hSet(
      "relay:banned:events",
      id,
      reason || "",
    );
    return true;
  }

  /**
   * Record an event ban in Redis without deleting the event
   *
   * This is useful when deletion is handled separately (e.g., by a management worker)
   * or when you only want to prevent future insertions without deleting the existing event.
   *
   * @param id - The event ID to ban (hex format)
   * @param reason - Optional reason for the ban
   * @returns true if successful
   */
  async recordBanEvent(id: string, reason?: string): Promise<boolean> {
    await this.redis.hSet(
      "relay:banned:events",
      id,
      reason || "",
    );
    return true;
  }

  async allowEvent(id: string): Promise<boolean> {
    await this.redis.hDel("relay:banned:events", id);
    return true;
  }

  async listBannedEvents(): Promise<BannedEvent[]> {
    const banned = await this.redis.hGetAll("relay:banned:events");
    return Object.entries(banned).map(([id, reason]) => ({
      id,
      reason: (reason as string) || undefined,
    }));
  }

  async isEventBanned(id: string): Promise<boolean> {
    const result = await this.redis.hExists("relay:banned:events", id);
    return result === 1;
  }

  // ============================================================================
  // Kind Management
  // ============================================================================

  async allowKind(kind: number): Promise<boolean> {
    await this.redis.sAdd("relay:allowed:kinds", kind.toString());
    return true;
  }

  async disallowKind(kind: number): Promise<boolean> {
    await this.redis.sRem("relay:allowed:kinds", kind.toString());
    return true;
  }

  async listAllowedKinds(): Promise<number[]> {
    const kinds = await this.redis.sMembers("relay:allowed:kinds");
    return kinds.map((k: string) => parseInt(k, 10)).sort(
      (a: number, b: number) => a - b,
    );
  }

  async isKindAllowed(kind: number): Promise<boolean> {
    // If allowlist is empty, all kinds are allowed
    const allowlistSize = await this.redis.sCard("relay:allowed:kinds");
    if (allowlistSize === 0) {
      return true;
    }
    const result = await this.redis.sIsMember(
      "relay:allowed:kinds",
      kind.toString(),
    );
    return result === 1;
  }

  // ============================================================================
  // IP Management
  // ============================================================================

  async blockIP(ip: string, reason?: string): Promise<boolean> {
    await this.redis.hSet(
      "relay:blocked:ips",
      ip,
      reason || "",
    );
    return true;
  }

  async unblockIP(ip: string): Promise<boolean> {
    await this.redis.hDel("relay:blocked:ips", ip);
    return true;
  }

  async listBlockedIPs(): Promise<BlockedIP[]> {
    const blocked = await this.redis.hGetAll("relay:blocked:ips");
    return Object.entries(blocked).map(([ip, reason]) => ({
      ip,
      reason: (reason as string) || undefined,
    }));
  }

  async isIPBlocked(ip: string): Promise<boolean> {
    const result = await this.redis.hExists("relay:blocked:ips", ip);
    return result === 1;
  }

  // ============================================================================
  // Relay Metadata
  // ============================================================================

  async setRelayName(name: string): Promise<boolean> {
    await this.redis.set("relay:metadata:name", name);
    return true;
  }

  async getRelayName(): Promise<string | null> {
    return await this.redis.get("relay:metadata:name");
  }

  async setRelayDescription(description: string): Promise<boolean> {
    await this.redis.set("relay:metadata:description", description);
    return true;
  }

  async getRelayDescription(): Promise<string | null> {
    return await this.redis.get("relay:metadata:description");
  }

  async setRelayIcon(icon: string): Promise<boolean> {
    await this.redis.set("relay:metadata:icon", icon);
    return true;
  }

  async getRelayIcon(): Promise<string | null> {
    return await this.redis.get("relay:metadata:icon");
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get all supported NIP-86 methods
   */
  getSupportedMethods(): string[] {
    return [
      "supportedmethods",
      "banpubkey",
      "listbannedpubkeys",
      "allowpubkey",
      "listallowedpubkeys",
      "banevent",
      "allowevent",
      "listbannedevents",
      "allowkind",
      "disallowkind",
      "listallowedkinds",
      "blockip",
      "unblockip",
      "listblockedips",
      "changerelayname",
      "changerelaydescription",
      "changerelayicon",
    ];
  }
}
