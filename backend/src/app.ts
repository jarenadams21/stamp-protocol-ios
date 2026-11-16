import Fastify, { type FastifyServerOptions } from "fastify";
import type pg from "pg";
import type { AuthConfig } from "./auth.ts";
import { ApiError } from "./errors.ts";
import { imageTooLarge, unsupportedImageType, type ImageStore } from "./images.ts";
import { partnerRoutes } from "./routes/partner.ts";

export interface AppOptions {
    pool: pg.Pool;
    auth: AuthConfig;
    images: ImageStore;
    logger?: FastifyServerOptions["logger"];
}

/** The single backend application (spec section 2). Handlers are modules registered under /v1. */
export function buildApp({ pool, auth, images, logger = false }: AppOptions) {
    const app = Fastify({
        logger,
        // Every request gets its own ID for structured logs; client-supplied IDs are not trusted.
        genReqId: () => crypto.randomUUID(),
        requestIdHeader: false,
        bodyLimit: 64 * 1024,
    });

    app.addHook("onSend", async (request, reply) => {
        reply.header("x-request-id", request.id);
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
            return { status: "ok" };
        } catch (error) {
            request.log.error({ err: error }, "database health check failed");
            return reply.code(503).send({ status: "unavailable" });
        }
    });

    app.register(partnerRoutes, { prefix: "/v1/partner", pool, auth, images });
    if (images.routes) app.register(images.routes);

    return app;
}
