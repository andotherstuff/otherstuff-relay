let connections = 0;
let eventsReceived = 0;
let eventsStored = 0;
let eventsFailed = 0;
let queries = 0;
let subscriptions = 0;

export const metrics = {
  connections: {
    inc: () => connections++,
    dec: () => connections--,
    get: () => connections,
  },
  events: {
    received: () => eventsReceived++,
    stored: () => eventsStored++,
    failed: () => eventsFailed++,
    getReceived: () => eventsReceived,
    getStored: () => eventsStored,
    getFailed: () => eventsFailed,
  },
  queries: {
    inc: () => queries++,
    get: () => queries,
  },
  subscriptions: {
    inc: () => subscriptions++,
    dec: () => subscriptions--,
    get: () => subscriptions,
  },
};

export async function getMetrics(): Promise<string> {
  return `
# HELP nostr_connections_active Current WebSocket connections
# TYPE nostr_connections_active gauge
nostr_connections_active ${connections}

# HELP nostr_events_received Total events received
# TYPE nostr_events_received counter
nostr_events_received ${eventsReceived}

# HELP nostr_events_stored Total events successfully stored
# TYPE nostr_events_stored counter
nostr_events_stored ${eventsStored}

# HELP nostr_events_failed Total events failed to store
# TYPE nostr_events_failed counter
nostr_events_failed ${eventsFailed}

# HELP nostr_queries_total Total queries processed
# TYPE nostr_queries_total counter
nostr_queries_total ${queries}

# HELP nostr_subscriptions_active Current active subscriptions
# TYPE nostr_subscriptions_active gauge
nostr_subscriptions_active ${subscriptions}
  `.trim();
}