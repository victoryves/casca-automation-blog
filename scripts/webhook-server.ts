import http, { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import { promisify } from 'node:util';

import approveHandler from '../api/webhook/approve.js';
import rejectHandler from '../api/webhook/reject.js';
import emailHandler from '../api/webhook/email.js';
import { getConfig } from '../src/config/index.js';
import { initDatabase } from '../src/db/local.js';
import { artistOps, draftOps, librarianPendingReviewOps, publicationHistoryOps } from '../src/db/operations/index.js';
import {
  getDraftDetailSnapshot,
  getDashboardSnapshot,
  getMinedArtistDetailSnapshot,
  renderDraftDetailHtml,
  renderDashboardHtml,
  renderMinedArtistDetailHtml,
} from '../src/modules/dashboard/index.js';
import { Dispatcher, EmailModule } from '../src/modules/email/index.js';
import { ScoutAgent } from '../src/modules/agents/scout.js';
import { purgeReadyDuplicatesAgainstPublicationHistory } from '../src/modules/publication-history/ready-purge.js';
import { ArtistResearchCache } from '../src/modules/research-cache/index.js';

type QueryValue = string | string[] | undefined;
const execFileAsync = promisify(execFile);

type RequestWithQuery = IncomingMessage & {
  query: Record<string, QueryValue>;
  cookies: Record<string, string>;
  body?: unknown;
};

type ResponseWithHelpers = ServerResponse & {
  status: (code: number) => ResponseWithHelpers;
  send: (payload: unknown) => ResponseWithHelpers;
  json: (payload: unknown) => ResponseWithHelpers;
};

const host = process.env.WEBHOOK_HOST || '0.0.0.0';
const port = Number(process.env.WEBHOOK_PORT || '18791');
const AGENT_SERVICE_LABELS: Record<string, string> = {
  'scout-agent': 'com.casca.scout-agent',
  'research-agent': 'com.casca.research-miner',
  'curator-agent': 'com.casca.curator-agent',
  overseer: 'com.casca.daily-workflow',
};

function withHelpers(res: ServerResponse): ResponseWithHelpers {
  const response = res as ResponseWithHelpers;

  response.status = (code: number) => {
    response.statusCode = code;
    return response;
  };

  response.send = (payload: unknown) => {
    if (payload === undefined) {
      response.end();
      return response;
    }

    if (Buffer.isBuffer(payload)) {
      response.end(payload);
      return response;
    }

    if (typeof payload === 'string') {
      if (!response.getHeader('content-type')) {
        response.setHeader('content-type', 'text/html; charset=utf-8');
      }
      response.end(payload);
      return response;
    }

    return response.json(payload);
  };

  response.json = (payload: unknown) => {
    if (!response.getHeader('content-type')) {
      response.setHeader('content-type', 'application/json; charset=utf-8');
    }
    response.end(JSON.stringify(payload));
    return response;
  };

  return response;
}

function parseQuery(url: URL): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (query[key] === undefined) {
      query[key] = value;
    } else if (Array.isArray(query[key])) {
      (query[key] as string[]).push(value);
    } else {
      query[key] = [query[key] as string, value];
    }
  }
  return query;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const request = req as RequestWithQuery;
  const response = withHelpers(res);

  request.query = parseQuery(url);
  request.cookies = {};
  request.body = await readBody(req);

  if (url.pathname === '/health') {
    response.status(200).json({ ok: true });
    return;
  }

  if (url.pathname === '/dashboard' || url.pathname === '/') {
    initDatabase();
    const snapshot = await getDashboardSnapshot();
    response.status(200).send(renderDashboardHtml(snapshot));
    return;
  }

  if (url.pathname === '/api/dashboard') {
    initDatabase();
    const snapshot = await getDashboardSnapshot();
    response.status(200).json(snapshot);
    return;
  }

  if (url.pathname === '/dashboard/mined') {
    initDatabase();
    const artist = typeof request.query.artist === 'string' ? request.query.artist : '';
    const snapshot = await getMinedArtistDetailSnapshot(artist);
    if (!snapshot) {
      response.status(404).send('Mined artist not found');
      return;
    }
    response.status(200).send(renderMinedArtistDetailHtml(snapshot));
    return;
  }

  if (url.pathname === '/dashboard/draft') {
    initDatabase();
    const draftIdRaw = typeof request.query.id === 'string' ? request.query.id : '';
    const draftId = Number(draftIdRaw);
    const snapshot = await getDraftDetailSnapshot(draftId);
    if (!snapshot) {
      response.status(404).send('Draft not found');
      return;
    }
    response.status(200).send(renderDraftDetailHtml(snapshot));
    return;
  }

  if (url.pathname === '/api/dashboard/mined') {
    initDatabase();
    const artist = typeof request.query.artist === 'string' ? request.query.artist : '';
    const snapshot = await getMinedArtistDetailSnapshot(artist);
    if (!snapshot) {
      response.status(404).json({ error: 'Mined artist not found' });
      return;
    }
    response.status(200).json(snapshot);
    return;
  }

  if (url.pathname === '/api/actions/dispatch') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    initDatabase();
    const config = getConfig();
    const dispatcher = new Dispatcher(new EmailModule(config.env.resendApiKey));
    const result = await dispatcher.sendNextAvailable(true);
    response.status(result.sent ? 200 : 409).json({
      ok: result.sent,
      result,
      message: result.sent
        ? `Sent draft #${result.draftId} for ${result.artistName ?? 'unknown artist'}`
        : result.reason ?? 'No ready draft available',
    });
    return;
  }

  if (url.pathname === '/api/actions/restart-agent') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    const body =
      request.body && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>)
        : {};
    const agent = typeof body.agent === 'string' ? body.agent : '';
    const label = AGENT_SERVICE_LABELS[agent];
    if (!label) {
      response.status(400).json({ error: 'Unknown agent' });
      return;
    }
    const uid = String(process.getuid?.() ?? 501);
    await execFileAsync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]);
    response.status(200).json({
      ok: true,
      message: `Requested restart for ${agent} via ${label}`,
    });
    return;
  }

  if (url.pathname === '/api/actions/boost-scout') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    initDatabase();
    const scout = new ScoutAgent();
    const result = await scout.runSinglePass();
    response.status(200).json({
      ok: true,
      result,
      message: `Scout ran once: ${result.detail}`,
    });
    return;
  }

  if (url.pathname === '/api/actions/clear-cache') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    const cache = new ArtistResearchCache();
    await cache.writeAll([]);
    response.status(200).json({
      ok: true,
      message: 'artist-research-cache.json was cleared',
    });
    return;
  }

  if (url.pathname === '/api/actions/clear-rejected') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    initDatabase();
    const rejectedArtists = await artistOps.findByStatus('rejected');
    const rejectedDrafts = await draftOps.findByStatus('rejected');
    for (const artist of rejectedArtists) {
      if (artist.id) {
        await artistOps.updateStatus(artist.id, 'discovered');
        await artistOps.updatePriority(artist.id, 40);
      }
    }
    for (const draft of rejectedDrafts) {
      if (draft.id) {
        await draftOps.delete(draft.id);
      }
    }
    response.status(200).json({
      ok: true,
      message: `Reopened ${rejectedArtists.length} artist(s) and removed ${rejectedDrafts.length} rejected draft(s)`,
    });
    return;
  }

  if (url.pathname === '/api/actions/manual-image-approve') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    initDatabase();
    const body =
      request.body && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>)
        : {};
    const draftId = Number(body.draftId ?? 0);
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
    const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
    const attribution = typeof body.attribution === 'string' ? body.attribution.trim() : '';

    if (!draftId || !imageUrl) {
      response.status(400).json({ error: 'draftId and imageUrl are required' });
      return;
    }

    const draft = await draftOps.findByIdWithImages(draftId);
    if (!draft?.id) {
      response.status(404).json({ error: 'Draft not found' });
      return;
    }

    const artist = await artistOps.findById(draft.artist_id);
    if (!artist?.id) {
      response.status(404).json({ error: 'Artist not found' });
      return;
    }

    const mergedImages = [
      ...draft.parsedImages,
      {
        url: imageUrl,
        caption: caption || `Artwork by ${artist.full_name}`,
        attribution: attribution || 'Manual editorial approval',
      },
    ].filter(
      (image, index, list) =>
        list.findIndex((candidate) => candidate.url === image.url) === index
    );

    const metadata = artistOps.parseMetadata(artist);
    const currentCandidates = Array.isArray(metadata.almost_ready_candidates)
      ? (metadata.almost_ready_candidates as Array<{ url: string }>)
      : [];

    if (mergedImages.length >= 3) {
      await draftOps.markReady(draft.id, mergedImages.slice(0, 3), Math.max(draft.priority ?? 0, 85));
      await artistOps.updateStatus(artist.id, 'ready_to_send');
      await artistOps.updatePriority(artist.id, Math.max(draft.priority ?? 0, 85));
    } else {
      await draftOps.markCurated(draft.id, mergedImages, draft.priority ?? 75);
      await artistOps.updateStatus(artist.id, 'curated');
    }

    await artistOps.mergeMetadata(artist.id, {
      almost_ready_draft_id: mergedImages.length >= 3 ? null : draft.id,
      almost_ready_candidates: currentCandidates.filter((candidate) => candidate.url !== imageUrl),
      almost_ready_last_reason: mergedImages.length >= 3 ? null : `manual-approval:${mergedImages.length}/3`,
    });

    response.status(200).json({
      ok: true,
      message:
        mergedImages.length >= 3
          ? `Draft #${draft.id} is now READY with ${Math.min(mergedImages.length, 3)} images`
          : `Draft #${draft.id} now has ${mergedImages.length}/3 images`,
    });
    return;
  }

  if (url.pathname === '/api/actions/librarian-approve') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    initDatabase();
    const body =
      request.body && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>)
        : {};
    const reviewId = Number(body.reviewId ?? 0);
    const review = await librarianPendingReviewOps.findById(reviewId);
    if (!review?.id) {
      response.status(404).json({ error: 'Pending review item not found' });
      return;
    }
    await publicationHistoryOps.approvePendingReview(review, 'rss_feed');
    const purged = await purgeReadyDuplicatesAgainstPublicationHistory();
    response.status(200).json({
      ok: true,
      message: `Approved ${review.resolved_name} into publication history and purged ${purged.length} ready duplicate(s)`,
    });
    return;
  }

  if (url.pathname === '/api/actions/librarian-reject') {
    if (req.method !== 'POST') {
      response.status(405).json({ error: 'Method not allowed' });
      return;
    }
    initDatabase();
    const body =
      request.body && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>)
        : {};
    const reviewId = Number(body.reviewId ?? 0);
    const review = await librarianPendingReviewOps.findById(reviewId);
    if (!review?.id) {
      response.status(404).json({ error: 'Pending review item not found' });
      return;
    }
    await librarianPendingReviewOps.delete(reviewId);
    response.status(200).json({
      ok: true,
      message: `Ignored pending librarian match for ${review.resolved_name}`,
    });
    return;
  }

  try {
    if (url.pathname === '/api/webhook/approve') {
      await approveHandler(request as any, response as any);
      return;
    }

    if (url.pathname === '/api/webhook/reject') {
      await rejectHandler(request as any, response as any);
      return;
    }

    if (url.pathname === '/api/webhook/email') {
      await emailHandler(request as any, response as any);
      return;
    }

    response.status(404).send('Not Found');
  } catch (error) {
    console.error('Webhook server error:', error);
    response
      .status(500)
      .send(`Webhook server error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const server = http.createServer((req, res) => {
  void router(req, res);
});

server.listen(port, host, () => {
  console.log(`Webhook server listening on http://${host}:${port}`);
});
