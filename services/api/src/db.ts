import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import pg from "pg";

/** Entra scope for Azure Database for PostgreSQL. */
const POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
/** Refresh a token this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Returns a function that yields a Microsoft Entra access token to use as the Postgres password.
 * DefaultAzureCredential uses `az login` on a developer machine and a managed identity in Azure,
 * so no database password is stored anywhere. Tokens are cached until shortly before expiry.
 */
export function entraPassword(credential: TokenCredential = new DefaultAzureCredential()): () => Promise<string> {
    let cached: { token: string; expiresAt: number } | undefined;
    let pending: Promise<string> | undefined;
    return async () => {
        if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;
        pending ??= credential
            .getToken(POSTGRES_SCOPE)
            .then((result) => {
                if (!result) throw new Error("Microsoft Entra returned no token for Azure Database for PostgreSQL");
                cached = { token: result.token, expiresAt: result.expiresOnTimestamp };
                return result.token;
            })
            .finally(() => {
                pending = undefined;
            });
        return pending;
    };
}

export interface PoolOptions {
    /** Extra settings, for example a test schema's search_path. */
    searchPath?: string;
    max?: number;
}

/**
 * Creates a connection pool from the standard PG* environment variables. Uses PGPASSWORD when it is
 * set, and an Entra token otherwise. TLS with certificate verification is on unless PGSSLMODE=disable.
 */
export function createPool(env: NodeJS.ProcessEnv = process.env, options: PoolOptions = {}): pg.Pool {
    const host = env.PGHOST;
    const database = env.PGDATABASE;
    const user = env.PGUSER;
    if (!host || !database || !user) {
        throw new Error("Set PGHOST, PGDATABASE, and PGUSER (see services/api/.env.example)");
    }
    const pool = new pg.Pool({
        host,
        database,
        user,
        port: Number(env.PGPORT ?? 5432),
        password: env.PGPASSWORD ? env.PGPASSWORD : entraPassword(),
        ssl: env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true },
        max: options.max ?? 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 30_000,
        options: options.searchPath ? `-c search_path=${options.searchPath}` : undefined,
        application_name: "joeyy-backend",
    });
    // An idle client can drop (for example, during server maintenance). Log it instead of crashing;
    // the pool replaces the client on the next query.
    pool.on("error", (error) => {
        console.error(JSON.stringify({ level: "error", msg: "idle database client error", err: error.message }));
    });
    return pool;
}

/** Runs `work` in a transaction, committing on success and rolling back on any error. */
export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}
