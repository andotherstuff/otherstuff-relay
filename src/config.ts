/**
 * Configuration class for the Nostr relay server
 */
export class Config {
  public readonly port: number;
  public readonly databaseUrl?: string;
  public readonly verification: {
    enabled: boolean;
  };
  public readonly batching: {
    batchSize: number;
    flushInterval: number;
  };

  constructor(env: { get(key: string): string | undefined }) {
    this.port = parseInt(env.get("PORT") || "8000");

    this.databaseUrl = env.get("DATABASE_URL") || undefined;

    this.verification = {
      enabled: env.get("NO_VERIFICATION") !== "false",
    };

    this.batching = {
      batchSize: parseInt(env.get("BATCH_SIZE") || "10000"),
      flushInterval: parseInt(env.get("FLUSH_INTERVAL") || "50"),
    };
  }
}
