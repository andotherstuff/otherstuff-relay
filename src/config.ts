/**
 * Configuration class for the Nostr relay server
 */
export class Config {
  public readonly port: number;
  public readonly databaseUrl: string;
  public readonly redisUrl: string;
  public readonly broadcastMaxAge: number;
  public readonly hotEventsTtl: number;

  constructor(env: { get(key: string): string | undefined }) {
    this.port = parseInt(env.get("PORT") || "8000");
    this.databaseUrl = env.get("DATABASE_URL") || "http://localhost:8123/nostr";
    this.redisUrl = env.get("REDIS_URL") || "redis://localhost:6379";
    // Default to 5 minutes (300 seconds), 0 means no age limit
    this.broadcastMaxAge = parseInt(env.get("BROADCAST_MAX_AGE") || "300");
    // Default to 1 hour (3600 seconds) for hot events in Redis
    this.hotEventsTtl = parseInt(env.get("HOT_EVENTS_TTL") || "3600");
  }
}
