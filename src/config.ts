/**
 * Configuration class for the Nostr relay server
 */
export class Config {
  public readonly port: number;
  public readonly clickhouse: {
    host: string;
    httpPort: number;
    port: number;
    database: string;
    user: string;
    password: string;
    poolSize: number;
  };
  public readonly verification: {
    enabled: boolean;
  };
  public readonly batching: {
    batchSize: number;
    flushInterval: number;
  };

  constructor(env: { get(key: string): string | undefined }) {
    this.port = parseInt(env.get("PORT") || "8000");

    const databaseUrl = env.get("DATABASE_URL") ||
      "clickhouse://localhost/nostr";
    this.clickhouse = this.parseClickHouseUrl(databaseUrl);

    this.verification = {
      enabled: env.get("NO_VERIFICATION") !== "false",
    };

    this.batching = {
      batchSize: parseInt(env.get("BATCH_SIZE") || "10000"),
      flushInterval: parseInt(env.get("FLUSH_INTERVAL") || "50"),
    };
  }

  /**
   * Parse ClickHouse connection URL
   * Format: clickhouse://[user[:password]@]host[:port]/database
   * Examples:
   *   clickhouse://localhost/nostr
   *   clickhouse://default:password@localhost:8123/nostr
   *   clickhouse://user@clickhouse.example.com:9000/mydb
   */
  private parseClickHouseUrl(url: string) {
    const defaultConfig = {
      host: "localhost",
      httpPort: 8123,
      port: 9000,
      database: "nostr",
      user: "default",
      password: "",
      poolSize: 10,
    };

    try {
      const parsed = new URL(url);

      if (parsed.protocol !== "clickhouse:") {
        throw new Error("URL must use clickhouse:// protocol");
      }

      return {
        host: parsed.hostname || defaultConfig.host,
        httpPort: parsed.port ? parseInt(parsed.port) : defaultConfig.httpPort,
        port: parsed.port ? parseInt(parsed.port) : defaultConfig.port,
        database: parsed.pathname.replace(/^\//, "") || defaultConfig.database,
        user: parsed.username || defaultConfig.user,
        password: parsed.password || defaultConfig.password,
        poolSize: defaultConfig.poolSize,
      };
    } catch (error) {
      console.error("Failed to parse DATABASE_URL:", error);
      console.log("Using default ClickHouse configuration");
      return defaultConfig;
    }
  }
}
