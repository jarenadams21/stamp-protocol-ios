import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../../src/api/types';
import { PartnerError } from '../../src/business/types';
import { buildApplePass, cardFromQuery, previewArtwork, walletStatus } from '../apple-pass';
import { passkitService, pushChangedPasses } from './passkit';
import { Answer, BadRequest, decodeSegment, originOf, readJson, send } from './http';
import { addStamp, SCENARIOS } from './scenarios';
import * as partner from './partner';
import * as service from './service';
import { customerOf, deviceFor, persist, type Device, syncFromDisk } from './store';

// The demo backend, mounted in the Vite dev and preview servers. /v1/web/* answers exactly the
// routes in docs/identity-and-api.md, and /v1/auth/email/*, /v1/partner/* and /v1/dev/stands/touch
// the shared API's (docs/web-connect.md), so the page runs the same HTTP clients it will use against
// the real backend. /api/demo/* drives the Preview states panel, and /api/wallet/* serves passes.

const COOKIE = 'joeyy_device';
const LATENCY_MS = 300; // Enough to see loading states, like a real network.

type Handler = (context: {
  device: Device;
  body: Record<string, unknown>;
  params: string[];
  query: URLSearchParams;
  /** The Authorization header, for the business site's bearer-token routes. */
  authorization?: string;
}) => unknown;

const routes: { method: string; pattern: RegExp; handler: Handler; slow?: boolean }[] = [];
const on = (method: string, pattern: RegExp, handler: Handler, slow = true) => routes.push({ method, pattern, handler, slow });

// ---------- The backend contract ----------

on('POST', /^\/v1\/web\/taps$/, ({ device, body }) => service.tap(device, String(body.picc ?? ''), String(body.cmac ?? '')));
on('GET', /^\/v1\/web\/me\/cards$/, ({ device }) => service.myCards(device));
on('PUT', /^\/v1\/web\/me\/cards\/order$/, ({ device, body }) => service.reorderCards(device, body.businessIds));
on('GET', /^\/v1\/web\/me\/cards\/([^/]+)$/, ({ device, params }) => service.card(device, params[0]));
on('POST', /^\/v1\/web\/redeem-intents$/, ({ device, body }) => service.startRedeem(device, String(body.rewardId ?? '')));
on('GET', /^\/v1\/web\/redeem-intents\/([^/]+)$/, ({ params }) => service.redeemIntent(params[0]));
on('DELETE', /^\/v1\/web\/redeem-intents\/([^/]+)$/, ({ device, params }) => service.cancelRedeem(device, params[0]));
on('POST', /^\/v1\/web\/email\/start$/, ({ device, body }) => service.startEmail(device, String(body.email ?? '')));
on('POST', /^\/v1\/web\/email\/verify$/, ({ device, body }) => service.verifyEmail(device, String(body.code ?? '')));
on('POST', /^\/v1\/web\/pass-links\/([^/]+)$/, ({ device, params }) => service.restoreFromPass(device, params[0]));
on('POST', /^\/v1\/web\/sign-out$/, ({ device }) => service.signOut(device));
on('PUT', /^\/v1\/web\/me\/profile$/, ({ device, body }) => service.saveProfile(device, body.displayName));
on('DELETE', /^\/v1\/web\/me$/, ({ device }) => service.deleteAccount(device));
on('POST', /^\/v1\/web\/cards\/([^/]+)\/wallet$/, ({ device, params, body }) => service.walletPass(device, params[0], String(body.platform ?? '')));
// With ?query= this is the shared backend's Places API, answered the same way; without, the Discover list.
on('GET', /^\/v1\/places$/, ({ query }) => (query.has('query') ? service.searchPlaces(query.get('query') ?? '') : service.listPlaces()));

// The business site: the shared API's owner sign-in and partner routes (docs/business-api.md).
on('POST', /^\/v1\/auth\/email\/start$/, ({ body }) => partner.startEmail(body));
on('POST', /^\/v1\/auth\/email\/verify$/, ({ body }) => partner.verifyEmail(body));
on('POST', /^\/v1\/auth\/refresh$/, ({ body }) => partner.refresh(body), false);
on('POST', /^\/v1\/auth\/sign-out$/, ({ body }) => partner.signOut(body));
type PartnerHandler = (owner: ReturnType<typeof partner.partnerFor>, context: Parameters<Handler>[0]) => unknown;
const owner = (method: string, pattern: RegExp, handler: PartnerHandler, slow = true) =>
  on(method, pattern, (context) => handler(partner.partnerFor(context.authorization), context), slow);
owner('GET', /^\/v1\/partner\/business$/, (who) => partner.getBusiness(who), false);
owner('PUT', /^\/v1\/partner\/business$/, (who, { body }) => partner.saveBusiness(who, body));
owner('GET', /^\/v1\/partner\/program$/, (who) => partner.getProgram(who), false);
owner('POST', /^\/v1\/partner\/program\/versions$/, (who, { body }) => partner.publish(who, body));
owner('GET', /^\/v1\/partner\/stands$/, (who) => partner.stands(who), false);
owner('POST', /^\/v1\/partner\/stands\/pairing$/, (who) => partner.startPairing(who));
owner('DELETE', /^\/v1\/partner\/stands\/pairing$/, (who) => partner.cancelPairing(who));
owner('POST', /^\/v1\/partner\/stands\/([^/]+)\/turn-off$/, (who, { params }) => partner.turnOffStand(who, params[0]));
owner('GET', /^\/v1\/partner\/dashboard$/, (who, { query }) => partner.dashboard(who, query), false);
owner('GET', /^\/v1\/partner\/activity$/, (who, { query }) => partner.activity(who, query), false);
// The shared API's development route for the "Preview: touch the stand" button.
owner('POST', /^\/v1\/dev\/stands\/touch$/, (who) => partner.touchStand(who), false);

// Apple and Google sign-in need real OAuth, which the demo can't do. The page shows a stand-in
// consent sheet and calls this instead of /v1/web/auth/{provider}/start.
on('POST', /^\/api\/demo\/auth\/(apple|google)$/, ({ device, params }) => service.providerSignIn(device, params[0]));

// ---------- Preview states ----------

on('GET', /^\/api\/demo\/info$/, ({ device }) => ({
  walletConfigured: walletStatus().configured,
  offline: Boolean(device.offline),
}), false);
on('POST', /^\/api\/demo\/settings$/, ({ device, body }) => {
  if (typeof body.offline === 'boolean') device.offline = body.offline || undefined;
}, false);
on('POST', /^\/api\/demo\/scenarios\/([\w-]+)$/, ({ device, params }) => {
  const scenario = SCENARIOS[params[0]];
  if (!scenario) throw new ApiError('notFound', 'Unknown scenario');
  return { next: scenario(device, customerOf(device)) };
}, false);
on('POST', /^\/api\/demo\/stamp$/, ({ body }) => {
  const next = addStamp(String(body.businessId ?? ''));
  if (!next) throw new ApiError('notFound', 'No stand for that business');
  return { next };
}, false);

// ---------- Plumbing ----------

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readCookie(req: IncomingMessage) {
  return /(?:^|;\s*)joeyy_device=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
}

const STATUS: Record<ApiError['code'], number> = {
  offline: 503, server: 500, invalidEmail: 400, invalidCode: 400, invalidName: 400, expired: 410, notFound: 404,
};

function servePass(req: IncomingMessage, res: ServerResponse, path: string) {
  // Whether signing is set up (see .wallet/README.md).
  if (path === '/api/wallet/apple/status') return send(res, 200, walletStatus());
  // A quick look at the strip art for any card, without signing: /api/wallet/apple/strip.png?punches=…
  if (path === '/api/wallet/apple/strip.png') {
    res.setHeader('Content-Type', 'image/png');
    res.end(previewArtwork(cardFromQuery(new URL(req.url ?? '/', 'http://localhost').searchParams)).strip);
    return;
  }
  const serial = /^\/api\/wallet\/apple\/([\w-]+)\.pkpass$/.exec(path)?.[1];
  const card = serial ? service.passCard(serial, originOf(req)) : undefined;
  if (!card) return send(res, 404, { code: 'notFound' });
  if (!walletStatus().configured) return send(res, 501, { code: 'notConfigured', missing: walletStatus().missing });
  try {
    const pass = buildApplePass(card);
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${card.businessId}.pkpass"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(pass);
  } catch (error) {
    send(res, 500, { code: 'signingFailed', message: String((error as Error).message ?? error) });
  }
}

async function serveApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
  const device = deviceFor(readCookie(req));
  res.setHeader('Set-Cookie', `${COOKIE}=${device.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    if (route.slow) {
      await wait(LATENCY_MS);
      if (device.offline) throw new ApiError('offline', 'No connection');
    }
    const params = match.slice(1).map(decodeSegment);
    const result = route.handler({ device, body: await readJson(req), params, query, authorization: req.headers.authorization });
    persist();
    // A stamp, redemption or sign-in may have changed a card that's in someone's Wallet.
    pushChangedPasses();
    if (result instanceof Answer) return send(res, result.status, result.body);
    return send(res, result === undefined ? 204 : 200, result);
  }
  send(res, 404, { code: 'notFound' });
}

/** Turns any error into an answer. Bad input is a 400 (or 413), never a 500 or a dead server. */
function answerError(res: ServerResponse, error: unknown) {
  if (res.headersSent) return void res.end();
  if (error instanceof BadRequest) {
    return send(res, error.status, { code: error.status === 413 ? 'tooLarge' : 'badRequest', message: error.message });
  }
  if (error instanceof ApiError) return send(res, STATUS[error.code] ?? 500, { code: error.code, message: error.message });
  // The shared API's error shape, for the business site's routes.
  if (error instanceof PartnerError) return send(res, error.status, { error: error.code, message: error.message });
  send(res, 500, { code: 'server', message: String((error as Error)?.message ?? error) });
}

/** Connect middleware: answers the demo backend's routes and passes everything else to Vite. */
export async function demoBackend(req: IncomingMessage, res: ServerResponse, next: () => void) {
  let path: string;
  let query: URLSearchParams;
  try {
    ({ pathname: path, searchParams: query } = new URL(req.url ?? '/', 'http://localhost'));
  } catch {
    return next();
  }
  if (!/^\/(v1|api\/demo|api\/wallet|passkit\/v1)\//.test(path)) return next();
  // This runs inside an async middleware nobody awaits: anything thrown here would kill the server.
  try {
    syncFromDisk();
    partner.registerPartners();
    if (path.startsWith('/api/wallet/')) servePass(req, res, path);
    else if (path.startsWith('/passkit/v1/')) await passkitService(req, res, path);
    else await serveApi(req, res, path, query);
  } catch (error) {
    answerError(res, error);
  }
}
