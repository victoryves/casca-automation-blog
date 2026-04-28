import path from 'node:path';
import fs from 'node:fs/promises';

import { getConfig } from '../../config/index.js';
import { query } from '../../db/client.js';
import {
  artistOps,
  draftOps,
  librarianPendingReviewOps,
  publishingOps,
  sourceOps,
  workerHeartbeatOps,
} from '../../db/operations/index.js';
import { ArtistResearchCache } from '../research-cache/index.js';
import type { Image, WorkerHeartbeat } from '../../types/index.js';
import type {
  ArtworkResearchCandidate,
  BiographyResearchSource,
} from '../research-cache/index.js';

interface DashboardCountRow {
  status: string;
  count: number;
}

interface DashboardDraftRow {
  id: number;
  artist_id: number;
  artist_name: string;
  title: string;
  status: string;
  created_at: string | null;
  sent_at: string | null;
  priority: number | null;
  content: string;
  images: string | null;
}

interface DashboardPublishingRow {
  id: number;
  draft_id: number;
  medium_url: string | null;
  error_message: string | null;
  published_at: string | null;
  draft_title: string;
  artist_name: string;
}

interface WorkerStatusSnapshot {
  agentName: string;
  displayName: string;
  serviceLabel?: string;
  status: 'active' | 'idle' | 'stale';
  detail: string;
  lastHeartbeat: string | null;
  lastSeenMinutes: number | null;
  pid: number | null;
  processed24h: number;
  approvedImages24h: number;
  rejectedImages24h: number;
}

export interface DashboardSnapshot {
  generatedAt: string;
  timezone: string;
  summary: {
    cacheEntries: number;
    cacheEligible: number;
    queueDepthDays: number;
    readyDrafts: number;
    inProgressDrafts: number;
    sentDrafts: number;
    approvedDrafts: number;
    rejectedDrafts: number;
    replacementRequests: number;
  };
  pipeline: {
    discovered: number;
    researched: number;
    curated: number;
    ready: number;
  };
  health: {
    backlogTarget: number;
    queueFloorHealthy: boolean;
    nextSendHourLocal: string;
    failedArtistsToday: number;
  };
  workers: WorkerStatusSnapshot[];
  readyQueue: Array<{
    draftId: number;
    artistId: number;
    artistName: string;
    title: string;
    snippet: string;
    createdAt: string | null;
    sentAt: string | null;
    priority: number;
    imageCount: number;
    images: Image[];
  }>;
  inProgress: Array<{
    draftId: number;
    artistId: number;
    artistName: string;
    title: string;
    status: string;
    createdAt: string | null;
    priority: number;
    imageCount: number;
  }>;
  almostReady: Array<{
    draftId: number;
    artistId: number;
    artistName: string;
    title: string;
    status: string;
    priority: number;
    imageCount: number;
    images: Image[];
    candidates: Array<{
      url: string;
      caption?: string;
      attribution?: string;
      reason?: string;
    }>;
  }>;
  librarianReview: Array<{
    id: number;
    originalTitle: string;
    resolvedName: string;
    confidence: number;
    reasoning: string | null;
    url: string;
    createdAt: string | null;
  }>;
  imageStats: {
    approved24h: number;
    rejected24h: number;
    approvalRate24h: number;
  };
  mined: Array<{
    artistName: string;
    minedAt: string;
    category?: string;
    states?: string;
    practice?: string;
    shortlistRank?: number;
    biographySourceCount: number;
    artworkCandidateCount: number;
    eligible: boolean;
    publishedExternally: boolean;
    localArtistStatus?: string | null;
    draftStatuses: string[];
    hasLocalDraft: boolean;
    latestDraftId?: number;
    notes: string[];
  }>;
  publicationHistory: Array<{
    id: number;
    draftId: number;
    artistName: string;
    draftTitle: string;
    publishedAt: string | null;
    status: 'published' | 'failed';
    detail: string | null;
  }>;
}

export interface MinedArtistDetailSnapshot {
  generatedAt: string;
  timezone: string;
  artistName: string;
  cacheEntry: {
    minedAt: string;
    category?: string;
    states?: string;
    practice?: string;
    shortlistRank?: number;
    eligible: boolean;
    publishedExternally: boolean;
    localArtistStatus?: string | null;
    draftStatuses: string[];
    notes: string[];
    biographySources: BiographyResearchSource[];
    artworkCandidates: ArtworkResearchCandidate[];
  };
  localArtist: null | {
    id: number;
    status: string;
    birthplaceState?: string;
    visualPractice?: string;
    sourceCount: number;
  };
  drafts: Array<{
    id: number;
    status: string;
    title: string;
    subtitle?: string;
    content: string;
    createdAt: string | null;
    sentAt: string | null;
    imageCount: number;
    images: Image[];
  }>;
}

export interface DraftDetailSnapshot {
  generatedAt: string;
  timezone: string;
  draft: {
    id: number;
    status: string;
    title: string;
    subtitle?: string;
    content: string;
    createdAt: string | null;
    sentAt: string | null;
    imageCount: number;
    images: Image[];
  };
  artist: {
    id: number;
    name: string;
    status: string;
    birthplaceState?: string;
    visualPractice?: string;
  };
}

const BACKLOG_TARGET = 50;
const READY_DRAFT_PREVIEW_LIMIT = 5;
const AGENT_IDLE_MINUTES = 5;
const WORKER_STALE_MINUTES = 15;
const SINGLE_PASS_GRACE_MINUTES = 30;

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const config = getConfig();
  const timezone =
    config.env.appTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const researchCache = new ArtistResearchCache();
  const cacheEntries = await researchCache.readAll();
  const artistStatusCounts = query.all<DashboardCountRow>(
    `SELECT status, COUNT(*) as count FROM artists GROUP BY status`
  );
  const artistCountMap = new Map(artistStatusCounts.map((row) => [row.status, row.count]));
  const draftStatusCounts = query.all<DashboardCountRow>(
    `SELECT status, COUNT(*) as count FROM drafts GROUP BY status`
  );
  const draftCountMap = new Map(draftStatusCounts.map((row) => [row.status, row.count]));
  const totalReadyDrafts = draftCountMap.get('ready') ?? 0;
  const readyDraftRows = query.all<DashboardDraftRow>(
    `SELECT
       d.id,
       d.artist_id,
       a.full_name AS artist_name,
       d.title,
       d.status,
       d.created_at,
       d.sent_at,
       d.priority,
       d.content,
       d.images
     FROM drafts d
     INNER JOIN artists a ON a.id = d.artist_id
     WHERE d.status = 'ready'
     ORDER BY d.priority DESC, datetime(d.created_at) ASC
     LIMIT ?`,
    [READY_DRAFT_PREVIEW_LIMIT]
  );

  const readyQueue = readyDraftRows.map((row) => {
    const parsedImages = safeParseImages(row.images);
    return {
      draftId: row.id,
      artistId: row.artist_id,
      artistName: row.artist_name,
      title: row.title,
      snippet: buildSnippet(row.content),
      createdAt: row.created_at,
      sentAt: row.sent_at,
      priority: row.priority ?? 0,
      imageCount: parsedImages.length,
      images: parsedImages.slice(0, 3),
    };
  });

  const inProgressRows = query.all<DashboardDraftRow>(
    `SELECT
       d.id,
       d.artist_id,
       a.full_name AS artist_name,
       d.title,
       d.status,
       d.created_at,
       d.sent_at,
       d.priority,
       d.content,
       d.images
     FROM drafts d
     INNER JOIN artists a ON a.id = d.artist_id
     WHERE d.status IN ('pending', 'researched', 'curated', 'drafted')
     ORDER BY d.priority DESC, datetime(d.created_at) DESC
     LIMIT 12`
  );

  const inProgressQueue = inProgressRows.map((row) => ({
    draftId: row.id,
    artistId: row.artist_id,
    artistName: row.artist_name,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    priority: row.priority ?? 0,
    imageCount: safeParseImages(row.images).length,
  }));

  const almostReadyRows = query.all<
    DashboardDraftRow & { artist_metadata: string | null }
  >(
    `SELECT
       d.id,
       d.artist_id,
       a.full_name AS artist_name,
       a.metadata AS artist_metadata,
       d.title,
       d.status,
       d.created_at,
       d.sent_at,
       d.priority,
       d.content,
       d.images
     FROM drafts d
     INNER JOIN artists a ON a.id = d.artist_id
     WHERE d.status = 'curated'
     ORDER BY d.priority DESC, datetime(d.created_at) DESC
     LIMIT 8`
  );

  const almostReady = almostReadyRows
    .map((row) => {
      const parsedImages = safeParseImages(row.images);
      const metadata = artistOps.parseMetadata({ metadata: row.artist_metadata });
      const candidates = Array.isArray(metadata.almost_ready_candidates)
        ? (metadata.almost_ready_candidates as Array<{
            url: string;
            caption?: string;
            attribution?: string;
            reason?: string;
          }>)
        : [];

      return {
        draftId: row.id,
        artistId: row.artist_id,
        artistName: row.artist_name,
        title: row.title,
        status: row.status,
        priority: row.priority ?? 0,
        imageCount: parsedImages.length,
        images: parsedImages,
        candidates,
      };
    })
    .filter((row) => row.imageCount === 2);

  const librarianReview = (await librarianPendingReviewOps.findAll())
    .slice(0, 12)
    .map((row) => ({
      id: row.id ?? 0,
      originalTitle: row.original_title,
      resolvedName: row.resolved_name,
      confidence: row.confidence,
      reasoning: row.reasoning ?? null,
      url: row.url,
      createdAt: row.created_at ?? null,
    }));

  const replacementRequests = (await publishingOps.findFailed()).filter(
    (log) => log.error_message === 'replacement_requested'
  ).length;

  const recentPublishingRows = query.all<DashboardPublishingRow>(
    `SELECT
       p.id,
       p.draft_id,
       p.medium_url,
       p.error_message,
       p.published_at,
       d.title AS draft_title,
       a.full_name AS artist_name
     FROM publishing_log p
     INNER JOIN drafts d ON d.id = p.draft_id
     INNER JOIN artists a ON a.id = d.artist_id
     ORDER BY datetime(COALESCE(p.published_at, CURRENT_TIMESTAMP)) DESC
     LIMIT 10`
  );

  const publicationHistory = recentPublishingRows.map((row) => ({
    id: row.id,
    draftId: row.draft_id,
    artistName: row.artist_name,
    draftTitle: row.draft_title,
    publishedAt: row.published_at,
    status: row.medium_url ? ('published' as const) : ('failed' as const),
    detail: row.medium_url ?? row.error_message,
  }));
  const workerHeartbeats = await workerHeartbeatOps.findAll();
  const workerMetrics = await getWorkerMetricsLast24h();
  const workers = buildWorkerSnapshots(workerHeartbeats, workerMetrics);
  const imageStats = {
    approved24h: workerMetrics.curator.approvedImages24h,
    rejected24h: workerMetrics.curator.rejectedImages24h,
    approvalRate24h:
      workerMetrics.curator.approvedImages24h + workerMetrics.curator.rejectedImages24h > 0
        ? workerMetrics.curator.approvedImages24h /
          (workerMetrics.curator.approvedImages24h + workerMetrics.curator.rejectedImages24h)
        : 0,
  };

  const mined = [...cacheEntries]
    .sort((a, b) => (b.minedAt ?? '').localeCompare(a.minedAt ?? ''))
    .slice(0, 40)
    .map(async (entry) => {
      const localArtist = await artistOps.findByNormalizedName(entry.artistName);
      const localDrafts = localArtist?.id ? await draftOps.findByArtistId(localArtist.id) : [];
      const latestDraft = localDrafts[0];

      return {
        artistName: entry.artistName,
        minedAt: entry.minedAt,
        category: entry.category,
        states: entry.states,
        practice: entry.practice,
        shortlistRank: entry.shortlistRank,
        biographySourceCount: entry.biographySources.length,
        artworkCandidateCount: entry.artworkCandidates.length,
        eligible: entry.repetition?.eligible ?? false,
        publishedExternally: entry.repetition?.publishedExternally ?? false,
        localArtistStatus: entry.repetition?.localArtistStatus ?? null,
        draftStatuses: entry.repetition?.draftStatuses ?? [],
        hasLocalDraft: localDrafts.length > 0,
        latestDraftId: latestDraft?.id,
        notes: entry.notes ?? [],
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    summary: {
      cacheEntries: cacheEntries.length,
      cacheEligible: cacheEntries.filter((entry) => entry.repetition?.eligible).length,
      queueDepthDays: totalReadyDrafts,
      readyDrafts: totalReadyDrafts,
      inProgressDrafts:
        (draftCountMap.get('pending') ?? 0) +
        (draftCountMap.get('researched') ?? 0) +
        (draftCountMap.get('curated') ?? 0) +
        (draftCountMap.get('drafted') ?? 0),
      sentDrafts: draftCountMap.get('sent') ?? 0,
      approvedDrafts: draftCountMap.get('approved') ?? 0,
      rejectedDrafts: draftCountMap.get('rejected') ?? 0,
      replacementRequests,
    },
    pipeline: {
      discovered: artistCountMap.get('discovered') ?? 0,
      researched: artistCountMap.get('researched') ?? 0,
      curated: artistCountMap.get('curated') ?? 0,
      ready: artistCountMap.get('ready_to_send') ?? 0,
    },
    health: {
      backlogTarget: BACKLOG_TARGET,
      queueFloorHealthy: totalReadyDrafts >= 5,
      nextSendHourLocal: '05:00',
      failedArtistsToday: await countFailedArtistsToday(timezone),
    },
    workers,
    readyQueue,
    inProgress: inProgressQueue,
    almostReady,
    librarianReview,
    imageStats,
    mined: await Promise.all(mined),
    publicationHistory,
  };
}

interface WorkerActivityMetrics {
  processed24h: number;
  approvedImages24h: number;
  rejectedImages24h: number;
}

async function getWorkerMetricsLast24h(): Promise<{
  scout: WorkerActivityMetrics;
  research: WorkerActivityMetrics;
  curator: WorkerActivityMetrics;
  overseer: WorkerActivityMetrics;
}> {
  return {
    scout: await readAgentMetrics('scout-agent'),
    research: await readAgentMetrics('research-agent'),
    curator: await readAgentMetrics('curator-agent'),
    overseer: await readAgentMetrics('overseer'),
  };
}

async function readAgentMetrics(agentName: string): Promise<WorkerActivityMetrics> {
  const logPath = path.join(process.cwd(), 'logs', 'agents', `${agentName}.jsonl`);
  try {
    const raw = await fs.readFile(logPath, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    let processed24h = 0;
    let approvedImages24h = 0;
    let rejectedImages24h = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const ts = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN;
        if (!Number.isFinite(ts) || ts < cutoff) {
          continue;
        }

        const event = typeof parsed.event === 'string' ? parsed.event : '';
        const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
        const worked = parsed.worked === true;
        if (event === 'tick-complete' || event === 'single-pass') {
          if (agentName === 'scout-agent') {
            processed24h += extractDetailMetric(detail, 'discovered');
          } else if (agentName === 'research-agent') {
            if (/^(researched:|rejected-duplicate:|no-clean-sources:|no-sources:)/.test(detail)) {
              processed24h += 1;
            }
          } else if (agentName === 'curator-agent') {
            if (/^(ready:|not-ready:)/.test(detail)) {
              processed24h += 1;
            }
            approvedImages24h += extractDetailMetric(detail, 'approved');
            rejectedImages24h += extractDetailMetric(detail, 'rejected');
          } else if (agentName === 'overseer' && worked) {
            processed24h += 1;
          }
        } else if (agentName === 'overseer' && event === 'queue-below-floor') {
          processed24h += 1;
        }
      } catch {
        continue;
      }
    }

    return {
      processed24h,
      approvedImages24h,
      rejectedImages24h,
    };
  } catch {
    return {
      processed24h: 0,
      approvedImages24h: 0,
      rejectedImages24h: 0,
    };
  }
}

function buildWorkerSnapshots(
  heartbeats: WorkerHeartbeat[],
  metrics: {
    scout: WorkerActivityMetrics;
    research: WorkerActivityMetrics;
    curator: WorkerActivityMetrics;
    overseer: WorkerActivityMetrics;
  }
): WorkerStatusSnapshot[] {
  const heartbeatMap = new Map(heartbeats.map((heartbeat) => [heartbeat.agent_name, heartbeat]));
  const definitions = [
    {
      agentName: 'scout-agent',
      displayName: 'Scout',
      serviceLabel: 'com.casca.scout-agent',
      metrics: metrics.scout,
    },
    {
      agentName: 'research-agent',
      displayName: 'Research',
      serviceLabel: 'com.casca.research-miner',
      metrics: metrics.research,
    },
    {
      agentName: 'curator-agent',
      displayName: 'Curator',
      serviceLabel: 'com.casca.curator-agent',
      metrics: metrics.curator,
    },
    {
      agentName: 'overseer',
      displayName: 'Overseer',
      serviceLabel: 'com.casca.daily-workflow',
      metrics: metrics.overseer,
    },
  ];

  return definitions.map((definition) => {
    const heartbeat = heartbeatMap.get(definition.agentName) ?? null;
    return buildWorkerSnapshot(definition, heartbeat);
  });
}

function buildWorkerSnapshot(
  definition: {
    agentName: string;
    displayName: string;
    serviceLabel: string;
    metrics: WorkerActivityMetrics;
  },
  heartbeat: WorkerHeartbeat | null
): WorkerStatusSnapshot {
  const lastHeartbeat = heartbeat?.last_heartbeat ?? null;
  const lastSeenMinutes = lastHeartbeat
    ? Math.max(0, Math.floor((Date.now() - Date.parse(lastHeartbeat)) / 60_000))
    : null;
  const singlePassGrace = heartbeat?.detail?.includes(`single-pass-grace:${SINGLE_PASS_GRACE_MINUTES}m`) ?? false;
  const staleThresholdMinutes = singlePassGrace ? SINGLE_PASS_GRACE_MINUTES : WORKER_STALE_MINUTES;

  let status: WorkerStatusSnapshot['status'] = 'stale';
  if (lastSeenMinutes !== null && Number.isFinite(lastSeenMinutes)) {
    if (lastSeenMinutes < AGENT_IDLE_MINUTES) {
      status = 'active';
    } else if (lastSeenMinutes < staleThresholdMinutes) {
      status = 'idle';
    }
  }

  return {
    agentName: definition.agentName,
    displayName: definition.displayName,
    serviceLabel: definition.serviceLabel,
    status,
    detail: heartbeat?.detail ?? 'No heartbeat recorded yet',
    lastHeartbeat,
    lastSeenMinutes,
    pid: heartbeat?.pid ?? null,
    processed24h: definition.metrics.processed24h,
    approvedImages24h: definition.metrics.approvedImages24h,
    rejectedImages24h: definition.metrics.rejectedImages24h,
  };
}

function buildSnippet(content: string, maxLength = 180): string {
  const paragraph = content
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean) ?? '';
  const normalized = paragraph.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractDetailMetric(detail: string, key: string): number {
  const match = detail.match(new RegExp(`${key}:(\\d+)`));
  return match ? Number(match[1]) : 0;
}

export async function getMinedArtistDetailSnapshot(
  artistName: string
): Promise<MinedArtistDetailSnapshot | null> {
  const config = getConfig();
  const timezone =
    config.env.appTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const researchCache = new ArtistResearchCache();
  const entry = await researchCache.findByArtistName(artistName);

  if (!entry) {
    return null;
  }

  const localArtist = await artistOps.findByNormalizedName(entry.artistName);
  const relatedSources = localArtist?.id ? await sourceOps.findByArtistId(localArtist.id) : [];
  const relatedDrafts = localArtist?.id ? await draftOps.findByArtistId(localArtist.id) : [];

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    artistName: entry.artistName,
    cacheEntry: {
      minedAt: entry.minedAt,
      category: entry.category,
      states: entry.states,
      practice: entry.practice,
      shortlistRank: entry.shortlistRank,
      eligible: entry.repetition?.eligible ?? false,
      publishedExternally: entry.repetition?.publishedExternally ?? false,
      localArtistStatus: entry.repetition?.localArtistStatus ?? null,
      draftStatuses: entry.repetition?.draftStatuses ?? [],
      notes: entry.notes ?? [],
      biographySources: entry.biographySources ?? [],
      artworkCandidates: entry.artworkCandidates ?? [],
    },
    localArtist: localArtist?.id
      ? {
          id: localArtist.id,
          status: localArtist.status,
          birthplaceState: localArtist.birthplace_state,
          visualPractice: localArtist.visual_practice,
          sourceCount: relatedSources.length,
        }
      : null,
    drafts: relatedDrafts.map((draft) => ({
      id: draft.id!,
      status: draft.status,
      title: draft.title,
      subtitle: draft.subtitle ?? undefined,
      content: draft.content,
      createdAt: draft.created_at ?? null,
      sentAt: draft.sent_at ?? null,
      imageCount: safeParseImages(draft.images ?? null).length,
      images: safeParseImages(draft.images ?? null),
    })),
  };
}

export function renderDashboardHtml(snapshot: DashboardSnapshot): string {
  const payload = escapeForInlineScript(JSON.stringify(snapshot));

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CASCA Control Center</title>
    <style>
      :root {
        --bg: #07111c;
        --bg-deep: #0d1826;
        --panel: rgba(12, 21, 33, 0.86);
        --panel-strong: rgba(16, 27, 42, 0.94);
        --panel-soft: rgba(255,255,255,0.04);
        --border: rgba(167, 184, 204, 0.14);
        --ink: #eff5ff;
        --muted: #9fb0c5;
        --accent: #7fb7ff;
        --accent-soft: rgba(127, 183, 255, 0.18);
        --success: #59d39b;
        --success-soft: rgba(89, 211, 155, 0.18);
        --warn: #f2bf5d;
        --warn-soft: rgba(242, 191, 93, 0.16);
        --danger: #ff7d7d;
        --danger-soft: rgba(255, 125, 125, 0.16);
        --shadow: 0 32px 70px rgba(0, 0, 0, 0.28);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "SF Pro Display", "Inter", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(127, 183, 255, 0.13), transparent 28%),
          radial-gradient(circle at top right, rgba(89, 211, 155, 0.09), transparent 18%),
          linear-gradient(180deg, #050b14 0%, var(--bg) 38%, var(--bg-deep) 100%);
        min-height: 100dvh;
      }
      .shell {
        width: min(1440px, calc(100vw - 28px));
        margin: 0 auto;
        padding: 18px 0 36px;
      }
      .hero,
      .section {
        position: relative;
        overflow: hidden;
        background: var(--panel);
        backdrop-filter: blur(22px);
        border: 1px solid var(--border);
        border-radius: 28px;
        padding: 24px;
        box-shadow: var(--shadow);
      }
      .hero::after {
        content: "";
        position: absolute;
        inset: auto -10% -30% 55%;
        height: 320px;
        background: radial-gradient(circle, rgba(127,183,255,0.28), transparent 60%);
        pointer-events: none;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font: 600 11px/1.4 ui-monospace, "SFMono-Regular", Menlo, monospace;
        color: var(--muted);
        margin-bottom: 14px;
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(2.2rem, 5vw, 4.5rem);
        line-height: 0.92;
        max-width: 10ch;
        letter-spacing: -0.05em;
      }
      .hero-grid {
        display: grid;
        grid-template-columns: 1.3fr 0.7fr;
        gap: 20px;
        align-items: start;
      }
      .hero-copy p {
        margin: 0;
        max-width: 72ch;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.7;
      }
      .hero-meta {
        display: grid;
        gap: 12px;
        justify-items: stretch;
      }
      .meta-pill {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.09);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }
      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .section {
        margin-top: 18px;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }
      .card {
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
        border: 1px solid var(--border);
        border-radius: 22px;
        padding: 18px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
      }
      .card-label {
        margin: 0 0 10px;
        color: var(--muted);
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .card-value {
        margin: 0;
        font-size: 2.4rem;
        line-height: 1;
        letter-spacing: -0.05em;
      }
      .card-note {
        margin: 10px 0 0;
        color: var(--muted);
        font-size: 0.95rem;
        line-height: 1.5;
      }
      .section-head {
        display: flex;
        gap: 14px;
        align-items: end;
        justify-content: space-between;
        margin-bottom: 18px;
      }
      .section-head h2 {
        margin: 0;
        font-size: 1.55rem;
        letter-spacing: -0.04em;
      }
      .section-head p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 0.97rem;
      }
      .funnel {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }
      .funnel-step {
        position: relative;
        padding: 18px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015));
      }
      .funnel-step strong {
        display: block;
        margin-top: 12px;
        font-size: 2.2rem;
        letter-spacing: -0.05em;
      }
      .funnel-step span {
        color: var(--muted);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .funnel-note {
        margin-top: 10px;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .hero-grid-lower {
        display: grid;
        grid-template-columns: 1.05fr 0.95fr;
        gap: 18px;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        border-radius: 999px;
        padding: 8px 12px;
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        flex: 0 0 10px;
        box-shadow: 0 0 20px currentColor;
      }
      .status-active { background: var(--success-soft); color: var(--success); }
      .status-idle { background: var(--warn-soft); color: var(--warn); }
      .status-stale { background: var(--danger-soft); color: var(--danger); }
      .panel {
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--border);
        border-radius: 22px;
        overflow: hidden;
      }
      .control-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .control-card {
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 16px;
        background: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015));
      }
      .control-card h3 {
        margin: 0 0 8px;
        font-size: 1rem;
      }
      .control-card p {
        margin: 0 0 14px;
        color: var(--muted);
        font-size: 0.94rem;
        line-height: 1.5;
      }
      .button {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.08);
        color: var(--ink);
        padding: 11px 14px;
        border-radius: 16px;
        cursor: pointer;
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
      }
      .button:hover { transform: translateY(-1px); background: rgba(255,255,255,0.12); }
      .button:active { transform: translateY(0) scale(0.985); }
      .button-primary { background: var(--accent-soft); border-color: rgba(127,183,255,0.24); }
      .button-danger { background: var(--danger-soft); border-color: rgba(255,125,125,0.22); }
      .control-result {
        min-height: 20px;
        margin-top: 10px;
        color: var(--muted);
        font-size: 0.88rem;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        vertical-align: top;
        text-align: left;
      }
      th {
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
        background: rgba(255,255,255,0.02);
      }
      tbody tr:hover { background: rgba(255,255,255,0.03); }
      .title-cell strong {
        display: block;
        font-size: 1rem;
      }
      .title-cell span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .ready-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .ready-card {
        border: 1px solid var(--border);
        border-radius: 22px;
        padding: 18px;
        background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
      }
      .ready-card h3 {
        margin: 0;
        font-size: 1.08rem;
        letter-spacing: -0.03em;
      }
      .ready-meta {
        margin-top: 6px;
        color: var(--muted);
        font-size: 0.9rem;
      }
      .ready-snippet {
        margin: 14px 0;
        color: #d8e4f3;
        line-height: 1.65;
      }
      .thumb-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .thumb {
        aspect-ratio: 1 / 1;
        border-radius: 16px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
      }
      .thumb img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .mini-link {
        display: inline-flex;
        margin-top: 12px;
        color: var(--accent);
        text-decoration: none;
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .footer-note, .muted, .empty {
        color: var(--muted);
      }
      .empty {
        padding: 22px 18px;
        text-align: center;
      }
      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .tag {
        display: inline-flex;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        color: var(--ink);
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }
      @media (max-width: 1180px) {
        .hero-grid,
        .hero-grid-lower,
        .cards,
        .funnel,
        .control-grid,
        .ready-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 720px) {
        .shell {
          width: min(100vw - 16px, 100%);
          padding-top: 10px;
        }
        .hero, .section {
          border-radius: 20px;
          padding: 18px;
        }
        .thumb-grid {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        th:nth-child(4), td:nth-child(4) {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="eyebrow">CASCA Editorial Agent</div>
        <div class="hero-grid">
          <div class="hero-copy">
            <h1>Operational Control Center</h1>
            <p>
              A real-time command view of the mining funnel, the guaranteed send queue, and the health of the autonomous agents that keep tomorrow’s email ready before 5:00 AM.
            </p>
            <div class="hero-actions">
              <div id="queue-health-pill" class="status-chip status-idle"><span class="status-dot"></span><span>Queue health loading</span></div>
              <div class="meta-pill">Days of Content <span id="queue-depth-days">0 days</span></div>
              <div class="meta-pill">Image approval <span id="image-approval-rate">0%</span></div>
            </div>
          </div>
          <div class="hero-meta">
            <div class="meta-pill">Generated <span id="generated-at">-</span></div>
            <div class="meta-pill">Timezone <span id="timezone">-</span></div>
            <div class="meta-pill">Daily send <span id="daily-send-time">05:00</span></div>
            <div class="meta-pill">Failed today <span id="failed-artists">0</span></div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Inventory</h2>
            <p>The current stock of mined material, guaranteed send depth, and live backlog risk.</p>
          </div>
        </div>
        <div id="summary-cards" class="cards"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Pipeline Funnel</h2>
            <p>The high-integrity artist state machine from discovery through ready-to-send inventory.</p>
          </div>
        </div>
        <div id="funnel" class="funnel"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Ready 5</h2>
            <p>The next five READY drafts, each already carrying three validated artwork images and a finished article body.</p>
          </div>
        </div>
        <div id="ready-grid" class="ready-grid"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Almost Ready</h2>
            <p>Curated drafts stuck at 2/3 images. Manual approval should be used only when you explicitly recognize a candidate artwork.</p>
          </div>
        </div>
        <div id="almost-ready-grid" class="ready-grid"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Librarian Review</h2>
            <p>Abstract RSS titles held back by confidence scoring until you confirm the identity match.</p>
          </div>
        </div>
        <div id="librarian-review-grid" class="ready-grid"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Worker Health</h2>
            <p>Heartbeat-backed process status for Scout, Research, Curator, and Overseer, with 24-hour throughput.</p>
          </div>
        </div>
        <div class="panel">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Last heartbeat</th>
                <th>Processed 24h</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody id="worker-body"></tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Operational Controls</h2>
            <p>Manual overrides for dispatch, aggressive discovery, restart, and re-evaluation workflows.</p>
          </div>
        </div>
        <div class="control-grid">
          <article class="control-card">
            <h3>Force Send Now</h3>
            <p>Ignore the schedule and dispatch the next READY draft immediately through the shared dispatcher.</p>
            <button class="button button-primary" data-action="dispatch">Dispatch next ready</button>
            <div class="control-result" id="result-dispatch"></div>
          </article>
          <article class="control-card">
            <h3>Boost Scout</h3>
            <p>Trigger an aggressive discovery pass now to refill the top of funnel when READY depth starts thinning.</p>
            <button class="button" data-action="boost-scout">Run scout now</button>
            <div class="control-result" id="result-boost-scout"></div>
          </article>
          <article class="control-card">
            <h3>Clear Rejected</h3>
            <p>Move rejected artists back into discovery and wipe rejected drafts so they can be reconsidered cleanly.</p>
            <button class="button button-danger" data-action="clear-rejected">Reopen rejected</button>
            <div class="control-result" id="result-clear-rejected"></div>
          </article>
          <article class="control-card">
            <h3>Clear Cache</h3>
            <p>Reset the mined research cache file if you want the scout to rebuild the shortlist from scratch.</p>
            <button class="button" data-action="clear-cache">Reset cache file</button>
            <div class="control-result" id="result-clear-cache"></div>
          </article>
        </div>
      </section>

      <section class="section">
        <div class="hero-grid-lower">
          <div class="stack">
            <div class="section-head">
              <div>
                <h2>In Progress</h2>
                <p>Drafts still waiting on curation or image completion, which means they cannot serve the next approval email yet.</p>
              </div>
            </div>
            <div class="panel">
              <table>
                <thead>
                  <tr>
                    <th>Draft</th>
                    <th>Status</th>
                    <th>Images</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody id="in-progress-body"></tbody>
              </table>
            </div>
          </div>

          <div class="stack">
            <div class="section-head">
              <div>
                <h2>Publication History</h2>
                <p>The last ten publish or send-related log entries, directly from the database.</p>
              </div>
            </div>
            <div class="panel">
              <table>
                <thead>
                  <tr>
                    <th>Artist</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody id="publishing-body"></tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Recently Mined Artists</h2>
            <p>The shortlist cache that keeps feeding reliable candidates into the queue before generic discovery is needed.</p>
          </div>
        </div>
        <div class="panel">
          <table>
            <thead>
              <tr>
                <th>Artist</th>
                <th>Bio sources</th>
                <th>Artwork candidates</th>
                <th>Eligibility</th>
                <th>Signals</th>
              </tr>
            </thead>
            <tbody id="mined-body"></tbody>
          </table>
        </div>
        <p class="footer-note">
          Auto-refresh: every 60 seconds. JSON feed available at <code>/api/dashboard</code>.
        </p>
      </section>
    </main>

    <script>
      const initialSnapshot = JSON.parse(${JSON.stringify(payload)});

      function formatDate(value) {
        if (!value) return "—";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(date);
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function statusChip(type, label) {
        return '<span class="status-chip ' + type + '"><span class="status-dot"></span><span>' + escapeHtml(label) + '</span></span>';
      }

      function workerChip(worker) {
        if (!worker) {
          return statusChip("status-stale", "stale");
        }
        if (worker.status === "active") return statusChip("status-active", "active");
        if (worker.status === "idle") return statusChip("status-idle", "idle");
        return statusChip("status-stale", "stale");
      }

      function percent(value) {
        return Math.round(value * 100) + "%";
      }

      function render(snapshot) {
        document.getElementById("generated-at").textContent = formatDate(snapshot.generatedAt);
        document.getElementById("timezone").textContent = snapshot.timezone;
        document.getElementById("daily-send-time").textContent = snapshot.health.nextSendHourLocal;
        document.getElementById("failed-artists").textContent = String(snapshot.health.failedArtistsToday);
        document.getElementById("queue-depth-days").textContent = String(snapshot.summary.queueDepthDays) + " day" + (snapshot.summary.queueDepthDays === 1 ? "" : "s");
        document.getElementById("image-approval-rate").textContent = percent(snapshot.imageStats.approvalRate24h);

        const queueHealthPill = document.getElementById("queue-health-pill");
        queueHealthPill.className = "status-chip " + (snapshot.health.queueFloorHealthy ? "status-active" : "status-idle");
        queueHealthPill.innerHTML = '<span class="status-dot"></span><span>' + escapeHtml(
          snapshot.health.queueFloorHealthy
            ? "Queue above minimum send floor"
            : "Queue below minimum send floor"
        ) + '</span>';

        const cards = [
          ["Research cache", snapshot.summary.cacheEntries, snapshot.summary.cacheEligible + " eligible cache records"],
          ["Ready drafts", snapshot.summary.readyDrafts, snapshot.summary.queueDepthDays + " guaranteed send day(s)"],
          ["In progress", snapshot.summary.inProgressDrafts, "Drafts not yet safe to email"],
          ["Approved drafts", snapshot.summary.approvedDrafts, "Already accepted for publication"],
          ["Rejected drafts", snapshot.summary.rejectedDrafts, "Removed from the send queue"],
          ["Awaiting approval", snapshot.summary.sentDrafts, "Sent to the editor, not yet approved"],
          ["Replacement requests", snapshot.summary.replacementRequests, "Pending after manual rejection"],
          ["Curator image gate", snapshot.imageStats.rejected24h, "Rejected images in the last 24h"]
        ];

        document.getElementById("summary-cards").innerHTML = cards.map(([label, value, note]) => {
          return '<article class="card">' +
            '<p class="card-label">' + escapeHtml(label) + '</p>' +
            '<p class="card-value">' + escapeHtml(value) + '</p>' +
            '<p class="card-note">' + escapeHtml(note) + '</p>' +
          '</article>';
        }).join("");

        const funnel = [
          ["Discovered", snapshot.pipeline.discovered, "Raw candidates found and deduped before expensive work starts."],
          ["Researched", snapshot.pipeline.researched, "Biography text cleaned by Gemini with scraping junk stripped out."],
          ["Curated", snapshot.pipeline.curated, "Artwork sourcing passed through visual screening and draft hydration."],
          ["Ready", snapshot.pipeline.ready, "Fully mined artists with a ready-to-send draft behind them."]
        ];

        document.getElementById("funnel").innerHTML = funnel.map(([label, value, note]) => {
          return '<article class="funnel-step">' +
            '<span>' + escapeHtml(label) + '</span>' +
            '<strong>' + escapeHtml(value) + '</strong>' +
            '<div class="funnel-note">' + escapeHtml(note) + '</div>' +
          '</article>';
        }).join("");

        document.getElementById("ready-grid").innerHTML = snapshot.readyQueue.length
          ? snapshot.readyQueue.map((row) => (
              '<article class="ready-card">' +
                '<h3>' + escapeHtml(row.title) + '</h3>' +
                '<div class="ready-meta">' + escapeHtml(row.artistName) + " • Draft #" + escapeHtml(row.draftId) + " • priority " + escapeHtml(row.priority) + '</div>' +
                '<p class="ready-snippet">' + escapeHtml(row.snippet || "No preview available.") + '</p>' +
                '<div class="thumb-grid">' + row.images.map((image) => (
                  '<div class="thumb"><img src="' + escapeHtml(image.url) + '" alt="' + escapeHtml(image.caption || row.title) + '" loading="lazy" /></div>'
                )).join("") + '</div>' +
                '<a class="mini-link" href="/dashboard/draft?id=' + encodeURIComponent(row.draftId) + '">Open draft</a>' +
              '</article>'
            )).join("")
          : '<div class="empty">No READY drafts are available right now.</div>';

        document.getElementById("almost-ready-grid").innerHTML = snapshot.almostReady.length
          ? snapshot.almostReady.map((row) => (
              '<article class="ready-card">' +
                '<h3>' + escapeHtml(row.title) + '</h3>' +
                '<div class="ready-meta">' + escapeHtml(row.artistName) + " • Draft #" + escapeHtml(row.draftId) + " • " + escapeHtml(row.imageCount) + "/3 images</div>" +
                '<div class="thumb-grid">' + row.images.map((image) => (
                  '<div class="thumb"><img src="' + escapeHtml(image.url) + '" alt="' + escapeHtml(image.caption || row.title) + '" loading="lazy" /></div>'
                )).join("") + '</div>' +
                (row.candidates.length
                  ? '<div class="candidate-stack">' + row.candidates.slice(0, 4).map((candidate) => (
                      '<div class="thumb" style="position:relative;">' +
                        '<img src="' + escapeHtml(candidate.url) + '" alt="' + escapeHtml(candidate.caption || row.title) + '" loading="lazy" />' +
                        '<button class="button" style="margin-top:8px;width:100%;" data-action="manual-image-approve" data-draft-id="' + escapeHtml(row.draftId) + '" data-image-url="' + escapeHtml(candidate.url) + '" data-image-caption="' + escapeHtml(candidate.caption || '') + '" data-image-attribution="' + escapeHtml(candidate.attribution || '') + '">Vouch for image</button>' +
                        '<div class="muted" style="margin-top:6px;">' + escapeHtml(candidate.reason || 'Candidate held back by AI gate') + '</div>' +
                      '</div>'
                    )).join("") + '</div>'
                  : '<p class="ready-snippet">No manual candidates saved yet for this draft.</p>') +
                '<div class="control-result" id="result-manual-image-approve-' + escapeHtml(row.draftId) + '"></div>' +
                '<a class="mini-link" href="/dashboard/draft?id=' + encodeURIComponent(row.draftId) + '">Open draft</a>' +
              '</article>'
            )).join("")
          : '<div class="empty">No 2/3 curated drafts are waiting for manual image approval.</div>';

        document.getElementById("librarian-review-grid").innerHTML = snapshot.librarianReview.length
          ? snapshot.librarianReview.map((row) => (
              '<article class="ready-card">' +
                '<h3>' + escapeHtml(row.originalTitle) + '</h3>' +
                '<div class="ready-meta">Proposed artist: ' + escapeHtml(row.resolvedName) + ' • confidence ' + escapeHtml(percent(row.confidence)) + '</div>' +
                '<p class="ready-snippet">' + escapeHtml(row.reasoning || "Low-confidence contextual resolution. Waiting for human review.") + '</p>' +
                '<div class="hero-actions">' +
                  '<button class="button button-primary" data-action="librarian-approve" data-review-id="' + escapeHtml(row.id) + '">Approve match</button>' +
                  '<button class="button button-danger" data-action="librarian-reject" data-review-id="' + escapeHtml(row.id) + '">Ignore</button>' +
                '</div>' +
                '<div class="control-result" id="result-librarian-review-' + escapeHtml(row.id) + '"></div>' +
                '<a class="mini-link" href="' + escapeHtml(row.url) + '" target="_blank" rel="noreferrer">Open source post</a>' +
              '</article>'
            )).join("")
          : '<div class="empty">No librarian review items are waiting for manual confirmation.</div>';

        document.getElementById("worker-body").innerHTML = snapshot.workers.length
          ? snapshot.workers.map((worker) => (
              "<tr>" +
                '<td class="title-cell"><strong>' + escapeHtml(worker.displayName) + '</strong><span>' + escapeHtml(worker.agentName) + (worker.serviceLabel ? " • " + escapeHtml(worker.serviceLabel) : "") + "</span></td>" +
                "<td>" + workerChip(worker) + "</td>" +
                "<td>" + escapeHtml(worker.lastHeartbeat ? formatDate(worker.lastHeartbeat) : "Never") + '<div class="muted">' + escapeHtml(worker.lastSeenMinutes === null ? "No heartbeat yet" : worker.lastSeenMinutes + " minute(s) ago") + "</div></td>" +
                "<td>" + escapeHtml(worker.processed24h) +
                  (worker.approvedImages24h || worker.rejectedImages24h
                    ? '<div class="muted">approved ' + escapeHtml(worker.approvedImages24h) + " • rejected " + escapeHtml(worker.rejectedImages24h) + "</div>"
                    : "") +
                "</td>" +
                "<td>" + escapeHtml(worker.detail) + (worker.pid ? '<div class="muted">pid ' + escapeHtml(worker.pid) + "</div>" : "") + '<div style="margin-top:10px;"><button class="button" data-action="restart-agent" data-agent="' + escapeHtml(worker.agentName) + '">Restart agent</button></div></td>' +
              "</tr>"
            )).join("")
          : '<tr><td colspan="5" class="empty">No worker heartbeat data yet.</td></tr>';

        document.getElementById("in-progress-body").innerHTML = snapshot.inProgress.length
          ? snapshot.inProgress.map((row) => (
              "<tr>" +
                '<td class="title-cell"><strong>' + escapeHtml(row.title) + '</strong><span>' + escapeHtml(row.artistName) + " • Draft #" + escapeHtml(row.draftId) + " • priority " + escapeHtml(row.priority) + '</span><div><a class="mini-link" href="/dashboard/draft?id=' + encodeURIComponent(row.draftId) + '">Open draft</a></div></td>' +
                "<td>" + escapeHtml(row.status) + "</td>" +
                "<td>" + escapeHtml(row.imageCount) + "</td>" +
                "<td>" + escapeHtml(formatDate(row.createdAt)) + "</td>" +
              "</tr>"
            )).join("")
          : '<tr><td colspan="4" class="empty">No hydrating drafts right now.</td></tr>';

        document.getElementById("publishing-body").innerHTML = snapshot.publicationHistory.length
          ? snapshot.publicationHistory.map((row) => (
              "<tr>" +
                '<td class="title-cell"><strong>' + escapeHtml(row.artistName) + '</strong><span>' + escapeHtml(row.draftTitle) + "</span></td>" +
                "<td>" + (row.status === "published" ? statusChip("status-active", "published") : statusChip("status-stale", "failed")) + "</td>" +
                "<td>" + escapeHtml(formatDate(row.publishedAt)) + "</td>" +
              "</tr>"
            )).join("")
          : '<tr><td colspan="3" class="empty">No publishing records yet.</td></tr>';

        document.getElementById("mined-body").innerHTML = snapshot.mined.length
          ? snapshot.mined.map((row) => {
              const signals = [];
              if (row.category) signals.push(row.category);
              if (row.states) signals.push(row.states);
              if (row.practice) signals.push(row.practice);
              if (row.publishedExternally) signals.push("already in blog");
              if (row.localArtistStatus) signals.push("local:" + row.localArtistStatus);
              signals.push("drafts:" + (row.draftStatuses.length ? row.draftStatuses.join(",") : "none"));

              return "<tr>" +
                '<td class="title-cell"><strong>' + escapeHtml(row.artistName) + '</strong><span>Mined ' + escapeHtml(formatDate(row.minedAt)) + (row.shortlistRank ? " • Rank " + escapeHtml(row.shortlistRank) : "") + "</span></td>" +
                "<td>" + escapeHtml(row.biographySourceCount) + "</td>" +
                "<td>" + escapeHtml(row.artworkCandidateCount) + "</td>" +
                "<td>" +
                  (row.eligible
                    ? '<a href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '" style="text-decoration:none;">' + statusChip("status-active", "eligible") + "</a>" +
                      '<div><a class="mini-link" href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '">Open mined</a></div>'
                    : statusChip("status-idle", "blocked")) +
                  (row.hasLocalDraft
                    ? '<div><a class="mini-link" href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '#drafts">Open draft</a></div>'
                    : '') +
                "</td>" +
                '<td><div class="tags">' + signals.map((signal) => '<span class="tag">' + escapeHtml(signal) + "</span>").join("") + "</div></td>" +
              "</tr>";
            }).join("")
          : '<tr><td colspan="5" class="empty">No mined artists cached yet.</td></tr>';
      }

      async function postAction(action, body, resultId) {
        const resultNode = document.getElementById(resultId || ("result-" + action));
        if (resultNode) resultNode.textContent = "Running...";
        try {
          const response = await fetch("/api/actions/" + action, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body || {})
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || ("HTTP " + response.status));
          }
          if (resultNode) {
            resultNode.textContent = payload.message || "Done.";
          }
          await refresh();
        } catch (error) {
          if (resultNode) {
            resultNode.textContent = error instanceof Error ? error.message : String(error);
          }
        }
      }

      async function refresh() {
        try {
          const response = await fetch("/api/dashboard", { headers: { accept: "application/json" } });
          if (!response.ok) return;
          const snapshot = await response.json();
          render(snapshot);
        } catch {
          // Keep the last successful payload on screen.
        }
      }

      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const action = target.getAttribute("data-action");
        if (!action) return;
        event.preventDefault();
        if (action === "restart-agent") {
          postAction(action, { agent: target.getAttribute("data-agent") });
          return;
        }
        if (action === "manual-image-approve") {
          postAction(action, {
            draftId: Number(target.getAttribute("data-draft-id") || "0"),
            imageUrl: target.getAttribute("data-image-url") || "",
            caption: target.getAttribute("data-image-caption") || "",
            attribution: target.getAttribute("data-image-attribution") || ""
          }, "result-manual-image-approve-" + (target.getAttribute("data-draft-id") || ""));
          return;
        }
        if (action === "librarian-approve" || action === "librarian-reject") {
          postAction(action, {
            reviewId: Number(target.getAttribute("data-review-id") || "0")
          }, "result-librarian-review-" + (target.getAttribute("data-review-id") || ""));
          return;
        }
        postAction(action, {});
      });

      render(initialSnapshot);
      window.setInterval(refresh, 60000);
    </script>
  </body>
</html>`;
}

export function renderMinedArtistDetailHtml(snapshot: MinedArtistDetailSnapshot): string {
  const cache = snapshot.cacheEntry;
  const displayArtworkCandidates = selectDisplayArtworkCandidates(
    snapshot.artistName,
    cache.artworkCandidates
  );
  const draftSections = snapshot.drafts.length
    ? snapshot.drafts
        .map(
          (draft) => `
            <section class="panel">
              <div class="panel-head">
                <div>
                  <h3>${escapeHtml(draft.title)}</h3>
                  <p>${escapeHtml(draft.status.toUpperCase())} • Draft #${draft.id} • ${escapeHtml(formatDisplayDate(draft.createdAt))}</p>
                </div>
                <div class="pill">${draft.imageCount} image(s)</div>
              </div>
              ${
                draft.subtitle
                  ? `<p class="subtitle">${escapeHtml(draft.subtitle)}</p>`
                  : ''
              }
              <article class="article-copy">${renderArticleHtml(draft.content)}</article>
              <div class="draft-artwork-grid">
                ${
                  draft.images.length
                    ? draft.images
                        .map(
                          (image) => `
                            <article class="artwork-card">
                              <div class="artwork-image-shell">
                                <img class="artwork-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.caption || draft.title)}" loading="lazy" />
                              </div>
                              <div class="artwork-body">
                                <strong>${escapeHtml(image.caption || 'Artwork')}</strong>
                                <p class="muted">${escapeHtml(image.attribution || 'Artwork image')}</p>
                              </div>
                            </article>
                          `
                        )
                        .join('')
                    : `<div class="empty-note">No validated draft images stored for this draft yet.</div>`
                }
              </div>
            </section>
          `
        )
        .join('')
    : `
      <section class="panel empty-panel">
        <p>No local draft has been synthesized for this mined artist yet. What you can read below is the cached mining material: biographies, summaries, and artwork candidates.</p>
      </section>
    `;

  const bioRows = cache.biographySources.length
    ? cache.biographySources
        .map(
          (source) => `
            <article class="source-card">
              <div class="source-meta">
                <strong>${escapeHtml(source.title)}</strong>
                <span>${escapeHtml(source.institution)} • credibility ${source.credibilityScore}</span>
              </div>
              <p>${escapeHtml(source.summary || 'No cached summary.')}</p>
              <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">Open source</a>
            </article>
          `
        )
        .join('')
    : `<div class="empty-note">No biography sources cached for this artist.</div>`;

  const artworkGallery = displayArtworkCandidates.length
    ? displayArtworkCandidates
        .map(
          (candidate) => `
            <article class="artwork-card">
              <div class="artwork-image-shell">
                ${
                  candidate.imageUrl
                    ? `<img class="artwork-image" src="${escapeHtml(candidate.imageUrl)}" alt="${escapeHtml(candidate.title || snapshot.artistName)}" loading="lazy" />`
                    : `<div class="artwork-placeholder">No preview</div>`
                }
              </div>
              <div class="artwork-body">
                <strong>${escapeHtml(candidate.title || 'Untitled candidate')}</strong>
                <p class="muted">${escapeHtml(candidate.sourceDomain)} • ${escapeHtml(candidate.sourceType)} • confidence ${escapeHtml(candidate.confidence)}</p>
                <a href="${escapeHtml(candidate.pageUrl)}" target="_blank" rel="noreferrer">Open source page</a>
              </div>
            </article>
          `
        )
        .join('')
    : `<div class="empty-note">No validated artwork previews are ready for this artist yet. The raw mining cache exists, but the candidate images were filtered out because they looked unrelated, too generic, portrait-like, news-like, or low-trust for editorial use.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(snapshot.artistName)} • CASCA Mined Detail</title>
    <style>
      :root {
        --bg: #f4f0e8;
        --ink: #14110f;
        --muted: #6d6257;
        --card: rgba(255,252,247,0.88);
        --border: rgba(20,17,15,0.12);
        --accent: #b45f2f;
        --ok: #4e5a3d;
        --warn: #8f2f2f;
        --shadow: 0 24px 60px rgba(70,46,24,0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(180,95,47,0.16), transparent 28%),
          linear-gradient(180deg, #f8f4ec 0%, var(--bg) 100%);
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      }
      .shell {
        width: min(1200px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .hero, .panel {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .hero {
        padding: 24px;
        margin-bottom: 18px;
      }
      .back {
        display: inline-block;
        margin-bottom: 14px;
        color: var(--accent);
        text-decoration: none;
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(2rem, 4vw, 3.4rem);
        line-height: 0.98;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(20,17,15,0.06);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }
      .ok { color: var(--ok); }
      .warn { color: var(--warn); }
      .grid {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 18px;
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .panel {
        padding: 20px;
      }
      .panel h2, .panel h3 {
        margin: 0 0 10px;
      }
      .panel-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
        margin-bottom: 10px;
      }
      .panel-head p {
        margin: 4px 0 0;
        color: var(--muted);
      }
      .article-copy {
        font-size: 1.02rem;
        line-height: 1.8;
      }
      .article-copy p {
        margin: 0 0 16px;
      }
      .subtitle {
        color: var(--muted);
        font-style: italic;
        margin: 0 0 18px;
      }
      .source-list {
        display: grid;
        gap: 14px;
      }
      .artwork-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .draft-artwork-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        margin-top: 18px;
      }
      .source-card {
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 16px;
        background: rgba(255,255,255,0.58);
      }
      .artwork-card {
        border: 1px solid var(--border);
        border-radius: 18px;
        overflow: hidden;
        background: rgba(255,255,255,0.58);
      }
      .artwork-image-shell {
        aspect-ratio: 4 / 3;
        background: rgba(20,17,15,0.04);
      }
      .artwork-image {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .artwork-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        color: var(--muted);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }
      .artwork-body {
        padding: 14px;
      }
      .artwork-body strong {
        display: block;
        margin-bottom: 8px;
      }
      .artwork-body p {
        margin: 0 0 10px;
      }
      .source-meta span, .muted, .empty-note {
        color: var(--muted);
      }
      .source-card p {
        margin: 10px 0;
        line-height: 1.65;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 10px;
        border-bottom: 1px solid rgba(20,17,15,0.08);
        text-align: left;
        vertical-align: top;
      }
      th {
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      ul {
        margin: 0;
        padding-left: 18px;
      }
      li + li {
        margin-top: 6px;
      }
      .empty-panel {
        color: var(--muted);
      }
      a {
        color: var(--accent);
      }
      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 10px 14px;
        border-radius: 999px;
        text-decoration: none;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.72);
        color: var(--ink);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      @media (max-width: 960px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .artwork-grid {
          grid-template-columns: 1fr;
        }
        .draft-artwork-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <a class="back" href="/dashboard">Back to dashboard</a>
        <h1>${escapeHtml(snapshot.artistName)}</h1>
        <p>Read the cached mining payload for this artist and, when available, the synthesized draft already created from it.</p>
        <div class="meta">
          <span class="pill ${cache.eligible ? 'ok' : 'warn'}">${cache.eligible ? 'Eligible' : 'Blocked'}</span>
          <span class="pill">Mined ${escapeHtml(formatDisplayDate(cache.minedAt))}</span>
          ${cache.category ? `<span class="pill">${escapeHtml(cache.category)}</span>` : ''}
          ${cache.states ? `<span class="pill">${escapeHtml(cache.states)}</span>` : ''}
          ${cache.practice ? `<span class="pill">${escapeHtml(cache.practice)}</span>` : ''}
          ${typeof cache.shortlistRank === 'number' ? `<span class="pill">Rank ${cache.shortlistRank}</span>` : ''}
        </div>
        <div class="hero-actions">
          ${
            snapshot.drafts.length
              ? `<a class="button" href="#drafts">Open draft</a>`
              : `<span class="pill">No local draft yet</span>`
          }
          <a class="button" href="/api/dashboard/mined?artist=${encodeURIComponent(snapshot.artistName)}" target="_blank" rel="noreferrer">Open JSON</a>
        </div>
      </section>

      <section class="grid">
        <div class="stack">
          <section id="drafts" class="panel">
            <h2>Local Drafts</h2>
            ${draftSections}
          </section>

          <section class="panel">
            <h2>Biography Sources</h2>
            <div class="source-list">${bioRows}</div>
          </section>
        </div>

        <div class="stack">
          <section class="panel">
            <h2>Status Signals</h2>
            <ul>
              <li>Published externally: ${cache.publishedExternally ? 'yes' : 'no'}</li>
              <li>Local artist status: ${escapeHtml(cache.localArtistStatus || 'none')}</li>
              <li>Draft statuses: ${escapeHtml(cache.draftStatuses.length ? cache.draftStatuses.join(', ') : 'none')}</li>
              <li>Local source count: ${snapshot.localArtist ? snapshot.localArtist.sourceCount : 0}</li>
              <li>Local artist id: ${snapshot.localArtist ? snapshot.localArtist.id : 'not imported yet'}</li>
            </ul>
          </section>

          <section class="panel">
            <h2>Mining Notes</h2>
            ${
              cache.notes.length
                ? `<ul>${cache.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
                : `<p class="empty-note">No special notes recorded for this artist.</p>`
            }
          </section>

          <section class="panel">
            <h2>Artwork Candidates</h2>
            ${
              displayArtworkCandidates.length > 0 && displayArtworkCandidates.length < cache.artworkCandidates.length
                ? `<p class="empty-note">Showing only the artwork candidates that passed the dashboard's stricter display filter.</p>`
                : ''
            }
            <div class="artwork-grid">${artworkGallery}</div>
          </section>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

export async function getDraftDetailSnapshot(
  draftId: number
): Promise<DraftDetailSnapshot | null> {
  if (!Number.isFinite(draftId) || draftId <= 0) {
    return null;
  }

  const config = getConfig();
  const timezone =
    config.env.appTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const draft = await draftOps.findByIdWithImages(draftId);
  if (!draft) {
    return null;
  }

  const artist = await artistOps.findById(draft.artist_id);
  if (!artist) {
    return null;
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    draft: {
      id: draft.id!,
      status: draft.status,
      title: draft.title,
      subtitle: draft.subtitle,
      content: draft.content,
      createdAt: draft.created_at ?? null,
      sentAt: draft.sent_at ?? null,
      imageCount: draft.parsedImages.length,
      images: draft.parsedImages,
    },
    artist: {
      id: artist.id!,
      name: artist.full_name,
      status: artist.status,
      birthplaceState: artist.birthplace_state,
      visualPractice: artist.visual_practice,
    },
  };
}

export function renderDraftDetailHtml(snapshot: DraftDetailSnapshot): string {
  const imageGallery = snapshot.draft.images.length
    ? snapshot.draft.images
        .map(
          (image) => `
            <article class="artwork-card">
              <div class="artwork-image-shell">
                <img class="artwork-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.caption || snapshot.artist.name)}" loading="lazy" />
              </div>
              <div class="artwork-body">
                <strong>${escapeHtml(image.caption || 'Artwork')}</strong>
                <p class="muted">${escapeHtml(image.attribution || 'Artwork image')}</p>
              </div>
            </article>
          `
        )
        .join('')
    : `<div class="empty-note">This draft does not have validated artwork images yet.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(snapshot.draft.title)} • CASCA Draft</title>
    <style>
      :root {
        --bg: #f4f0e8;
        --ink: #14110f;
        --muted: #6d6257;
        --card: rgba(255,252,247,0.88);
        --border: rgba(20,17,15,0.12);
        --accent: #b45f2f;
        --ok: #4e5a3d;
        --warn: #8f2f2f;
        --shadow: 0 24px 60px rgba(70,46,24,0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(180,95,47,0.16), transparent 28%),
          linear-gradient(180deg, #f8f4ec 0%, var(--bg) 100%);
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      }
      .shell {
        width: min(1200px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .hero, .panel {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .hero { padding: 24px; margin-bottom: 18px; }
      .panel { padding: 20px; }
      .back {
        display: inline-block;
        margin-bottom: 14px;
        color: var(--accent);
        text-decoration: none;
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 { margin: 0 0 10px; font-size: clamp(2rem, 4vw, 3.2rem); line-height: 1.02; }
      .meta, .hero-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .pill, .button {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(20,17,15,0.06);
        border: 1px solid var(--border);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        text-decoration: none;
        color: var(--ink);
      }
      .grid { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 18px; }
      .stack { display: grid; gap: 18px; }
      .article-copy { font-size: 1.04rem; line-height: 1.85; }
      .article-copy p { margin: 0 0 16px; }
      .subtitle { color: var(--muted); font-style: italic; margin: 0 0 18px; }
      .artwork-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .artwork-card { border: 1px solid var(--border); border-radius: 18px; overflow: hidden; background: rgba(255,255,255,0.58); }
      .artwork-image-shell { aspect-ratio: 4 / 3; background: rgba(20,17,15,0.04); }
      .artwork-image { display: block; width: 100%; height: 100%; object-fit: cover; }
      .artwork-body { padding: 14px; }
      .artwork-body strong { display: block; margin-bottom: 8px; }
      .muted, .empty-note { color: var(--muted); }
      ul { margin: 0; padding-left: 18px; }
      li + li { margin-top: 6px; }
      @media (max-width: 960px) {
        .grid { grid-template-columns: 1fr; }
        .artwork-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <a class="back" href="/dashboard">Back to dashboard</a>
        <h1>${escapeHtml(snapshot.draft.title)}</h1>
        <p>Read the full draft and inspect the validated artwork images attached to it.</p>
        <div class="meta">
          <span class="pill">Draft #${snapshot.draft.id}</span>
          <span class="pill">${escapeHtml(snapshot.artist.name)}</span>
          <span class="pill">${escapeHtml(snapshot.draft.status)}</span>
          <span class="pill">${snapshot.draft.imageCount} image(s)</span>
          ${snapshot.artist.visualPractice ? `<span class="pill">${escapeHtml(snapshot.artist.visualPractice)}</span>` : ''}
          ${snapshot.artist.birthplaceState ? `<span class="pill">${escapeHtml(snapshot.artist.birthplaceState)}</span>` : ''}
        </div>
        <div class="hero-actions">
          <a class="button" href="#images">Jump to images</a>
        </div>
      </section>

      <section class="grid">
        <div class="stack">
          <section class="panel">
            <h2>Article</h2>
            ${snapshot.draft.subtitle ? `<p class="subtitle">${escapeHtml(snapshot.draft.subtitle)}</p>` : ''}
            <article class="article-copy">${renderArticleHtml(snapshot.draft.content)}</article>
          </section>
        </div>

        <div class="stack">
          <section class="panel">
            <h2>Draft Status</h2>
            <ul>
              <li>Artist: ${escapeHtml(snapshot.artist.name)}</li>
              <li>Draft status: ${escapeHtml(snapshot.draft.status)}</li>
              <li>Created: ${escapeHtml(formatDisplayDate(snapshot.draft.createdAt))}</li>
              <li>Sent: ${escapeHtml(formatDisplayDate(snapshot.draft.sentAt))}</li>
              <li>Image count: ${snapshot.draft.imageCount}</li>
            </ul>
          </section>
        </div>
      </section>

      <section id="images" class="panel" style="margin-top:18px;">
        <h2>Validated Artwork Images</h2>
        <div class="artwork-grid">${imageGallery}</div>
      </section>
    </main>
  </body>
</html>`;
}

function renderArticleHtml(content: string): string {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return `<p class="muted">No synthesized article content available yet.</p>`;
  }

  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
}

function selectDisplayArtworkCandidates(
  artistName: string,
  candidates: ArtworkResearchCandidate[]
): ArtworkResearchCandidate[] {
  return candidates.filter((candidate) => isDisplayableArtworkCandidate(artistName, candidate));
}

function isDisplayableArtworkCandidate(
  artistName: string,
  candidate: ArtworkResearchCandidate
): boolean {
  if (!candidate.imageUrl) {
    return false;
  }

  const title = normalizeLooseText(candidate.title || '');
  const pageUrl = normalizeLooseText(candidate.pageUrl || '');
  const imageUrl = normalizeLooseText(candidate.imageUrl || '');
  const domain = normalizeLooseText(candidate.sourceDomain || '');
  const artistTokens = buildArtistSearchTokens(artistName);
  const overlap = artistTokens.filter(
    (token) => title.includes(token) || pageUrl.includes(token) || imageUrl.includes(token)
  ).length;

  const blockedDomainFragments = [
    'cnn',
    'pixabay',
    'stablediffusion',
    'deepdreamgenerator',
    'mundo',
    'edition.cnn',
    'facebook',
    'instagram',
    'twitter',
    'x.com',
    'tiktok',
    'youtube',
    'pinterest',
    'shutterstock',
    'gettyimages',
    'alamy',
    'istock',
  ];

  if (blockedDomainFragments.some((fragment) => domain.includes(fragment))) {
    return false;
  }

  const blockedTitleFragments = [
    'photo',
    'photos',
    'president',
    'career',
    'celebra',
    'celebrates',
    'manga',
    'style',
    'free',
    'pixabay',
    'stable diffusion',
    'ai art',
    'portrait',
    'artist portrait',
    'interview',
    'presidente',
    'news',
    'cnn',
    'wall art',
    'beautiful wall art',
    'generator',
  ];

  if (blockedTitleFragments.some((fragment) => title.includes(fragment))) {
    return false;
  }

  if (candidate.sourceType === 'image-search' && candidate.confidence < 0.72) {
    return false;
  }

  const trustedArtDomains = [
    'escritoriodearte',
    'artsy',
    'mutualart',
    'alchimiagallery',
    'guiadasartes',
    'recifeartepublica',
    'artepopularbrasil',
    'tracunhaemartebarro',
    'wikimedia',
    'wikipedia',
    'enciclopedia.itaucultural',
    'itaucultural',
  ];

  const trustedDomain = trustedArtDomains.some((fragment) => domain.includes(fragment));

  if (trustedDomain) {
    return true;
  }

  if (overlap >= Math.min(2, artistTokens.length)) {
    return true;
  }

  return false;
}

function buildArtistSearchTokens(artistName: string): string[] {
  const normalized = normalizeLooseText(artistName);
  const stopwords = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !stopwords.has(token));
}

function normalizeLooseText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function formatDisplayDate(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  const normalized = /z$/i.test(value) || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function countFailedArtistsToday(timezone: string): Promise<number> {
  const filePath = path.join(
    process.cwd(),
    'logs',
    'daily',
    `failed-artists-${formatDateInTimezone(new Date(), timezone)}.json`
  );

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function formatDateInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function safeParseImages(raw: string | null): Image[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Image[]) : [];
  } catch {
    return [];
  }
}

function escapeForInlineScript(value: string): string {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
