/**
 * Parse ClickHouse connection URL
 * Format: clickhouse://[user[:password]@]host[:port]/database
 * Examples:
 *   clickhouse://localhost/nostr
 *   clickhouse://default:password@localhost:8123/nostr
 *   clickhouse://user@clickhouse.example.com:9000/mydb
 */
function parseClickHouseUrl(url: string) {
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

const databaseUrl = Deno.env.get("DATABASE_URL") ||
  "clickhouse://localhost/nostr";

export const config = {
  port: parseInt(Deno.env.get("PORT") || "8000"),
  clickhouse: parseClickHouseUrl(databaseUrl),
  verification: {
    enabled: Deno.env.get("NO_VERIFICATION") !== "false",
  },
  metrics: {
    enabled: Deno.env.get("METRICS_ENABLED") !== "false",
    path: "/metrics",
  },
};
