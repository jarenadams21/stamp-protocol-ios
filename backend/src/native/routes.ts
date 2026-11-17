import type { FastifyPluginAsync } from "fastify";
import { HttpError, RateLimiter } from "../../support.mjs";
import { assertNativeReady, type NativeServices } from "./index.ts";
import { normalizeUUID, publicCard } from "./store.ts";

function objectBody(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Expected a JSON object.");
    return Object.fromEntries(Object.entries(body));
}
function deviceID(value: string) {
    if (!/^[\x21-\x7e]{1,200}$/.test(value) || /[/\\?#]/.test(value)) throw new HttpError(400, "Invalid device identifier.");
    return value;
}
export const nativeRoutes: FastifyPluginAsync<NativeServices> = async (app, services) => {
    const { store, wallet } = services;
    const requests = new RateLimiter(120, 60_000), logins = new RateLimiter(10, 15 * 60_000);
    app.addHook("onRequest", async (request, reply) => {
        reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
        requests.check(request.ip);
    });
    app.setErrorHandler((error, request, reply) => {
        if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
        const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
        if (typeof status === "number" && status >= 400 && status < 500) {
            return reply.code(status).send({ error: "The request body couldn't be read." });
        }
        // Do not serialize database errors, route parameters, body or upstream URLs.
        request.log.error("Native API operation failed; credentials and chip/device data omitted.");
        return reply.code(500).send({ error: "The service could not complete this request. Retry safely." });
    });
    app.get("/api/v1/healthz", async (_request, reply) => {
        const configuration = { factoryKeyTest: services.factoryTest, publicBaseURL: wallet.options.baseURL, prototypeMode: services.prototypeMode };
        try {
            await assertNativeReady(store.pool);
            return { status: "ok", ...configuration };
        } catch {
            return reply.code(503).send({ status: "unavailable", ...configuration });
        }
    });
    const smallBody = { bodyLimit: 16_384 };
    if (services.prototypeMode) {
        app.post("/api/v1/prototype/session", smallBody, async (request) => {
            logins.check(request.ip);
            if (request.body !== undefined) throw new HttpError(400, "Do not send a body to start or resume an NFC prototype session.");
            return store.prototypeSession(request.headers.authorization);
        });
    }
    for (const account of [true, false]) {
        app.post(account ? "/api/v1/accounts" : "/api/v1/sessions", smallBody, async (request, reply) => {
            logins.check(request.ip);
            const { username, password } = objectBody(request.body);
            const response = await (account ? store.signup(username, password) : store.login(username, password));
            return reply.code(account ? 201 : 200).send(response);
        });
    }
    app.delete("/api/v1/session", async (request, reply) => {
        await store.logout(await store.authenticate(request.headers.authorization));
        return reply.code(204).send();
    });
    app.get("/api/v1/cards", async (request) => {
        const customer = await store.authenticate(request.headers.authorization);
        return { cards: (await store.cards(customer.id)).map(publicCard) };
    });
    app.get<{ Params: { id: string } }>("/api/v1/cards/:id/pass", async (request, reply) => {
        const customer = await store.authenticate(request.headers.authorization);
        const card = await store.card(normalizeUUID(request.params.id), customer.id);
        let pass;
        try { pass = await wallet.publish(card.id); }
        catch { throw new HttpError(503, "Wallet pass is not ready. Retry the request."); }
        return reply.type("application/vnd.apple.pkpass").send(pass.bytes);
    });
    app.post("/api/v1/taps", smallBody, async (request, reply) => {
        const customer = await store.authenticate(request.headers.authorization);
        const body = objectBody(request.body);
        if (typeof body.url !== "string" || body.url.length > 4096 || typeof body.requestId !== "string") {
            throw new HttpError(400, "Scan a programmed chip and include a valid request ID.");
        }
        const requestId = normalizeUUID(body.requestId);
        const previous = await store.previous(customer.id, requestId, body.url);
        const verified = previous ? undefined : await services.verify(body.url);
        const { counter, ...result } = await store.award(customer.id, requestId, body.url, verified);
        if (!customer.isPrototype) {
            try { await wallet.publish(result.card.id); }
            catch {
                throw new HttpError(503, "Stamp recorded, but Wallet generation failed. Retry this same request to finish without adding another stamp.");
            }
        }
        // Publication can race a later accepted stamp; return the authoritative card.
        return reply.send({
            ...result, card: publicCard(await store.card(result.card.id, customer.id)),
            ...(customer.isPrototype ? { verification: { verified: true, counter } } : {}),
        });
    });
    type RegistrationParams = { device: string; type: string; serial: string };
    const registration = "/wallet/v1/devices/:device/registrations/:type/:serial";
    app.post<{ Params: RegistrationParams }>(registration, smallBody, async (request, reply) => {
        const { device, type, serial } = request.params;
        const pass = await wallet.authorize(request.headers.authorization, type, serial);
        const { pushToken } = objectBody(request.body);
        if (typeof pushToken !== "string" || !/^[0-9a-fA-F]{32,512}$/.test(pushToken)) throw new HttpError(400, "Invalid push token.");
        const inserted = await wallet.register(deviceID(device), pass.serial, pushToken);
        return reply.code(inserted ? 201 : 200).send();
    });
    app.delete<{ Params: RegistrationParams }>(registration, async (request, reply) => {
        const { device, type, serial } = request.params;
        const pass = await wallet.authorize(request.headers.authorization, type, serial);
        await wallet.unregister(deviceID(device), pass.serial);
        return reply.code(200).send();
    });
    app.get<{ Params: { device: string; type: string }; Querystring: { passesUpdatedSince?: string } }>(
        "/wallet/v1/devices/:device/registrations/:type", async (request, reply) => {
            const since = request.query.passesUpdatedSince;
            if (since !== undefined && typeof since !== "string") throw new HttpError(400, "Invalid update tag.");
            const changes = await wallet.changes(deviceID(request.params.device), request.params.type, since);
            return changes ? reply.send(changes) : reply.code(204).send();
        });
    app.get<{ Params: { type: string; serial: string } }>("/wallet/v1/passes/:type/:serial", async (request, reply) => {
        const { type, serial } = request.params;
        const authorized = await wallet.authorize(request.headers.authorization, type, serial);
        let pass;
        try { pass = await wallet.publish(authorized.serial); }
        catch { throw new HttpError(503, "Wallet pass is not ready. Retry the request."); }
        const etag = `"${pass.revision}"`;
        reply.header("Last-Modified", new Date(Number(pass.modified) * 1000).toUTCString()).header("ETag", etag);
        const noneMatch = request.headers["if-none-match"];
        if (noneMatch !== undefined ? noneMatch === etag : Date.parse(request.headers["if-modified-since"] ?? "") >= Number(pass.modified) * 1000) {
            return reply.code(304).send();
        }
        return reply.type("application/vnd.apple.pkpass").send(pass.bytes);
    });
    app.post("/wallet/v1/log", smallBody, async (request, reply) => {
        const { logs } = objectBody(request.body);
        if (!Array.isArray(logs) || logs.length > 100 || logs.some((value: unknown) => typeof value !== "string")) {
            throw new HttpError(400, "Invalid diagnostics.");
        }
        return reply.code(200).send();
    });
};
