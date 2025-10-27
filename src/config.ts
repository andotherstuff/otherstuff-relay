/**
 * Configuration class for the Nostr relay server
 */
export class Config {
  public readonly port: number;
  public readonly databaseUrl?: string;

  constructor(env: { get(key: string): string | undefined }) {
    this.port = parseInt(env.get("PORT") || "8000");

    this.databaseUrl = env.get("DATABASE_URL") || undefined;
  }
}
