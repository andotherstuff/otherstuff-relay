/**
 * Fix the OpenSearch index mapping by reindexing data
 * This script will:
 * 1. Create a new index with the correct mapping
 * 2. Reindex all data from the old index to the new one
 * 3. Delete the old index
 * 4. Create an alias from the old name to the new index
 */
import { Client } from "@opensearch-project/opensearch";
import { Config } from "@/lib/config.ts";

const config = new Config(Deno.env);

// OpenSearch client
interface OpenSearchConfig {
  node: string;
  auth?: {
    username: string;
    password: string;
  };
}

const opensearchConfig: OpenSearchConfig = {
  node: config.opensearchUrl,
};

// Add authentication if provided
if (config.opensearchUsername && config.opensearchPassword) {
  opensearchConfig.auth = {
    username: config.opensearchUsername,
    password: config.opensearchPassword,
  };
}

const client = new Client(opensearchConfig);

const oldIndexName = "nostr-events";
const newIndexName = "nostr-events-v2";

try {
  console.log("🔧 Starting index migration...");

  // Check if old index exists
  const oldIndexExists = await client.indices.exists({
    index: oldIndexName,
  });

  if (!oldIndexExists.body) {
    console.log(`❌ Old index ${oldIndexName} does not exist`);
    Deno.exit(1);
  }

  // Check if new index already exists
  const newIndexExists = await client.indices.exists({
    index: newIndexName,
  });

  if (newIndexExists.body) {
    console.log(`❌ New index ${newIndexName} already exists`);
    console.log("   Please delete it first or use a different name");
    Deno.exit(1);
  }

  // Create new index with correct mapping
  console.log(`\n📝 Creating new index: ${newIndexName}`);
  await client.indices.create({
    index: newIndexName,
    body: {
      settings: {
        number_of_shards: 3,
        number_of_replicas: 1,
        refresh_interval: "5s",
        "index.mapping.total_fields.limit": 2000,
        analysis: {
          analyzer: {
            nostr_content_analyzer: {
              type: "standard",
              stopwords: "_none_",
            },
          },
        },
      },
      mappings: {
        dynamic: "strict",
        properties: {
          id: {
            type: "keyword",
          },
          pubkey: {
            type: "keyword",
          },
          created_at: {
            type: "long",
          },
          kind: {
            type: "integer",
          },
          content: {
            type: "text",
            analyzer: "nostr_content_analyzer",
            fields: {
              keyword: {
                type: "keyword",
                ignore_above: 256,
              },
            },
          },
          sig: {
            type: "keyword",
          },
          tags: {
            type: "keyword",
          },
          indexed_at: {
            type: "long",
          },
          tag_e: {
            type: "keyword",
          },
          tag_p: {
            type: "keyword",
          },
          tag_a: {
            type: "keyword",
          },
          tag_d: {
            type: "keyword",
          },
          tag_t: {
            type: "keyword",
          },
          tag_r: {
            type: "keyword",
          },
          tag_g: {
            type: "keyword",
          },
          // THIS IS THE FIX: tags_flat must be nested type
          tags_flat: {
            type: "nested",
            properties: {
              name: {
                type: "keyword",
              },
              value: {
                type: "keyword",
              },
            },
          },
        },
      },
    },
  });

  console.log(`✅ Created new index: ${newIndexName}`);

  // Reindex data from old to new
  console.log(`\n📦 Reindexing data from ${oldIndexName} to ${newIndexName}...`);
  console.log("   This may take a while depending on the amount of data...");

  const reindexResponse = await client.reindex({
    body: {
      source: {
        index: oldIndexName,
      },
      dest: {
        index: newIndexName,
      },
    },
    wait_for_completion: true,
    timeout: "30m",
  });

  // Type assertion for the response body when wait_for_completion is true
  const responseBody = reindexResponse.body as {
    total?: number;
    created?: number;
    updated?: number;
    failures?: unknown[];
  };

  console.log(
    `✅ Reindexed ${responseBody.total || 0} documents (${responseBody.created || 0} created, ${responseBody.updated || 0} updated)`,
  );

  if (responseBody.failures && responseBody.failures.length > 0) {
    console.log(
      `⚠️  Warning: ${responseBody.failures.length} failures during reindex`,
    );
    console.log(
      "   First few failures:",
      responseBody.failures.slice(0, 3),
    );
  }

  // Refresh the new index
  console.log(`\n🔄 Refreshing new index...`);
  await client.indices.refresh({
    index: newIndexName,
  });

  // Get document count from both indices
  const oldCount = await client.count({ index: oldIndexName });
  const newCount = await client.count({ index: newIndexName });

  console.log(`\n📊 Document counts:`);
  console.log(`   Old index: ${oldCount.body.count}`);
  console.log(`   New index: ${newCount.body.count}`);

  if (oldCount.body.count !== newCount.body.count) {
    console.log(
      `\n⚠️  WARNING: Document counts don't match! Some data may have been lost.`,
    );
    console.log(`   Please investigate before deleting the old index.`);
    Deno.exit(1);
  }

  // Ask for confirmation before deleting old index
  console.log(`\n⚠️  Ready to delete old index and create alias`);
  console.log(`   This will:`);
  console.log(`   1. Delete the old index: ${oldIndexName}`);
  console.log(
    `   2. Create an alias: ${oldIndexName} -> ${newIndexName}`,
  );
  console.log(`\n   Type 'yes' to continue, anything else to abort:`);

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  const answer = new TextDecoder().decode(buf.subarray(0, n || 0)).trim();

  if (answer.toLowerCase() !== "yes") {
    console.log(`\n❌ Aborted. Old index ${oldIndexName} was not deleted.`);
    console.log(
      `   New index ${newIndexName} is ready but not being used.`,
    );
    console.log(`   To use it, you can manually:`);
    console.log(`   1. Stop the relay`);
    console.log(`   2. Delete the old index`);
    console.log(`   3. Create an alias or update your configuration`);
    console.log(`   4. Restart the relay`);
    Deno.exit(0);
  }

  // Delete old index
  console.log(`\n🗑️  Deleting old index: ${oldIndexName}`);
  await client.indices.delete({
    index: oldIndexName,
  });

  console.log(`✅ Deleted old index`);

  // Create alias
  console.log(`\n🔗 Creating alias: ${oldIndexName} -> ${newIndexName}`);
  await client.indices.putAlias({
    index: newIndexName,
    name: oldIndexName,
  });

  console.log(`✅ Created alias`);

  console.log(`\n✅ Migration completed successfully!`);
  console.log(`   The relay can now handle nested queries on tags_flat`);
} catch (error) {
  console.error("❌ Migration failed:", error);
  Deno.exit(1);
} finally {
  await client.close();
}
