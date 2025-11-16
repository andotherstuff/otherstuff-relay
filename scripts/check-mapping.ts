/**
 * Check the current OpenSearch index mapping
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

const indexName = "nostr-events";

try {
  console.log(`🔍 Checking mapping for index: ${indexName}`);

  // Check if index exists
  const indexExists = await client.indices.exists({
    index: indexName,
  });

  if (!indexExists.body) {
    console.log(`❌ Index ${indexName} does not exist`);
    Deno.exit(1);
  }

  // Get the mapping
  const response = await client.indices.getMapping({
    index: indexName,
  });

  const mapping = response.body[indexName]?.mappings;

  if (!mapping) {
    console.log(`❌ Could not retrieve mapping for ${indexName}`);
    Deno.exit(1);
  }

  console.log("\n📋 Current mapping:");
  console.log(JSON.stringify(mapping, null, 2));

  // Check if tags_flat is properly configured as nested
  const tagsFlat = mapping.properties?.tags_flat;

  if (!tagsFlat) {
    console.log("\n⚠️  WARNING: tags_flat field is not defined in the mapping!");
    console.log("   This will cause nested queries to fail.");
    console.log("   Run 'deno task fix-mapping' to fix this issue.");
  } else if (tagsFlat.type !== "nested") {
    console.log(
      `\n❌ ERROR: tags_flat is of type '${tagsFlat.type}', not 'nested'!`,
    );
    console.log("   This will cause nested queries to fail.");
    console.log("   Run 'deno task fix-mapping' to fix this issue.");
  } else {
    console.log("\n✅ tags_flat is correctly configured as nested type");
  }
} catch (error) {
  console.error("❌ Failed to check mapping:", error);
  Deno.exit(1);
} finally {
  await client.close();
}
