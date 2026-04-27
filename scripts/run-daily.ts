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
const LOCK_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = Number(process.env.WORKFLOW_LOCK_STALE_MS ?? 10 * 60 * 1000);
const DEFAULT_LOCK_MAX_AGE_MS = Number(process.env.WORKFLOW_LOCK_MAX_AGE_MS ?? 45 * 60 * 1000);

interface LockPayload {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  argv: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run'),
    skipDiscovery: args.includes('--skip-discovery'),
    forceRun: args.includes('--force'),
    prepareOnly: args.includes('--prepare-only'),
    cacheOnly: args.includes('--cache-only'),
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

    if (options.cacheOnly) {
      console.log('🗂️  Running in CACHE ONLY mode - consuming only pre-approved research cache artists\n');
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
        await handle.writeFile(JSON.stringify(buildLockPayload()));
        await handle.close();

        const heartbeat = setInterval(() => {
          void refreshLockHeartbeat();
        }, LOCK_HEARTBEAT_INTERVAL_MS);
        heartbeat.unref();

        return async () => {
          clearInterval(heartbeat);
          try {
            const current = await readLockPayload();
            if (current?.pid === process.pid) {
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
    const payload = await readLockPayload();
    if (!payload) {
      await fs.unlink(LOCK_FILE).catch(() => {});
      return true;
    }

    const pid = Number(payload.pid);
    const now = Date.now();
    const heartbeatAtMs = Date.parse(payload.heartbeatAt);
    const startedAtMs = Date.parse(payload.startedAt);

    if (!isProcessAlive(pid)) {
      await fs.unlink(LOCK_FILE).catch(() => {});
      return true;
    }

    const heartbeatExpired =
      !Number.isFinite(heartbeatAtMs) || now - heartbeatAtMs > DEFAULT_LOCK_STALE_MS;
    const ageExpired =
      !Number.isFinite(startedAtMs) || now - startedAtMs > DEFAULT_LOCK_MAX_AGE_MS;

    if (heartbeatExpired || ageExpired) {
      await terminateStaleProcess(pid);
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
    const payload = await readLockPayload();
    return payload ? String(payload.pid) : null;
  } catch {
    return null;
  }
}

async function readLockPayload(): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === 'number') {
      return {
        pid: parsed.pid,
        startedAt: parsed.startedAt ?? new Date().toISOString(),
        heartbeatAt: parsed.heartbeatAt ?? new Date().toISOString(),
        argv: Array.isArray(parsed.argv) ? parsed.argv.map(String) : [],
      };
    }
  } catch {
    // Legacy or missing format falls through below.
  }

  try {
    const legacyRaw = (await fs.readFile(LOCK_FILE, 'utf8')).trim();
    const legacyPid = Number(legacyRaw);
    if (Number.isFinite(legacyPid) && legacyPid > 0) {
      return {
        pid: legacyPid,
        startedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
        argv: [],
      };
    }
  } catch {
    // Ignore parse failures.
  }

  return null;
}

function buildLockPayload(): LockPayload {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    argv: process.argv.slice(2),
  };
}

async function refreshLockHeartbeat(): Promise<void> {
  try {
    const payload = await readLockPayload();
    if (!payload || payload.pid !== process.pid) {
      return;
    }
    payload.heartbeatAt = new Date().toISOString();
    await fs.writeFile(LOCK_FILE, JSON.stringify(payload));
  } catch {
    // Best effort only.
  }
}

async function terminateStaleProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(250);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Ignore race conditions.
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
  --cache-only      Only consume artists imported from the research cache
  --wait-for-lock   Wait for the active workflow run to finish before starting
  --help, -h        Show this help message

Examples:
  npm run daily
  npm run daily -- --dry-run
  npm run daily -- --prepare-only
  npm run daily -- --cache-only --prepare-only
  npm run daily -- --wait-for-lock --force --skip-discovery
  npm run daily -- --force --skip-discovery
  `);
  process.exit(0);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
