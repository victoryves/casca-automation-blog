import { query } from '../../db/client.js';
import { artistOps, draftOps } from '../../db/operations/index.js';
import { getConfig } from '../../config/index.js';
import { DiscoveryModule } from '../discovery/index.js';
import { syncRssFeedToPublicationHistory } from '../publication-history/rss-sync.js';
import { purgeReadyDuplicatesAgainstPublicationHistory } from '../publication-history/ready-purge.js';
import { BaseAgent, type AgentTickResult } from './base.js';

const TARGET_MIN_DAILY_DISCOVERIES = 5;
const TARGET_MAX_DAILY_DISCOVERIES = 10;
const READY_FLOOR = 5;
const HYPERDRIVE_SLEEP_MS = 10_000;

export class ScoutAgent extends BaseAgent {
  private readonly discovery = new DiscoveryModule(getConfig().env.exaApiKey);

  constructor() {
    super('scout-agent', {
      pollIntervalMs: 60_000,
      maxBackoffMs: 15 * 60 * 1000,
    });
  }

  protected async tick(): Promise<AgentTickResult> {
    const config = getConfig();
    const rssSync = await syncRssFeedToPublicationHistory('https://blog.casca-archive.org/rss.xml');
    const purgedDuplicates = await purgeReadyDuplicatesAgainstPublicationHistory();
    const readyCount = await draftOps.countByStatus('ready');
    const hyperDrive = readyCount < READY_FLOOR;
    const today = this.formatWorkflowDate(new Date(), config.env.appTimezone || 'UTC');
    const discoveredRows = query.all<{ discovered_at: string | null }>(
      `SELECT discovered_at
       FROM artists
       WHERE discovered_at IS NOT NULL
         AND status != 'failed_permanent'`
    );
    const discoveredToday = discoveredRows.filter((row) =>
      row.discovered_at
        ? this.formatWorkflowDate(new Date(row.discovered_at), config.env.appTimezone || 'UTC') === today
        : false
    ).length;

    if (!hyperDrive && discoveredToday >= TARGET_MAX_DAILY_DISCOVERIES) {
      return {
        worked: false,
        detail: `daily-target-met:${discoveredToday}`,
        sleepMs: 10 * 60 * 1000,
      };
    }

    const batchSize = hyperDrive
      ? 4
      : Math.max(
          1,
          Math.min(TARGET_MIN_DAILY_DISCOVERIES, TARGET_MAX_DAILY_DISCOVERIES - discoveredToday)
        );
    const result = await this.discovery.discover(batchSize);

    for (const candidate of result.candidates) {
      if (candidate.id) {
        await artistOps.updateStatus(candidate.id, 'discovered');
        await artistOps.updatePriority(candidate.id, 50);
      }
    }

    return {
      worked: result.candidates.length > 0,
      detail: `mode:${hyperDrive ? 'hyperdrive' : 'cruise'};discovered:${result.candidates.length};rss_synced:${rssSync.synced.length};rss_pending:${rssSync.pendingReview.length};purged:${purgedDuplicates.length};errors:${result.errors.length};ready:${readyCount}`,
      sleepMs: hyperDrive ? HYPERDRIVE_SLEEP_MS : undefined,
    };
  }
}
