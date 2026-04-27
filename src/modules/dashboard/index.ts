import path from 'node:path';
import fs from 'node:fs/promises';

import { getConfig } from '../../config/index.js';
import { query } from '../../db/client.js';
import { artistOps, draftOps, publishingOps, sourceOps } from '../../db/operations/index.js';
import { ArtistResearchCache } from '../research-cache/index.js';
import { EmailModule } from '../email/index.js';
import type { Image } from '../../types/index.js';
import type {
  ArtistResearchCacheEntry,
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
  worker: string;
  phase: string;
  detail: string;
  updatedAt: string | null;
  lastExitCode: number | null;
  successCount: number;
  failureCount: number;
  healthy: boolean;
}

export interface DashboardSnapshot {
  generatedAt: string;
  timezone: string;
  summary: {
    cacheEntries: number;
    cacheEligible: number;
    verifiedArtists: number;
    pendingDrafts: number;
    readyPendingDrafts: number;
    sentDrafts: number;
    approvedDrafts: number;
    rejectedDrafts: number;
    replacementRequests: number;
  };
  health: {
    backlogTarget: number;
    queueFloorHealthy: boolean;
    nextSendHourLocal: string;
    failedArtistsToday: number;
  };
  workers: {
    researchMiner: WorkerStatusSnapshot | null;
    draftHydrator: WorkerStatusSnapshot | null;
  };
  queue: Array<{
    draftId: number;
    artistId: number;
    artistName: string;
    title: string;
    createdAt: string | null;
    sentAt: string | null;
    imageCount: number;
    ready: boolean;
  }>;
  inProgress: Array<{
    draftId: number;
    artistId: number;
    artistName: string;
    title: string;
    createdAt: string | null;
    sentAt: string | null;
    imageCount: number;
    ready: boolean;
  }>;
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
  recentPublishing: Array<{
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
const READY_MIN_IMAGES = 3;
const WORKER_STALE_MINUTES = 15;

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const config = getConfig();
  const timezone =
    config.env.appTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const researchCache = new ArtistResearchCache();
  const cacheEntries = await researchCache.readAll();
  const draftStatusCounts = query.all<DashboardCountRow>(
    `SELECT status, COUNT(*) as count FROM drafts GROUP BY status`
  );
  const draftCountMap = new Map(draftStatusCounts.map((row) => [row.status, row.count]));
  const verifiedArtists = await artistOps.countByStatus('verified');
  const email = new EmailModule(config.env.resendApiKey);
  const pendingDraftRows = query.all<DashboardDraftRow>(
    `SELECT
       d.id,
       d.artist_id,
       a.full_name AS artist_name,
       d.title,
       d.status,
       d.created_at,
       d.sent_at,
       d.images
     FROM drafts d
     INNER JOIN artists a ON a.id = d.artist_id
     WHERE d.status = 'pending'
     ORDER BY datetime(d.created_at) ASC`
  );

  const pendingQueue = await Promise.all(pendingDraftRows.map(async (row) => {
    const parsedImages = safeParseImages(row.images);
    const sendability =
      parsedImages.length >= READY_MIN_IMAGES
        ? await email.assessDraftSendability({
            draftId: row.id,
            images: parsedImages,
            bypassDailyCap: true,
          })
        : { sendable: false };
    return {
      draftId: row.id,
      artistId: row.artist_id,
      artistName: row.artist_name,
      title: row.title,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      imageCount: parsedImages.length,
      ready: Boolean(sendability.sendable),
    };
  }));
  const readyQueue = pendingQueue.filter((row) => row.ready);
  const inProgressQueue = pendingQueue.filter((row) => !row.ready);

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
     ORDER BY datetime(p.published_at) DESC
     LIMIT 12`
  );

  const recentPublishing = recentPublishingRows.map((row) => ({
    id: row.id,
    draftId: row.draft_id,
    artistName: row.artist_name,
    draftTitle: row.draft_title,
    publishedAt: row.published_at,
    status: row.medium_url ? ('published' as const) : ('failed' as const),
    detail: row.medium_url ?? row.error_message,
  }));

  const [researchMiner, draftHydrator] = await Promise.all([
    readWorkerStatus('research-miner-status.json', 'research-miner'),
    readWorkerStatus('draft-hydrator-status.json', 'draft-hydrator'),
  ]);

  const mined = [...cacheEntries]
    .sort((a, b) => (b.minedAt ?? '').localeCompare(a.minedAt ?? ''))
    .slice(0, 120)
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
      verifiedArtists,
      pendingDrafts: draftCountMap.get('pending') ?? 0,
      readyPendingDrafts: readyQueue.length,
      sentDrafts: draftCountMap.get('sent') ?? 0,
      approvedDrafts: draftCountMap.get('approved') ?? 0,
      rejectedDrafts: draftCountMap.get('rejected') ?? 0,
      replacementRequests,
    },
    health: {
      backlogTarget: BACKLOG_TARGET,
      queueFloorHealthy: readyQueue.length >= BACKLOG_TARGET,
      nextSendHourLocal: '05:00',
      failedArtistsToday: await countFailedArtistsToday(timezone),
    },
    workers: {
      researchMiner,
      draftHydrator,
    },
    queue: readyQueue,
    inProgress: inProgressQueue,
    mined: await Promise.all(mined),
    recentPublishing,
  };
}

async function readWorkerStatus(
  filename: string,
  worker: string
): Promise<WorkerStatusSnapshot | null> {
  try {
    const filePath = path.resolve(process.cwd(), 'logs', 'runtime', filename);
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkerStatusSnapshot> & {
      detail?: string;
      phase?: string;
      updatedAt?: string | null;
      lastExitCode?: number | null;
      successCount?: number;
      failureCount?: number;
    };

    const updatedAt = parsed.updatedAt ?? null;
    const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    const stale =
      !Number.isFinite(updatedAtMs) ||
      Date.now() - updatedAtMs > WORKER_STALE_MINUTES * 60 * 1000;
    const lastExitCode =
      typeof parsed.lastExitCode === 'number' ? parsed.lastExitCode : null;
    const healthy = !stale && (lastExitCode === null || lastExitCode === 0 || lastExitCode === 2);

    return {
      worker,
      phase: parsed.phase ?? 'unknown',
      detail: parsed.detail ?? 'No detail available',
      updatedAt,
      lastExitCode,
      successCount: parsed.successCount ?? 0,
      failureCount: parsed.failureCount ?? 0,
      healthy,
    };
  } catch {
    return null;
  }
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
    <title>CASCA Mining Dashboard</title>
    <style>
      :root {
        --bg: #f4f0e8;
        --bg-deep: #e7dcc7;
        --ink: #14110f;
        --muted: #6d6257;
        --card: rgba(255, 252, 247, 0.82);
        --border: rgba(20, 17, 15, 0.12);
        --accent: #b45f2f;
        --accent-soft: rgba(180, 95, 47, 0.16);
        --olive: #4e5a3d;
        --olive-soft: rgba(78, 90, 61, 0.16);
        --danger: #8f2f2f;
        --danger-soft: rgba(143, 47, 47, 0.14);
        --shadow: 0 24px 60px rgba(70, 46, 24, 0.12);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        color: var(--ink);
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
        background:
          radial-gradient(circle at top left, rgba(180, 95, 47, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(78, 90, 61, 0.18), transparent 24%),
          linear-gradient(180deg, var(--bg) 0%, #f8f4ec 48%, #f3ede2 100%);
        min-height: 100vh;
      }

      .shell {
        width: min(1400px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }

      .hero {
        position: relative;
        overflow: hidden;
        background: linear-gradient(135deg, rgba(20,17,15,0.96), rgba(58,42,28,0.92));
        color: #f7f1e7;
        border-radius: 28px;
        padding: 28px;
        box-shadow: var(--shadow);
      }

      .hero::after {
        content: "";
        position: absolute;
        inset: auto -10% -40% 45%;
        height: 280px;
        background: radial-gradient(circle, rgba(180,95,47,0.38), transparent 58%);
        pointer-events: none;
      }

      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font: 600 11px/1.4 ui-monospace, "SFMono-Regular", Menlo, monospace;
        color: rgba(247, 241, 231, 0.72);
        margin-bottom: 16px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(2rem, 4vw, 3.9rem);
        line-height: 0.96;
        max-width: 9ch;
      }

      .hero-grid {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: 20px;
        align-items: end;
      }

      .hero-copy p {
        margin: 0;
        max-width: 66ch;
        color: rgba(247, 241, 231, 0.8);
        font-size: 1.05rem;
        line-height: 1.65;
      }

      .hero-meta {
        display: grid;
        gap: 10px;
        justify-items: end;
      }

      .meta-pill {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.08);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }

      .section {
        margin-top: 22px;
        background: var(--card);
        backdrop-filter: blur(10px);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 22px;
        box-shadow: var(--shadow);
      }

      .readiness-strip {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        margin-top: 22px;
      }

      .readiness-card {
        border-radius: 22px;
        padding: 20px;
        border: 1px solid var(--border);
        box-shadow: var(--shadow);
      }

      .readiness-card h2 {
        margin: 0 0 8px;
        font-size: 1.5rem;
      }

      .readiness-card p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }

      .readiness-ready {
        background: linear-gradient(135deg, rgba(78,90,61,0.14), rgba(255,255,255,0.75));
      }

      .readiness-progress {
        background: linear-gradient(135deg, rgba(180,95,47,0.14), rgba(255,255,255,0.75));
      }

      .readiness-value {
        display: block;
        margin-top: 14px;
        font-size: 3rem;
        line-height: 1;
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
        font-size: 1.6rem;
      }

      .section-head p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 0.98rem;
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }

      .card {
        background: rgba(255,255,255,0.64);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 16px;
      }

      .card-label {
        margin: 0 0 8px;
        color: var(--muted);
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .card-value {
        margin: 0;
        font-size: 2rem;
        line-height: 1;
      }

      .card-note {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 0.95rem;
      }

      .status-ok, .status-warn, .status-danger {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 8px 12px;
        font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }

      .status-ok { background: var(--olive-soft); color: var(--olive); }
      .status-warn { background: var(--accent-soft); color: var(--accent); }
      .status-danger { background: var(--danger-soft); color: var(--danger); }

      .split {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 18px;
      }

      .panel {
        background: rgba(255,255,255,0.55);
        border: 1px solid var(--border);
        border-radius: 18px;
        overflow: hidden;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        padding: 12px 14px;
        border-bottom: 1px solid rgba(20,17,15,0.08);
        vertical-align: top;
        text-align: left;
      }

      th {
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
        background: rgba(20,17,15,0.03);
      }

      tbody tr:hover {
        background: rgba(20,17,15,0.03);
      }

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

      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .tag {
        display: inline-flex;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(20,17,15,0.06);
        color: var(--ink);
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
      }

      .action-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: 999px;
        border: 1px solid rgba(20,17,15,0.12);
        background: rgba(255,255,255,0.72);
        color: var(--ink);
        text-decoration: none;
        font: 600 11px/1.2 ui-monospace, "SFMono-Regular", Menlo, monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .muted {
        color: var(--muted);
      }

      .empty {
        padding: 26px 18px;
        color: var(--muted);
        text-align: center;
      }

      .footer-note {
        margin-top: 18px;
        color: var(--muted);
        font-size: 0.92rem;
      }

      @media (max-width: 1080px) {
        .hero-grid, .split, .cards {
          grid-template-columns: 1fr;
        }

        .hero-meta {
          justify-items: start;
        }
      }

      @media (max-width: 720px) {
        .shell {
          width: min(100vw - 20px, 100%);
          padding-top: 14px;
        }

        .hero, .section {
          border-radius: 20px;
          padding: 18px;
        }

        th:nth-child(4), td:nth-child(4),
        th:nth-child(5), td:nth-child(5) {
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
            <h1>Mining Dashboard</h1>
            <p>
              Monitor the live state of artist discovery, pre-mined research, and the approval queue in one place.
              This panel refreshes automatically and is built directly from the local SQLite database plus the cumulative research cache.
            </p>
          </div>
          <div class="hero-meta">
            <div class="meta-pill">Generated <span id="generated-at">-</span></div>
            <div class="meta-pill">Timezone <span id="timezone">-</span></div>
            <div id="queue-health-pill" class="status-warn">Queue health loading</div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Overview</h2>
            <p>Backlog target, cache size, and the current state of the editorial queue.</p>
          </div>
        </div>
        <div id="summary-cards" class="cards"></div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>24/7 Workers</h2>
            <p>Two continuous miners run in parallel: one accumulates reliable artist research, and the other hydrates approved artists into fully-ready drafts.</p>
          </div>
        </div>
        <div id="worker-cards" class="cards"></div>
      </section>

      <section class="readiness-strip">
        <article class="readiness-card readiness-ready">
          <h2>100% Ready To Send</h2>
          <p>These drafts already have approved text and validated artwork images. This is the only group that counts as truly ready for the next email.</p>
          <strong id="ready-now-count" class="readiness-value">0</strong>
        </article>
        <article class="readiness-card readiness-progress">
          <h2>Text Ready, Images Missing</h2>
          <p>These drafts are not ready yet. They may have article text, but they still need clean artwork images before they can enter the send queue.</p>
          <strong id="in-progress-count" class="readiness-value">0</strong>
        </article>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Ready To Send And Publishing</h2>
            <p>Only drafts that already have text plus validated images appear here. Items still missing images stay out of the send queue.</p>
          </div>
        </div>
        <div class="split">
          <div class="panel">
            <table>
              <thead>
                <tr>
                  <th>Draft</th>
                  <th>Images</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody id="queue-body"></tbody>
            </table>
          </div>
          <div class="panel">
            <table>
              <thead>
                <tr>
                  <th>Recent event</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody id="publishing-body"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>In Progress</h2>
            <p>These drafts already have text, but they are still missing validated artwork images, so they are not considered the next item in line.</p>
          </div>
        </div>
        <div class="panel">
          <table>
            <thead>
              <tr>
                <th>Draft</th>
                <th>Images</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody id="in-progress-body"></tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>Recently Mined Artists</h2>
            <p>The cumulative shortlist cache that feeds the database before generic discovery kicks in.</p>
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
          Auto-refresh: every 30 seconds. JSON feed available at <code>/api/dashboard</code>.
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

      function statusBadge(type, label) {
        return '<span class="' + type + '">' + escapeHtml(label) + '</span>';
      }

      function workerBadge(worker) {
        if (!worker) {
          return statusBadge("status-danger", "offline");
        }
        return worker.healthy
          ? statusBadge("status-ok", worker.phase)
          : statusBadge("status-danger", "stale");
      }

      function render(snapshot) {
        document.getElementById("generated-at").textContent = formatDate(snapshot.generatedAt);
        document.getElementById("timezone").textContent = snapshot.timezone;

        const queueHealthy = snapshot.health.queueFloorHealthy;
        const queueHealthPill = document.getElementById("queue-health-pill");
        queueHealthPill.className = queueHealthy ? "status-ok" : "status-warn";
        queueHealthPill.textContent = queueHealthy
          ? "Ready queue above floor"
          : "Ready queue below floor";

        document.getElementById("ready-now-count").textContent = String(snapshot.queue.length);
        document.getElementById("in-progress-count").textContent = String(snapshot.inProgress.length);

        const cards = [
          ["Research cache", snapshot.summary.cacheEntries, snapshot.summary.cacheEligible + " eligible entries"],
          ["100% ready", snapshot.queue.length, "Can be sent immediately"],
          ["Text-only drafts", snapshot.inProgress.length, "Still missing artwork validation"],
          ["Verified artists", snapshot.summary.verifiedArtists, snapshot.health.failedArtistsToday + " failed today"],
          ["Sent", snapshot.summary.sentDrafts, "Awaiting approval"],
          ["Approved", snapshot.summary.approvedDrafts, "Published to blog"],
          ["Rejected", snapshot.summary.rejectedDrafts, "Permanently removed"],
          ["Daily send", snapshot.health.nextSendHourLocal, "Local schedule"],
          ["Replacement requests", snapshot.summary.replacementRequests, "Waiting for a new ready draft"]
        ];

        document.getElementById("summary-cards").innerHTML = cards.map(([label, value, note]) => {
          return '<article class="card">' +
            '<p class="card-label">' + escapeHtml(label) + '</p>' +
            '<p class="card-value">' + escapeHtml(value) + '</p>' +
            '<p class="card-note">' + escapeHtml(note) + '</p>' +
          '</article>';
        }).join("");

        const workers = [
          ["Research miner", snapshot.workers.researchMiner, "Continuously accumulates reliable artists into the mined cache"],
          ["Draft hydrator", snapshot.workers.draftHydrator, "Continuously turns reliable artists into 100% ready drafts and handles the 5am send"]
        ];

        document.getElementById("worker-cards").innerHTML = workers.map(([label, worker, note]) => {
          const detail = worker
            ? worker.detail + " • updated " + formatDate(worker.updatedAt)
            : "No status file found yet";
          const metrics = worker
            ? "success " + worker.successCount + " • failures " + worker.failureCount + (worker.lastExitCode !== null ? " • last exit " + worker.lastExitCode : "")
            : "worker not started";

          return '<article class="card">' +
            '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">' +
              '<p class="card-label" style="margin:0;">' + escapeHtml(label) + '</p>' +
              workerBadge(worker) +
            '</div>' +
            '<p class="card-value" style="font-size:1.1rem; line-height:1.45;">' + escapeHtml(detail) + '</p>' +
            '<p class="card-note">' + escapeHtml(note) + '</p>' +
            '<p class="card-note">' + escapeHtml(metrics) + '</p>' +
          '</article>';
        }).join("");

        document.getElementById("queue-body").innerHTML = snapshot.queue.length
          ? snapshot.queue.map((row) => (
              "<tr>" +
                '<td class="title-cell"><strong>' + escapeHtml(row.title) + '</strong><span>' + escapeHtml(row.artistName) + " • Draft #" + escapeHtml(row.draftId) + '</span><div><a class="action-link" href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '#drafts">Open draft</a></div></td>' +
                "<td>" + escapeHtml(row.imageCount) + "</td>" +
                "<td>" + escapeHtml(formatDate(row.createdAt)) + "</td>" +
              "</tr>"
            )).join("")
          : '<tr><td colspan="3" class="empty">No send-ready drafts in queue right now.</td></tr>';

        document.getElementById("in-progress-body").innerHTML = snapshot.inProgress.length
          ? snapshot.inProgress.map((row) => (
              "<tr>" +
                '<td class="title-cell"><strong>' + escapeHtml(row.title) + '</strong><span>' + escapeHtml(row.artistName) + " • Draft #" + escapeHtml(row.draftId) + '</span><div><a class="action-link" href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '#drafts">Open draft</a></div></td>' +
                "<td>" + escapeHtml(row.imageCount) + "</td>" +
                "<td>" + statusBadge("status-warn", "not ready yet") + "</td>" +
                "<td>" + escapeHtml(formatDate(row.createdAt)) + "</td>" +
              "</tr>"
            )).join("")
          : '<tr><td colspan="4" class="empty">No hydrating drafts right now.</td></tr>';

        document.getElementById("publishing-body").innerHTML = snapshot.recentPublishing.length
          ? snapshot.recentPublishing.map((row) => (
              "<tr>" +
                '<td class="title-cell"><strong>' + escapeHtml(row.artistName) + '</strong><span>' + escapeHtml(row.draftTitle) + "</span></td>" +
                "<td>" + (row.status === "published" ? statusBadge("status-ok", "published") : statusBadge("status-danger", "failed")) + "</td>" +
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
                    ? '<a href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '" style="text-decoration:none;">' + statusBadge("status-ok", "eligible") + "</a>" +
                      '<div><a class="action-link" href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '">Open mined</a></div>'
                    : statusBadge("status-warn", "blocked")) +
                  (row.hasLocalDraft
                    ? '<div><a class="action-link" href="/dashboard/mined?artist=' + encodeURIComponent(row.artistName) + '#drafts">Open draft</a></div>'
                    : '') +
                "</td>" +
                '<td><div class="tags">' + signals.map((signal) => '<span class="tag">' + escapeHtml(signal) + "</span>").join("") + "</div></td>" +
              "</tr>";
            }).join("")
          : '<tr><td colspan="5" class="empty">No mined artists cached yet.</td></tr>';
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

      render(initialSnapshot);
      window.setInterval(refresh, 30000);
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
