/**
 * The forge's HTTP surface, assembled: one in-memory store behind four
 * faces — REST v3 (/api/v3), GraphQL (/api/graphql), MCP (/mcp) and git
 * smart HTTP (/<owner>/<repo>.git/…). Every API call carries the shop token
 * as a Bearer credential; the same value is in this process's environment.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { routeRest } from './lib/rest.ts';
import {
  advertise, handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack, parseFetchArgs,
} from './lib/githttp.ts';
import { readPktFrame } from './lib/gitobj.ts';
import { findRepo } from './lib/forge.ts';
import { executeGraphQL } from './lib/graphql-exec.ts';
import { handleMcpPayload, mcpParseError } from './lib/mcp.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;
let requestSeq = 0;

function requestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token && token !== '' ? token : null;
}

function isAuthed(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (!expected) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match !== null && match[1] === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId(),
    ...headers,
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId(),
  });
  res.end(body);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Every pkt-line payload in a request body, as text (flush/delim markers skipped). */
function allPktPayloads(body: Buffer): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    const frame = readPktFrame(body, pos);
    if (!frame) break;
    pos = frame.next;
    if (frame.payload !== null && frame.payload !== 'delim') out.push(frame.payload.toString('utf8'));
  }
  return out;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

  if (url.pathname === '/healthz') {
    req.resume();
    sendRaw(res, 200, 'text/plain; charset=utf-8', Buffer.from('ok\n'));
    return;
  }

  // ------------------------------------------------------------- REST v3
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!isAuthed(req)) {
      req.resume();
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let body: Record<string, unknown> | undefined;
    if (raw.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const response = routeRest({ method, segments: segments.slice(2), query: url.searchParams, body, origin });
    if (!response) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (response.status === 204 || response.json === undefined) {
      res.writeHead(response.status, { 'X-GitHub-Request-Id': requestId(), ...(response.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, response.status, response.json, response.headers ?? {});
    return;
  }

  // ------------------------------------------------------------- GraphQL
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (method !== 'POST') {
      req.resume();
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!isAuthed(req)) {
      req.resume();
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => executeGraphQL((entry ?? {}) as Record<string, unknown>).payload);
      sendJson(res, 200, results);
      return;
    }
    const result = executeGraphQL((parsed ?? {}) as Record<string, unknown>);
    sendJson(res, result.status, result.payload);
    return;
  }

  // ----------------------------------------------------------------- MCP
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (method !== 'POST') {
      req.resume();
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (!req.headers.authorization || !isAuthed(req)) {
      req.resume();
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, mcpParseError());
      return;
    }
    const outcome = handleMcpPayload(parsed);
    if (outcome.payload === undefined) {
      res.writeHead(outcome.status, { 'X-GitHub-Request-Id': requestId() });
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.payload);
    return;
  }

  // --------------------------------------------------------- git transport
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const repo = findRepo(owner, repoName);
    if (!repo) {
      req.resume();
      sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('Repository not found\n'));
      return;
    }
    if (!isAuthed(req)) {
      req.resume();
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const tail = segments.slice(2).join('/');
    if (method === 'GET' && tail === 'info/refs') {
      req.resume();
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendRaw(res, 403, 'text/plain; charset=utf-8', Buffer.from('Missing or invalid service\n'));
        return;
      }
      const protocolHeader = req.headers['git-protocol'];
      const result = advertise(repo, service, Array.isArray(protocolHeader) ? protocolHeader.join(',') : (protocolHeader ?? null));
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') {
      const raw = await readBody(req);
      const lines = allPktPayloads(raw);
      const commandLine = lines.find((line) => line.startsWith('command='));
      if (commandLine?.startsWith('command=ls-refs')) {
        const result = handleLsRefs(repo, lines);
        sendRaw(res, result.status, result.contentType, result.body);
        return;
      }
      if (commandLine?.startsWith('command=fetch')) {
        const result = handleFetchV2(repo, parseFetchArgs(lines));
        sendRaw(res, result.status, result.contentType, result.body);
        return;
      }
      // Protocol v0: want lines carry the negotiated capabilities on the first want.
      const caps = new Set<string>();
      const firstWant = lines.find((line) => line.startsWith('want '));
      if (firstWant) {
        for (const cap of firstWant.replace(/\n$/, '').split(' ').slice(2)) caps.add(cap);
      }
      const result = handleFetchV0(repo, parseFetchArgs(lines), caps);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && tail === 'git-receive-pack') {
      const raw = await readBody(req);
      const result = handleReceivePack(repo, raw);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    req.resume();
    sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not found\n'));
    return;
  }

  req.resume();
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the forge's HTTP server (not yet listening). */
export function createApp(): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('forge: request failed:', error);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      else res.end();
    });
  });
  return server;
}
