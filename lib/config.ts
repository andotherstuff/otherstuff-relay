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

  constructor(env: { get(key: string): string | undefined }) {
    this.port = parseInt(env.get("PORT") || "8000");
    this.opensearchUrl = env.get("OPENSEARCH_URL") ||
      "http://localhost:9200";
    this.opensearchUsername = env.get("OPENSEARCH_USERNAME");
    this.opensearchPassword = env.get("OPENSEARCH_PASSWORD");
    this.redisUrl = env.get("REDIS_URL") || "redis://localhost:6379";
    // Default to 5 minutes (300 seconds), 0 means no age limit
    this.broadcastMaxAge = parseInt(env.get("BROADCAST_MAX_AGE") || "300");
  }
}
