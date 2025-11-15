/**
 * Script to find the most popular events within a specified timeframe
 * Popularity is based on how many other events reference them via an 'e' tag
 */

import { Client } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { parseArgs } from "@std/cli/parse-args";

interface PopularEvent {
  eventId: string;
  referenceCount: number;
  event?: {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    content: string;
  };
}

/**
 * Find the most popular events within a timeframe
 */
async function findPopularEvents(
  client: Client,
  indexName: string,
  options: {
    since?: number;
    until?: number;
    limit?: number;
    includeEventData?: boolean;
  },
): Promise<PopularEvent[]> {
  const { since, until, limit = 100, includeEventData = true } = options;

  // Build the query to filter events by timeframe
  const must: Record<string, unknown>[] = [];

  if (since || until) {
    const range: Record<string, number> = {};
    if (since) range.gte = since;
    if (until) range.lte = until;
    must.push({ range: { created_at: range } });
  }

  // Only include events that have e tags
  must.push({ exists: { field: "tag_e" } });

  const query = must.length > 0
    ? { bool: { must } }
    : { exists: { field: "tag_e" } };

  // Query to aggregate e tag references
  const response = await client.search({
    index: indexName,
    body: {
      size: 0, // We don't need the actual documents, just aggregations
      query,
      aggs: {
        popular_events: {
          terms: {
            field: "tag_e",
            size: limit,
            order: { _count: "desc" },
          },
        },
      },
    },
  });

  // deno-lint-ignore no-explicit-any
  const aggregations = response.body.aggregations as any;
  const buckets = aggregations?.popular_events?.buckets || [];
  const popularEvents: PopularEvent[] = buckets.map(
    (bucket: { key: string; doc_count: number }) => ({
      eventId: bucket.key,
      referenceCount: bucket.doc_count,
    }),
  );

  // Optionally fetch the actual event data
  if (includeEventData && popularEvents.length > 0) {
    const eventIds = popularEvents.map((e) => e.eventId);

    const eventsResponse = await client.search({
      index: indexName,
      body: {
        query: {
          terms: {
            id: eventIds,
          },
        },
        size: eventIds.length,
        _source: ["id", "pubkey", "created_at", "kind", "content"],
      },
    });

    // Create a map of event data
    const eventDataMap = new Map();
    for (const hit of eventsResponse.body.hits.hits) {
      const source = hit._source;
      if (source) {
        eventDataMap.set(source.id, {
          id: source.id,
          pubkey: source.pubkey,
          created_at: source.created_at,
          kind: source.kind,
          content: source.content.substring(0, 100), // Truncate content for display
        });
      }
    }

    // Attach event data to popular events
    for (const popularEvent of popularEvents) {
      popularEvent.event = eventDataMap.get(popularEvent.eventId);
    }
  }

  return popularEvents;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Format duration in a human-readable way
 */
function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.length > 0 ? parts.join(" ") : "< 1m";
}

/**
 * Main function
 */
async function main() {
  const args = parseArgs(Deno.args, {
    string: ["since", "until", "duration"],
    boolean: ["no-event-data", "help"],
    default: {
      limit: 100,
      "no-event-data": false,
      help: false,
    },
    alias: {
      h: "help",
      s: "since",
      u: "until",
      d: "duration",
      l: "limit",
      n: "no-event-data",
    },
  });

  if (args.help) {
    console.log(`
Usage: deno task popular-events [options]

Find the most popular events based on how many times they are referenced by other events via 'e' tags.

Options:
  -s, --since <timestamp>    Start of timeframe (Unix timestamp or ISO date)
  -u, --until <timestamp>    End of timeframe (Unix timestamp or ISO date)
  -d, --duration <duration>  Duration before now (e.g., "1h", "24h", "7d", "30d")
  -l, --limit <number>       Maximum number of results (default: 100)
  -n, --no-event-data        Don't fetch event data, only show IDs and counts
  -h, --help                 Show this help message

Examples:
  # Most popular events in the last 24 hours
  deno task popular-events --duration 24h

  # Most popular events in the last 7 days, top 50
  deno task popular-events --duration 7d --limit 50

  # Most popular events between specific dates
  deno task popular-events --since 2025-11-01 --until 2025-11-15

  # Most popular events since a specific timestamp
  deno task popular-events --since 1700000000

  # Just show IDs and counts (faster)
  deno task popular-events --duration 24h --no-event-data
`);
    Deno.exit(0);
  }

  // Load configuration
  const config = new Config(Deno.env);

  // Parse timeframe
  let since: number | undefined;
  let until: number | undefined;

  if (args.duration) {
    // Parse duration string (e.g., "24h", "7d", "30d")
    const match = args.duration.match(/^(\d+)([smhd])$/);
    if (!match) {
      console.error(
        'Invalid duration format. Use format like "1h", "24h", "7d", "30d"',
      );
      Deno.exit(1);
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };

    const durationSeconds = value * multipliers[unit];
    const now = Math.floor(Date.now() / 1000);
    since = now - durationSeconds;
    until = now;
  } else {
    // Parse since/until timestamps
    if (args.since) {
      // Try to parse as Unix timestamp first, then as ISO date
      const sinceNum = parseInt(args.since);
      if (!isNaN(sinceNum)) {
        since = sinceNum;
      } else {
        const sinceDate = new Date(args.since);
        if (isNaN(sinceDate.getTime())) {
          console.error(`Invalid since timestamp: ${args.since}`);
          Deno.exit(1);
        }
        since = Math.floor(sinceDate.getTime() / 1000);
      }
    }

    if (args.until) {
      // Try to parse as Unix timestamp first, then as ISO date
      const untilNum = parseInt(args.until);
      if (!isNaN(untilNum)) {
        until = untilNum;
      } else {
        const untilDate = new Date(args.until);
        if (isNaN(untilDate.getTime())) {
          console.error(`Invalid until timestamp: ${args.until}`);
          Deno.exit(1);
        }
        until = Math.floor(untilDate.getTime() / 1000);
      }
    }
  }

  // Create OpenSearch client
  const clientConfig: {
    node: string;
    auth?: { username: string; password: string };
  } = {
    node: config.opensearchUrl,
  };

  if (config.opensearchUsername && config.opensearchPassword) {
    clientConfig.auth = {
      username: config.opensearchUsername,
      password: config.opensearchPassword,
    };
  }

  const client = new Client(clientConfig);

  try {
    // Display query parameters
    console.log("\n🔍 Finding most popular events...\n");

    if (since || until) {
      console.log("Timeframe:");
      if (since) {
        console.log(`  Since: ${formatTimestamp(since)}`);
      }
      if (until) {
        console.log(`  Until: ${formatTimestamp(until)}`);
      }
      if (since && until) {
        console.log(`  Duration: ${formatDuration(until - since)}`);
      }
    } else {
      console.log("Timeframe: All time");
    }

    console.log(`Limit: ${args.limit}`);
    console.log("");

    // Find popular events
    const popularEvents = await findPopularEvents(client, "nostr-events", {
      since,
      until,
      limit: typeof args.limit === "number" ? args.limit : 100,
      includeEventData: !args["no-event-data"],
    });

    if (popularEvents.length === 0) {
      console.log("No events found in the specified timeframe.");
      Deno.exit(0);
    }

    // Display results
    console.log(`📊 Top ${popularEvents.length} Most Popular Events:\n`);

    for (let i = 0; i < popularEvents.length; i++) {
      const { eventId, referenceCount, event } = popularEvents[i];

      console.log(`${i + 1}. Event ID: ${eventId}`);
      console.log(`   References: ${referenceCount}`);

      if (event) {
        console.log(`   Author: ${event.pubkey}`);
        console.log(`   Kind: ${event.kind}`);
        console.log(`   Created: ${formatTimestamp(event.created_at)}`);
        if (event.content && event.content.trim()) {
          // Show first 100 chars of content
          const preview = event.content.length > 100
            ? event.content.substring(0, 100) + "..."
            : event.content;
          console.log(`   Content: ${preview.replace(/\n/g, " ")}`);
        }
      } else {
        console.log(`   (Event not found in database)`);
      }

      console.log("");
    }

    console.log("✅ Done!\n");
  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  } finally {
    await client.close();
  }
}

// Run the script
if (import.meta.main) {
  main();
}
