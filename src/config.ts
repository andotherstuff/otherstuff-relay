export const config = {
  port: parseInt(Deno.env.get('PORT') || '8000'),
  
  clickhouse: {
    host: Deno.env.get('CLICKHOUSE_HOST') || 'localhost',
    port: parseInt(Deno.env.get('CLICKHOUSE_PORT') || '9000'),
    database: Deno.env.get('CLICKHOUSE_DATABASE') || 'nostr',
    user: Deno.env.get('CLICKHOUSE_USER') || 'default',
    password: Deno.env.get('CLICKHOUSE_PASSWORD') || '',
    poolSize: parseInt(Deno.env.get('CLICKHOUSE_POOL_SIZE') || '10'),
  },

  verification: {
    enabled: Deno.env.get('NO_VERIFICATION') !== 'false',
  },

  metrics: {
    enabled: Deno.env.get('METRICS_ENABLED') !== 'false',
    path: '/metrics',
  },
};