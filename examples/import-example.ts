/**
 * Example: Programmatic usage of the EventImporter
 * 
 * This demonstrates how to use the importer in your own scripts
 */
import { EventImporter } from "../src/import.ts";

async function main() {
  console.log("🚀 Starting programmatic import example\n");

  // Create an importer with custom options
  const importer = new EventImporter({
    batchSize: 5000,           // Process 5000 events per batch
    skipValidation: false,     // Validate signatures (safer)
    skipDuplicates: true,      // Check for duplicates (slower but safer)
    parallelValidation: 4,     // Use 4 parallel workers
    progressInterval: 5,       // Report progress every 5 seconds
  });

  try {
    // Import the file
    await importer.importFile("test-events.jsonl");
    
    console.log("✅ Import completed successfully!");
  } catch (error) {
    console.error("❌ Import failed:", error);
    Deno.exit(1);
  } finally {
    // Always close the importer to cleanup resources
    await importer.close();
  }
}

// Run the example
if (import.meta.main) {
  await main();
}
