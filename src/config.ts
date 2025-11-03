/**
 * Configuration class for the Nostr relay server
 */
export class Config {
  public readonly port: number;
  public readonly databaseUrl: string;
  public readonly redisUrl: string;
  public readonly relaySource: string;

  constructor(env: { get(key: string): string | undefined }) {
    this.port = parseInt(env.get("PORT") || "8000");
    this.databaseUrl = env.get("DATABASE_URL") || "http://localhost:8123/nostr";
    this.redisUrl = env.get("REDIS_URL") || "redis://localhost:6379";
    this.relaySource = env.get("RELAY_SOURCE") || "";
  }
}
