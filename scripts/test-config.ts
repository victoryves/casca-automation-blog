#!/usr/bin/env tsx

/**
 * Test Configuration
 *
 * Validates that all configuration is properly set up.
 */

import { loadConfig } from '../src/config/index.js';

function testConfig(): void {
  console.log('🧪 Testing Configuration\n');

  try {
    const config = loadConfig();

    console.log('✓ Configuration loaded successfully\n');

    // Test environment variables
    console.log('📋 Environment Variables:');
    console.log(`  Database Path: ${config.env.dbPath}`);
    console.log(`  Gemini API Key: ${config.env.geminiApiKey.substring(0, 10)}...`);
    console.log(`  Resend API Key: ${config.env.resendApiKey.substring(0, 10)}...`);
    console.log(`  Exa API Key: ${config.env.exaApiKey.substring(0, 10)}...`);
    console.log(`  Approval Email: ${config.env.approvalEmail}`);
    console.log(`  From Email: ${config.env.fromEmail}`);
    console.log(`  Log Level: ${config.env.logLevel}`);

    // Test institutions
    console.log(`\n📚 Institutions: ${config.institutions.institutions.length} loaded`);
    const topInstitutions = config.institutions.institutions
      .sort((a, b) => b.credibility_score - a.credibility_score)
      .slice(0, 5);
    console.log('  Top 5 by credibility:');
    topInstitutions.forEach((inst) => {
      console.log(`    - ${inst.name} (${inst.credibility_score})`);
    });

    // Test search queries
    console.log(`\n🔍 Search Queries: ${config.searchQueries.queries.length} loaded`);
    config.searchQueries.queries.forEach((query, idx) => {
      console.log(`  ${idx + 1}. ${query.description}`);
    });

    // Test prompts
    console.log('\n✍️  Prompts:');
    console.log(`  System prompt length: ${config.prompts.article_generation.system.length} chars`);
    console.log(`  User template length: ${config.prompts.article_generation.user_template.length} chars`);

    console.log('\n✅ All configuration tests passed!');
  } catch (error) {
    console.error('\n❌ Configuration test failed:');
    console.error(error);
    process.exit(1);
  }
}

testConfig();
