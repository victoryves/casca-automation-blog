#!/usr/bin/env tsx

import cron from 'node-cron';
import { spawn } from 'node:child_process';
import { closeDatabase, initDatabase } from '../src/db/local.js';
import { getConfig } from '../src/config/index.js';
import { query } from '../src/db/client.js';
import { artistOps, draftOps, workerHeartbeatOps } from '../src/db/operations/index.js';
import { Dispatcher, EmailModule } from '../src/modules/email/index.js';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MIN_RESEARCHED_TARGETS = Number(process.env.MASTER_MIN_RESEARCHED_TARGETS ?? 8);
const MIN_READY_DRAFTS = Number(process.env.MASTER_MIN_READY_DRAFTS ?? 3);
const REPLENISH_TARGET = Number(process.env.MASTER_REPLENISH_TARGET ?? 10);
const SENTINEL_TIMEOUT_MS = Number(process.env.MASTER_SENTINEL_TIMEOUT_MS ?? 90 * 60 * 1000);
const REPLENISH_TIMEOUT_MS = Number(process.env.MASTER_REPLENISH_TIMEOUT_MS ?? 30 * 60 * 1000);

let minerRunning = false;
let dispatchRunning = false;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withDatabase<T>(work: () => Promise<T>): Promise<T> {
  initDatabase();
  try {
    return await work();
  } finally {
    closeDatabase();
  }
}

async function runScript(
  script: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn('npx', ['tsx', script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let output = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      output += `\nMASTER_TIMEOUT ${script} exceeded ${timeoutMs}ms\n`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 10_000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
}

async function countResearchedTargets(): Promise<number> {
  return await withDatabase(async () => {
    const row = query.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM artists
       WHERE status = 'researched'
         AND COALESCE(priority, 0) > 0`
    );
    return row?.count ?? 0;
  });
}

async function countReadyDrafts(): Promise<number> {
  return await withDatabase(async () => draftOps.countReadyPending(3));
}

async function replenishIfNeeded(reason: string): Promise<void> {
  const researchedCount = await countResearchedTargets();
  if (researchedCount >= MIN_RESEARCHED_TARGETS) {
    log(`Replenish skipped (${reason}): researched targets ${researchedCount}/${MIN_RESEARCHED_TARGETS}`);
    return;
  }

  log(`Replenish starting (${reason}): researched targets ${researchedCount}/${MIN_RESEARCHED_TARGETS}`);
  const result = await runScript('scripts/exa-replenish.ts', [String(REPLENISH_TARGET)], REPLENISH_TIMEOUT_MS);
  await withDatabase(async () => {
    await workerHeartbeatOps.touch(
      'master-orchestrator',
      `replenish:${reason}:exit:${result.code ?? 'signal'}`
    );
  });
  log(`Replenish finished (${reason}) with exit ${result.code ?? 'signal'}`);
}

async function runMinerPass(reason = 'scheduled'): Promise<void> {
  if (minerRunning) {
    log(`Miner skipped (${reason}): previous miner pass still running`);
    return;
  }

  minerRunning = true;
  try {
    await withDatabase(async () => {
      await workerHeartbeatOps.touch('master-orchestrator', `miner:${reason}:start`);
    });

    await replenishIfNeeded(reason);

    const readyBefore = await countReadyDrafts();
    if (readyBefore >= MIN_READY_DRAFTS) {
      log(`Miner sentinel skipped (${reason}): ready queue ${readyBefore}/${MIN_READY_DRAFTS}`);
      await withDatabase(async () => {
        await workerHeartbeatOps.touch('master-orchestrator', `miner:${reason}:ready:${readyBefore}`);
      });
      return;
    }

    log(`Miner sentinel starting (${reason}): ready queue ${readyBefore}/${MIN_READY_DRAFTS}`);
    const result = await runScript(
      'scripts/autonomous-sentinel.ts',
      ['--headless', '--force-high-res', '--hydrate-only'],
      SENTINEL_TIMEOUT_MS
    );
    const readyAfter = await countReadyDrafts();
    await withDatabase(async () => {
      await workerHeartbeatOps.touch(
        'master-orchestrator',
        `miner:${reason}:sentinel:${result.code ?? 'signal'}:ready:${readyAfter}`
      );
    });
    log(`Miner sentinel finished (${reason}) with exit ${result.code ?? 'signal'}; ready queue ${readyAfter}`);
  } catch (error) {
    log(`Miner failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    await withDatabase(async () => {
      await workerHeartbeatOps.touch(
        'master-orchestrator',
        `miner:${reason}:failed:${error instanceof Error ? error.message : String(error)}`
      );
    }).catch(() => undefined);
  } finally {
    minerRunning = false;
  }
}

async function markDispatchedArtistAlreadyPublished(result: {
  artistId?: number;
  artistName?: string;
  draftId?: number;
}): Promise<void> {
  if (!result.artistId) return;

  const artist = await artistOps.findById(result.artistId);
  if (!artist?.id) return;

  await artistOps.updateStatus(artist.id, 'already_published');
  await artistOps.updatePriority(artist.id, 0);
  await artistOps.mergeMetadata(artist.id, {
    ...(artistOps.parseMetadata(artist) ?? {}),
    already_published_at: new Date().toISOString(),
    already_published_source: 'master_orchestrator_dispatch',
    already_published_draft_id: result.draftId ?? null,
  });
}

async function runDailyDispatch(reason = 'cron'): Promise<void> {
  if (dispatchRunning) {
    log(`Dispatch skipped (${reason}): previous dispatch pass still running`);
    return;
  }

  dispatchRunning = true;
  try {
    await withDatabase(async () => {
      await workerHeartbeatOps.touch('master-orchestrator', `dispatch:${reason}:start`);

      if (await draftOps.emailSentToday()) {
        log(`Dispatch skipped (${reason}): daily email already sent`);
        await workerHeartbeatOps.touch('master-orchestrator', `dispatch:${reason}:already-sent`);
        return;
      }

      const config = getConfig();
      const dispatcher = new Dispatcher(new EmailModule(config.env.resendApiKey));
      const nextDraft = await dispatcher.getNextReadyDraft();
      if (!nextDraft?.id) {
        log(`Dispatch found no READY draft (${reason}); triggering aggressive miner recovery`);
        await workerHeartbeatOps.touch('master-orchestrator', `dispatch:${reason}:empty-ready`);
        setImmediate(() => void runMinerPass('dispatch-empty-ready'));
        return;
      }

      log(`Dispatch selected draft ${nextDraft.id}: ${nextDraft.title}`);
      const result = await dispatcher.sendDraft(nextDraft.id, false);
      if (!result.sent) {
        log(`Dispatch failed for draft ${nextDraft.id}: ${result.reason ?? 'unknown reason'}`);
        await workerHeartbeatOps.touch(
          'master-orchestrator',
          `dispatch:${reason}:failed:${result.reason ?? 'unknown'}`
        );
        setImmediate(() => void runMinerPass('dispatch-failed'));
        return;
      }

      await markDispatchedArtistAlreadyPublished(result);
      await workerHeartbeatOps.touch(
        'master-orchestrator',
        `dispatch:${reason}:sent:draft:${result.draftId}:artist:${result.artistName ?? 'unknown'}`
      );
      log(`Dispatch sent draft ${result.draftId} for ${result.artistName ?? 'unknown artist'}`);
    });
  } catch (error) {
    log(`Dispatch failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    await withDatabase(async () => {
      await workerHeartbeatOps.touch(
        'master-orchestrator',
        `dispatch:${reason}:error:${error instanceof Error ? error.message : String(error)}`
      );
    }).catch(() => undefined);
  } finally {
    dispatchRunning = false;
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const timezone = config.env.appTimezone || process.env.TZ || 'America/Toronto';

  log(`Master orchestrator booting with timezone ${timezone}`);
  log(`Miner target: ${MIN_READY_DRAFTS} ready drafts, ${MIN_RESEARCHED_TARGETS} researched targets`);

  cron.schedule('0 5 * * *', () => void runDailyDispatch('cron-0500'), { timezone });
  setInterval(() => void runMinerPass('interval-2h'), TWO_HOURS_MS);

  await runMinerPass('startup');

  while (true) {
    await sleep(60 * 60 * 1000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
