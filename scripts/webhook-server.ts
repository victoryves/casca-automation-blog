import http, { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

import approveHandler from '../api/webhook/approve.js';
import rejectHandler from '../api/webhook/reject.js';
import emailHandler from '../api/webhook/email.js';
import { initDatabase } from '../src/db/local.js';
import {
  getDraftDetailSnapshot,
  getDashboardSnapshot,
  getMinedArtistDetailSnapshot,
  renderDraftDetailHtml,
  renderDashboardHtml,
  renderMinedArtistDetailHtml,
} from '../src/modules/dashboard/index.js';

type QueryValue = string | string[] | undefined;

type RequestWithQuery = IncomingMessage & {
  query: Record<string, QueryValue>;
  body?: unknown;
};

type ResponseWithHelpers = ServerResponse & {
  status: (code: number) => ResponseWithHelpers;
  send: (payload: unknown) => ResponseWithHelpers;
  json: (payload: unknown) => ResponseWithHelpers;
};

const host = process.env.WEBHOOK_HOST || '0.0.0.0';
const port = Number(process.env.WEBHOOK_PORT || '18791');

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

  try {
    if (url.pathname === '/api/webhook/approve') {
      await approveHandler(request, response);
      return;
    }

    if (url.pathname === '/api/webhook/reject') {
      await rejectHandler(request, response);
      return;
    }

    if (url.pathname === '/api/webhook/email') {
      await emailHandler(request, response);
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
