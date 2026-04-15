#!/usr/bin/env tsx

/**
 * Daily Execution Script
 *
 * Runs the daily workflow for the CASCA Editorial Agent.
 * Designed to be executed by OpenClaw or cron.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkflowOrchestrator } from '../src/index.js';

const LOCK_DIR = path.resolve(process.cwd(), 'logs', 'daily');
const LOCK_FILE = path.join(LOCK_DIR, 'run-daily-ts.lock');
const DEFAULT_LOCK_WAIT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run'),
    skipDiscovery: args.includes('--skip-discovery'),
    forceRun: args.includes('--force'),
    prepareOnly: args.includes('--prepare-only'),
    waitForLock: args.includes('--wait-for-lock'),
  };

  const releaseLock = await acquireExecutionLock({
    waitForLock: options.waitForLock,
    waitMs: DEFAULT_LOCK_WAIT_MS,
  });

  try {
    console.log('🤖 CASCA Editorial Agent - Daily Workflow\n');

    if (options.dryRun) {
      console.log('⚠️  Running in DRY RUN mode - no emails will be sent\n');
    }

    if (options.prepareOnly) {
      console.log('🧱 Running in PREPARE ONLY mode - replenishing backlog without sending email\n');
    }

    const orchestrator = new WorkflowOrchestrator();

    const result = await orchestrator.execute(options);

    console.log('\n📊 Workflow Summary:');
    console.log(`  Date: ${result.date}`);
    console.log(`  Status: ${result.status}`);
    console.log(`  Email Sent: ${result.email_sent ? 'Yes' : 'No'}`);
    console.log(`  Draft Prepared: ${result.prepared_draft ? 'Yes' : 'No'}`);

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
      const retryableNoArtistError = result.errors.some((error) =>
        error.includes('No verified artist produced an approval-ready article')
      );

      if (retryableNoArtistError) {
        process.exit(2);
      }

      process.exit(1);
    }

    if (!options.dryRun && !options.prepareOnly && !result.email_sent && !result.prepared_draft) {
      console.error('\n❌ Workflow completed without sending an approval email.');
      process.exit(2);
    }

    if (options.prepareOnly && result.status !== 'completed' && !result.prepared_draft) {
      console.error('\n❌ Prepare-only run completed without replenishing backlog.');
      process.exit(2);
    }
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await releaseLock();
  }
}

async function acquireExecutionLock(options: {
  waitForLock: boolean;
  waitMs: number;
}): Promise<() => Promise<void>> {
  await fs.mkdir(LOCK_DIR, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    const staleOrMissing = await ensureLiveOrRemoveStaleLock();

    if (staleOrMissing) {
      try {
        const handle = await fs.open(LOCK_FILE, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();

        return async () => {
          try {
            const currentPid = (await fs.readFile(LOCK_FILE, 'utf8')).trim();
            if (currentPid === String(process.pid)) {
              await fs.unlink(LOCK_FILE);
            }
          } catch {
            // Lock file may already be gone after shutdown or cleanup.
          }
        };
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
    }

    if (!options.waitForLock) {
      const activePid = await readLockPid();
      console.log(
        `⚠️  Another run is already active${activePid ? ` (pid ${activePid})` : ''}. Exiting cleanly.`
      );
      process.exit(0);
    }

    if (Date.now() - startedAt >= options.waitMs) {
      throw new Error(
        `Timed out waiting for active workflow lock after ${Math.round(options.waitMs / 1000)} seconds`
      );
    }

    await sleep(2000);
  }
}

async function ensureLiveOrRemoveStaleLock(): Promise<boolean> {
  try {
    const pid = (await fs.readFile(LOCK_FILE, 'utf8')).trim();
    if (!pid) {
      await fs.unlink(LOCK_FILE).catch(() => {});
      return true;
    }

    if (!isProcessAlive(Number(pid))) {
      await fs.unlink(LOCK_FILE).catch(() => {});
      return true;
    }

    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return true;
    }

    throw error;
  }
}

async function readLockPid(): Promise<string | null> {
  try {
    const pid = (await fs.readFile(LOCK_FILE, 'utf8')).trim();
    return pid || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  --prepare-only    Replenish backlog without sending approval email
  --wait-for-lock   Wait for the active workflow run to finish before starting
  --help, -h        Show this help message

Examples:
  npm run daily
  npm run daily -- --dry-run
  npm run daily -- --prepare-only
  npm run daily -- --wait-for-lock --force --skip-discovery
  npm run daily -- --force --skip-discovery
  `);
  process.exit(0);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
