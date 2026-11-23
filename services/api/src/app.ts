import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import type pg from "pg";
import type { AuthConfig } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { imageTooLarge, unsupportedImageType, type ImageStore } from "./images.ts";
import { devRoutes } from "./routes/dev.ts";
import { partnerRoutes } from "./routes/partner.ts";
import type { NativeServices } from "./native/index.ts";
import { nativeRoutes } from "./native/routes.ts";
import { placesRoutes } from "./routes/places.ts";
import { webRoutes } from "./routes/web.ts";
import { signInRoutes, type SignInOptions } from "./signIn.ts";
import { tagVerifier, type TagVerifier } from "./tags.ts";

export interface AppOptions {
    pool: pg.Pool;
    auth: AuthConfig;
    images: ImageStore;
    /** Sign-in routes and the public signing key. Left out by tests that only need tokens. */
    signIn?: SignInOptions;
    /** Fastify's trustProxy, so rate limits see the client's IP behind a load balancer. */
    trustProxy?: FastifyServerOptions["trustProxy"];
    logger?: FastifyServerOptions["logger"];
    /** Verifies stand tap links (TAG_MODE). Left out, no tap verifies: production can't fall back to dev links. */
    tags?: TagVerifier;
    /** Website origins allowed to call /v1/web and /v1/places with credentials (WEB_ORIGINS). */
    webOrigins?: string[];
    /** The web cookie's Secure flag. Off only with AUTH_MODE=dev, on plain http://localhost. */
    secureCookie?: boolean;
    /** Registers /v1/dev (AUTH_MODE=dev only). */
    devRoutes?: boolean;
    native?: NativeServices;
}

/** Routes the website calls from its own origin, so CORS applies to them and nothing else. */
const CORS_PREFIXES = ["/v1/web", "/v1/places"];

/** The single backend application (spec section 2). Handlers are modules registered under /v1. */
export function buildApp({
    pool,
    auth,
    images,
    signIn,
    trustProxy = false,
    logger = false,
    tags = tagVerifier("sun"),
    webOrigins = [],
    secureCookie = true,
    devRoutes: dev = false,
    native,
}: AppOptions) {
    const app = Fastify({
        logger,
        trustProxy,
        // Every request gets its own ID for structured logs; client-supplied IDs are not trusted.
        genReqId: () => crypto.randomUUID(),
        requestIdHeader: false,
        bodyLimit: 64 * 1024,
        // Wallet path parameters contain device identifiers. Never emit raw access URLs.
        logController: new LogController({
            disableRequestLogging: (request) => request.url.startsWith("/wallet/") || request.url.startsWith("/api/v1/"),
        }),
    });

    app.addHook("onSend", async (request, reply) => {
        reply.header("x-request-id", request.id);
    });

    // CORS for the website (docs/web-connect.md, decision 3): only the listed origins, with
    // credentials, and only on the routes it calls. Other origins get no CORS headers, so browsers
    // refuse to show them the response. Preflights are answered here, before routing.
    app.addHook("onRequest", async (request, reply) => {
        const path = request.url.split("?")[0]!;
        if (!CORS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return;
        reply.header("vary", "Origin");
        const origin = request.headers.origin;
        if (!origin || !webOrigins.includes(origin)) return;
        reply.header("access-control-allow-origin", origin);
        reply.header("access-control-allow-credentials", "true");
        if (request.method === "OPTIONS") {
            reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE");
            reply.header("access-control-allow-headers", "content-type");
            reply.header("access-control-max-age", "600");
            return reply.code(204).send();
        }
    });

    app.setErrorHandler((error, request, reply) => {
        if (error instanceof ApiError) {
            return reply.code(error.status).send({ error: error.code, message: error.message });
        }
        const status = (error as { statusCode?: number }).statusCode;
        if (request.routeOptions.config.imageUpload && (status === 413 || status === 415)) {
            const mapped = status === 413 ? imageTooLarge() : unsupportedImageType();
            return reply.code(mapped.status).send({ error: mapped.code, message: mapped.message });
        }
        if (status && status >= 400 && status < 500) {
            // Malformed JSON, wrong content type, or a body over the limit.
            return reply.code(status).send({ error: "invalidBody", message: "The request body couldn't be read." });
        }
        request.log.error({ err: error }, "unhandled error");
        return reply.code(500).send({ error: "internal", message: "Something went wrong. Try again." });
    });

    app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: "notFound", message: "No such route." }));

    app.get("/healthz", async (request, reply) => {
        try {
            await pool.query("SELECT 1");
            return { status: "ok", nativeNfc: native ? { enabled: true, factoryKeyTest: native.factoryTest } : { enabled: false } };
        } catch (error) {
            request.log.error({ err: error }, "database health check failed");
            return reply.code(503).send({ status: "unavailable" });
        }
    });

    if (signIn) {
        app.register(signInRoutes, { prefix: "/v1/auth", ...signIn, pool });
        app.get("/.well-known/jwks.json", async (request, reply) => {
            reply.header("cache-control", "public, max-age=3600");
            return signIn.signer.jwks;
        });
    }
    app.register(partnerRoutes, { prefix: "/v1/partner", pool, auth, images });
    app.register(placesRoutes, { prefix: "/v1/places", pool, images });
    app.register(webRoutes, { prefix: "/v1/web", pool, images, tags, signIn, secureCookie, origins: webOrigins, claimUnknownStands: dev });
    if (dev) app.register(devRoutes, { prefix: "/v1/dev", pool, auth });
    if (images.routes) app.register(images.routes);
    if (native) app.register(nativeRoutes, native);

    return app;
}
