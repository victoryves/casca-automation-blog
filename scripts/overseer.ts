#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadConfig } from '../src/config/index.js';
import { initDatabase, closeDatabase } from '../src/db/local.js';
import { query } from '../src/db/client.js';
import { workerHeartbeatOps } from '../src/db/operations/index.js';
import { ScoutAgent } from '../src/modules/agents/scout.js';

const execFileAsync = promisify(execFile);
const STALE_MINUTES = 10;
const READY_FLOOR = 5;
const SERVICE_MAP: Record<string, string> = {
  'scout-agent': 'com.casca.scout-agent',
  'research-agent': 'com.casca.research-miner',
  'curator-agent': 'com.casca.curator-agent',
  overseer: 'com.casca.daily-workflow',
};

async function log(level: 'info' | 'warn' | 'error' | 'critical', event: string, payload: Record<string, unknown>): Promise<void> {
  const logPath = path.join(process.cwd(), 'logs', 'agents', 'overseer.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(
    logPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level,
      agent: 'overseer',
      event,
      pid: process.pid,
      ...payload,
    })}\n`,
    'utf8'
  );
}

async function restartService(label: string): Promise<void> {
  const uid = String(process.getuid?.() ?? 501);
  await execFileAsync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
}

async function main(): Promise<void> {
  loadConfig();
  initDatabase();

  try {
    await workerHeartbeatOps.touch('overseer', 'scan-start', process.pid);
    const staleBefore = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
    const heartbeats = await workerHeartbeatOps.findAll();

    for (const heartbeat of heartbeats) {
      if (!heartbeat.last_heartbeat || heartbeat.last_heartbeat < staleBefore) {
        const label = SERVICE_MAP[heartbeat.agent_name];
        await log('critical', 'stale-agent', {
          agentName: heartbeat.agent_name,
          lastHeartbeat: heartbeat.last_heartbeat ?? null,
          service: label ?? null,
        });

        if (label) {
          try {
            await restartService(label);
            await log('warn', 'service-restarted', {
              agentName: heartbeat.agent_name,
              service: label,
            });
          } catch (error) {
            await log('error', 'service-restart-failed', {
              agentName: heartbeat.agent_name,
              service: label,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    const readyCountRow = query.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM drafts WHERE status = 'ready'`
    );
    const readyCount = readyCountRow?.count ?? 0;

    await log('info', 'queue-health', {
      readyCount,
      readyFloor: READY_FLOOR,
    });

    if (readyCount < READY_FLOOR) {
      await log('warn', 'queue-below-floor', {
        readyCount,
        readyFloor: READY_FLOOR,
        action: 'trigger-scout-single-pass',
      });
      const scout = new ScoutAgent();
      await scout.runSinglePass();
    }
    await workerHeartbeatOps.touch('overseer', `scan-complete:ready=${readyCount}`, process.pid);
  } finally {
    closeDatabase();
  }
}

void main();
