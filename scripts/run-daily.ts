#!/usr/bin/env tsx

/**
 * Daily Execution Script
 *
 * Runs the daily workflow for the CASCA Editorial Agent.
 * Designed to be executed by OpenClaw or cron.
 */

import { WorkflowOrchestrator } from '../src/index.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run'),
    skipDiscovery: args.includes('--skip-discovery'),
    forceRun: args.includes('--force'),
  };

  console.log('🤖 CASCA Editorial Agent - Daily Workflow\n');

  if (options.dryRun) {
    console.log('⚠️  Running in DRY RUN mode - no emails will be sent\n');
  }

  const orchestrator = new WorkflowOrchestrator();

  try {
    const result = await orchestrator.execute(options);

    console.log('\n📊 Workflow Summary:');
    console.log(`  Date: ${result.date}`);
    console.log(`  Status: ${result.status}`);
    console.log(`  Email Sent: ${result.email_sent ? 'Yes' : 'No'}`);

    if (result.artist_id) {
      console.log(`  Artist ID: ${result.artist_id}`);
    }

    if (result.draft_id) {
      console.log(`  Draft ID: ${result.draft_id}`);
    }

    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      result.errors.forEach((error, idx) => {
        console.log(`    ${idx + 1}. ${error}`);
      });
    }

    // Exit with appropriate code
    if (result.status === 'error') {
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

// Handle CLI flags
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
CASCA Editorial Agent - Daily Workflow

Usage:
  npm run daily [options]

Options:
  --dry-run         Run without sending emails
  --skip-discovery  Skip discovery phase, only process verified artists
  --force           Force run even if email already sent today
  --help, -h        Show this help message

Examples:
  npm run daily
  npm run daily -- --dry-run
  npm run daily -- --force --skip-discovery
  `);
  process.exit(0);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
