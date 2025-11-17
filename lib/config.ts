/**
 * Configuration class for the Nostr relay server
 */
export class Config {
  public readonly port: number;
  public readonly opensearchUrl: string;
  public readonly opensearchUsername?: string;
  public readonly opensearchPassword?: string;
  public readonly redisUrl: string;
  public readonly broadcastMaxAge: number;
  public readonly adminPubkeys: string[];
  public readonly relayName?: string;
  public readonly relayDescription?: string;
  public readonly relayIcon?: string;
  public readonly relayPubkey?: string;
  public readonly relayContact?: string;
  public readonly relayBanner?: string;
  public readonly relayUrl?: string;

  constructor(env: { get(key: string): string | undefined }) {
    this.port = parseInt(env.get("PORT") || "8000");
    this.opensearchUrl = env.get("OPENSEARCH_URL") ||
      "http://localhost:9200";
    this.opensearchUsername = env.get("OPENSEARCH_USERNAME");
    this.opensearchPassword = env.get("OPENSEARCH_PASSWORD");
    this.redisUrl = env.get("REDIS_URL") || "redis://localhost:6379";
    // Default to 5 minutes (300 seconds), 0 means no age limit
    this.broadcastMaxAge = parseInt(env.get("BROADCAST_MAX_AGE") || "300");
    // Relay URL for NIP-98 authentication (optional, defaults to request URL)
    this.relayUrl = env.get("RELAY_URL");

    // NIP-86 Management API
    const adminPubkeysStr = env.get("ADMIN_PUBKEYS") || "";
    this.adminPubkeys = adminPubkeysStr
      .split(",")
      .map((pk) => pk.trim())
      .filter((pk) => pk.length > 0);

    // NIP-11 Relay Information (can also be set via NIP-86)
    this.relayName = env.get("RELAY_NAME");
    this.relayDescription = env.get("RELAY_DESCRIPTION");
    this.relayIcon = env.get("RELAY_ICON");
    this.relayPubkey = env.get("RELAY_PUBKEY");
    this.relayContact = env.get("RELAY_CONTACT");
    this.relayBanner = env.get("RELAY_BANNER");
  }
}
