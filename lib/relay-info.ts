import type { RedisClientType } from "redis";

/**
 * NIP-11 Relay Information Document
 * Provides relay metadata and capabilities to clients
 */

export interface RelayInformation {
  name?: string;
  description?: string;
  pubkey?: string;
  contact?: string;
  supported_nips: number[];
  software: string;
  version: string;
  icon?: string;
  banner?: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_limit?: number;
    max_subid_length?: number;
    max_event_tags?: number;
    max_content_length?: number;
    min_pow_difficulty?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
    created_at_lower_limit?: number;
    created_at_upper_limit?: number;
    default_limit?: number;
  };
  retention?: Array<{
    kinds?: Array<number | [number, number]>;
    time?: number | null;
    count?: number;
  }>;
  relay_countries?: string[];
  language_tags?: string[];
  tags?: string[];
  posting_policy?: string;
  payments_url?: string;
  fees?: {
    admission?: Array<{ amount: number; unit: string }>;
    subscription?: Array<{
      amount: number;
      unit: string;
      period: number;
    }>;
    publication?: Array<{
      kinds: number[];
      amount: number;
      unit: string;
    }>;
  };
}

/**
 * Get relay information document (NIP-11)
 */
export async function getRelayInformation(
  redis: RedisClientType,
  staticInfo: Partial<RelayInformation> = {},
): Promise<RelayInformation> {
  // Get dynamic metadata from Redis (set via NIP-86)
  const name = await redis.get("relay:metadata:name");
  const description = await redis.get("relay:metadata:description");
  const icon = await redis.get("relay:metadata:icon");

  // Build the relay information document
  const info: RelayInformation = {
    // Dynamic fields from NIP-86 management API
    name: name || staticInfo.name,
    description: description || staticInfo.description,
    icon: icon || staticInfo.icon,

    // Static configuration
    pubkey: staticInfo.pubkey,
    contact: staticInfo.contact,
    banner: staticInfo.banner,
    posting_policy: staticInfo.posting_policy,
    payments_url: staticInfo.payments_url,
    relay_countries: staticInfo.relay_countries,
    language_tags: staticInfo.language_tags,
    tags: staticInfo.tags,
    fees: staticInfo.fees,

    // Software information
    software: "https://github.com/lez/otherstuff-relay",
    version: "1.0.0",

    // Supported NIPs
    supported_nips: [
      1, // Basic protocol flow
      9, // Event deletion
      11, // Relay information document
      50, // Full-text search
      86, // Relay management API
      98, // HTTP authentication
    ],

    // Server limitations
    limitation: {
      max_message_length: 500000, // 500KB max message
      max_subscriptions: 300, // Max 300 subscriptions per connection
      max_limit: 5000, // Max 5000 events per filter
      max_subid_length: 100, // Max subscription ID length
      max_event_tags: 100, // Max tags per event
      max_content_length: 500000, // Max content length
      min_pow_difficulty: 0, // No PoW required
      auth_required: false, // No NIP-42 auth required
      payment_required: false, // No payment required
      restricted_writes: false, // Public relay (unless configured otherwise)
      created_at_lower_limit: 0, // No lower limit on created_at
      created_at_upper_limit: Math.floor(Date.now() / 1000) + 3600, // 1 hour in future
      default_limit: 500, // Default limit if not specified
      ...staticInfo.limitation,
    },

    // Event retention (can be customized)
    retention: staticInfo.retention || [
      // Ephemeral events not stored
      { kinds: [[20000, 29999]], time: 0 },
      // Regular events stored indefinitely
      { time: null },
    ],
  };

  // Check if relay has restricted writes (allowlist/banlist configured)
  const hasAllowedPubkeys = await redis.hLen("relay:allowed:pubkeys") > 0;
  const hasAllowedKinds = await redis.sCard("relay:allowed:kinds") > 0;
  const hasBannedPubkeys = await redis.hLen("relay:banned:pubkeys") > 0;

  if (hasAllowedPubkeys || hasAllowedKinds || hasBannedPubkeys) {
    info.limitation!.restricted_writes = true;
  }

  return info;
}
