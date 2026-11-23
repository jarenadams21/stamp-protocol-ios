import { HttpError, RateLimiter, clientIP, jsonBody } from "./support.mjs";

export function customerAPI({ store, wallet, verify, trustCloudflare = false, factoryTest = true }) {
  const requests = new RateLimiter(120, 60000);
  const logins = new RateLimiter(10, 15 * 60000);
  let tail = Promise.resolve();
  async function serialize(callback) {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await callback(); } finally { release(); }
  }
  const publicCard = ({ version, ...card }) => card;
  return async (req, res) => {
    const send = (status, data, headers = {}) => {
      const binary = Buffer.isBuffer(data);
      res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer", ...(data === undefined ? {} : { "Content-Type": binary ? "application/vnd.apple.pkpass" : "application/json" }), ...headers });
      res.end(data === undefined ? undefined : binary ? data : JSON.stringify(data));
    };
    try {
      const ip = clientIP(req, trustCloudflare);
      requests.check(ip);
      const url = new URL(req.url, "http://internal");
      if (url.pathname === "/healthz" && req.method === "GET") return send(200, { status: "ok", factoryKeyTest: factoryTest });
      if (url.pathname.startsWith("/wallet/")) return await wallet.handle(req, res, url, send);
      if (["/api/v1/accounts", "/api/v1/sessions"].includes(url.pathname) && req.method === "POST") {
        logins.check(ip);
        const { username, password } = await jsonBody(req);
        const account = url.pathname.endsWith("/accounts");
        return send(account ? 201 : 200, await (account ? store.signup(username, password) : store.login(username, password)));
      }
      const customer = store.authenticate(req.headers.authorization);
      if (url.pathname === "/api/v1/session" && req.method === "DELETE") {
        store.db.prepare("DELETE FROM sessions WHERE hash=?").run(customer.sessionHash);
        return send(204);
      }
      if (url.pathname === "/api/v1/cards" && req.method === "GET") return send(200, { cards: store.cards(customer.id).map(publicCard) });
      const download = /^\/api\/v1\/cards\/([0-9a-f-]{36})\/pass$/i.exec(url.pathname);
      if (download && req.method === "GET") {
        return await serialize(async () => {
          const card = store.card(download[1].toLowerCase(), customer.id);
          await wallet.publish(card);
          send(200, await wallet.bytes(card.id));
        });
      }
      if (url.pathname === "/api/v1/taps" && req.method === "POST") {
        const body = await jsonBody(req);
        if (typeof body.url !== "string" || body.url.length > 4096 || typeof body.requestId !== "string" ||
            !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(body.requestId)) {
          throw new HttpError(400, "Scan a programmed chip and include a valid request ID.");
        }
        const requestId = body.requestId.toLowerCase();
        const previous = store.previous(customer.id, requestId, body.url);
        const verified = previous ? null : await verify(body.url);
        return await serialize(async () => {
          let result;
          if (previous) result = { eventId: previous.id, card: store.card(previous.card_id, customer.id), duplicate: true };
          else result = store.award(customer.id, requestId, body.url, verified);
          try { await wallet.publish(result.card); }
          catch {
            throw new HttpError(503, "Stamp recorded, but Wallet generation failed. Retry this same request to finish without adding another stamp.");
          }
          send(200, { ...result, card: publicCard(result.card) });
        });
      }
      throw new HttpError(404, "API endpoint not found.");
    } catch (error) {
      if (!(error instanceof HttpError)) console.error("Customer API operation failed; credentials and chip parameters omitted.");
      send(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "The service could not complete this request. Retry safely." });
    }
  };
}
