import type { IncomingMessage, ServerResponse } from 'node:http';

// HTTP plumbing shared by the demo backend's routes and the Wallet web service.

const MAX_BODY = 64 * 1024;

/** A request the demo can't make sense of: bad JSON, bad URL encoding, a body that's too big. */
export class BadRequest extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
  }
}

/** A route's answer with a status other than 200 (or 204 for nothing), such as 201 or 202. */
export class Answer {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}

/** Answers with JSON, or with no body when there's nothing to say. */
export function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The request's JSON object body ({} when empty). Throws BadRequest for anything else. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Keep reading but drop the rest: stopping early would close the socket before the 413 goes out.
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  if (size > MAX_BODY) throw new BadRequest('Request too large', 413);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequest('Body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequest('Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

/** decodeURIComponent for one path segment; a broken %-escape is the client's mistake, not a crash. */
export function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequest('Bad URL encoding');
  }
}

/** The page's own address as the phone sees it, so links printed on Wallet passes keep working. */
export function originOf(req: IncomingMessage) {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  return `${proto}://${req.headers.host ?? 'localhost:5180'}`;
}
