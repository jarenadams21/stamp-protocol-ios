import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApplePass, passTypeCredentials, walletStatus } from '../apple-pass';
import { pushPassUpdate } from '../apns';
import { decodeSegment, originOf, readJson, send } from './http';
import { openCard, passCard, snapshot } from './service';
import { findPass, persist, state, type StoredPass } from './store';

// Apple's pass web service, so a pass in Wallet updates itself. Each pass names this service
// (webServiceURL, ".../passkit") and carries a secret (authenticationToken):
//   1. Adding the pass: Wallet registers the device and its push token for that pass.
//   2. A stamp or redemption changes the card: we push to every registered device (server/apns.ts).
//   3. Wallet asks which of its passes changed since it last looked, then downloads each one.
// Routes and rules: https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes
// The real backend needs the same five routes.

const PREFIX = '/passkit/v1';

/** The pass a request is about, if its passTypeIdentifier, serial and secret all match. */
function authorised(req: IncomingMessage, passType: string, serial: string) {
  if (passType !== passTypeCredentials().passTypeIdentifier) return undefined;
  const found = findPass((pass) => pass.serial === serial);
  const secret = /^ApplePass (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  return found && found.pass.authToken && secret === found.pass.authToken ? found : undefined;
}

const registeredTo = (deviceId: string) =>
  Object.values(state.customers).flatMap((customer) =>
    customer.passes.filter((pass) => pass.registrations?.some((item) => item.deviceId === deviceId)));

/** Connect middleware for /passkit/v1/*. Wallet calls these itself; the page never does. */
export async function passkitService(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!walletStatus().configured) return send(res, 503);
  const parts = path.slice(PREFIX.length).split('/').filter(Boolean).map(decodeSegment);

  // POST|DELETE /devices/{device}/registrations/{passType}/{serial}
  if (parts[0] === 'devices' && parts[2] === 'registrations' && parts.length === 5) {
    const [, deviceId, , passType, serial] = parts;
    const found = authorised(req, passType, serial);
    if (!found) return send(res, 401);
    const { customer, pass } = found;
    pass.registrations ??= [];
    const existing = pass.registrations.find((item) => item.deviceId === deviceId);
    if (req.method === 'DELETE') {
      pass.registrations = pass.registrations.filter((item) => item !== existing);
      persist();
      console.info(`[wallet] ${serial} removed from a device`);
      return send(res, 200);
    }
    if (req.method !== 'POST') return send(res, 405);
    const pushToken = String((await readJson(req)).pushToken ?? '');
    if (!pushToken) return send(res, 400);
    if (existing) existing.pushToken = pushToken;
    else pass.registrations.push({ deviceId, pushToken });
    // The pass as downloaded is current, so only later changes are pushed.
    pass.announced = snapshot(customer, openCard(customer, pass.businessId));
    pass.updatedAt ??= Date.now();
    persist();
    console.info(`[wallet] ${serial} registered for updates`);
    return send(res, existing ? 200 : 201);
  }

  // GET /devices/{device}/registrations/{passType}?passesUpdatedSince={tag}
  if (parts[0] === 'devices' && parts[2] === 'registrations' && parts.length === 4 && req.method === 'GET') {
    const [, deviceId, , passType] = parts;
    if (passType !== passTypeCredentials().passTypeIdentifier) return send(res, 404);
    const since = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('passesUpdatedSince') ?? 0) || 0;
    const passes = registeredTo(deviceId);
    if (!passes.length) return send(res, 404);
    const changed = passes.filter((pass) => (pass.updatedAt ?? 0) > since);
    if (!changed.length) return send(res, 204);
    const lastUpdated = Math.max(...changed.map((pass) => pass.updatedAt ?? 0));
    return send(res, 200, { serialNumbers: changed.map((pass) => pass.serial), lastUpdated: String(lastUpdated) });
  }

  // GET /passes/{passType}/{serial}: the latest pass
  if (parts[0] === 'passes' && parts.length === 3 && req.method === 'GET') {
    const found = authorised(req, parts[1], parts[2]);
    if (!found) return send(res, 401);
    const updatedAt = found.pass.updatedAt ?? Date.now();
    const since = Date.parse(String(req.headers['if-modified-since'] ?? ''));
    // HTTP dates are whole seconds.
    if (!Number.isNaN(since) && Math.floor(updatedAt / 1000) <= Math.floor(since / 1000)) return send(res, 304);
    const card = passCard(found.pass.serial, originOf(req));
    if (!card) return send(res, 401);
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Last-Modified', new Date(updatedAt).toUTCString());
    console.info(`[wallet] ${found.pass.serial} downloaded by Wallet`);
    return res.end(buildApplePass(card));
  }

  // POST /log: Wallet reports problems with the service here. Worth reading when updates don't arrive.
  if (parts[0] === 'log' && req.method === 'POST') {
    const logs = (await readJson(req)).logs;
    for (const line of Array.isArray(logs) ? logs : []) console.warn(`[wallet] Wallet says: ${String(line)}`);
    return send(res, 200);
  }

  return send(res, 404);
}

/**
 * Pushes every registered pass whose card changed since its last push. Called after each request
 * that might change a card: stamps, redemptions, sign-in merges, Preview states.
 */
export function pushChangedPasses() {
  if (!walletStatus().configured) return;
  for (const customer of Object.values(state.customers)) {
    for (const pass of customer.passes) {
      if (!pass.registrations?.length) continue;
      const now = snapshot(customer, openCard(customer, pass.businessId));
      if (pass.announced === now) continue;
      pass.announced = now;
      pass.updatedAt = Date.now();
      void announce(pass);
    }
  }
  persist();
}

async function announce(pass: StoredPass) {
  const results = await Promise.all((pass.registrations ?? []).map((item) => pushPassUpdate(item.pushToken)));
  for (const result of results) {
    if (result.status === 200) console.info(`[wallet] ${pass.serial} update pushed`);
    else console.warn(`[wallet] ${pass.serial} push failed: ${result.status} ${result.reason ?? ''}`);
    // The device removed the pass or the app: stop pushing to it.
    if (result.status === 410) {
      pass.registrations = pass.registrations?.filter((item) => item.pushToken !== result.pushToken);
      persist();
    }
  }
}
