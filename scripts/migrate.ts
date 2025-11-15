/**
 * Migration script to initialize OpenSearch index
 */
import { Client } from "@opensearch-project/opensearch";
import { Config } from "../src/config.ts";
import { OpenSearchRelay } from "../src/opensearch.ts";

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

const opensearch = new Client(opensearchConfig);

console.log("🔧 Initializing OpenSearch relay...");
console.log(`📍 OpenSearch URL: ${config.opensearchUrl}`);

const relay = new OpenSearchRelay(opensearch);

try {
  await relay.migrate();
  console.log("✅ Migration completed successfully!");
} catch (error) {
  // Check if error is "index already exists"
  if (
    error && typeof error === "object" && "meta" in error &&
    error.meta && typeof error.meta === "object" && "body" in error.meta &&
    error.meta.body && typeof error.meta.body === "object" &&
    "error" in error.meta.body &&
    error.meta.body.error && typeof error.meta.body.error === "object" &&
    "type" in error.meta.body.error &&
    error.meta.body.error.type === "resource_already_exists_exception"
  ) {
    console.log("ℹ️  Index already exists, skipping creation");
  } else {
    console.error("❌ Migration failed:", error);
    Deno.exit(1);
  }
} finally {
  await relay.close();
}
