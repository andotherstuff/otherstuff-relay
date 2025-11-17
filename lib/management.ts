import type { RedisClientType } from "redis";

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
 */
export class RelayManagement {
  private redis: RedisClientType;

  constructor(redis: RedisClientType) {
    this.redis = redis;
  }

  // ============================================================================
  // Pubkey Management
  // ============================================================================

  async banPubkey(pubkey: string, reason?: string): Promise<boolean> {
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

  async banEvent(id: string, reason?: string): Promise<boolean> {
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
