import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
    BlobSASPermissions,
    BlobServiceClient,
    generateBlobSASQueryParameters,
    SASProtocol,
    type ContainerClient,
    type UserDelegationKey,
} from "@azure/storage-blob";
import type { FastifyPluginAsync } from "fastify";
import sharp from "sharp";
import { ApiError, invalid } from "./errors.ts";

// Image rules (docs/backend-spec.md sections 8.1 and 10) ---------------------------------------

export const IMAGE_KINDS = ["logo", "cover"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
export type ImageContentType = "image/png" | "image/jpeg";

/** The largest upload the API accepts. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Refuses decompression bombs: a small file that decodes to an enormous bitmap. */
const MAX_INPUT_PIXELS = 50_000_000;
/** Stored images are scaled down to fit this many pixels on their longest side. */
const MAX_DIMENSION: Record<ImageKind, number> = { logo: 1024, cover: 2048 };

export const unsupportedImageType = () => new ApiError(415, "unsupportedImageType", "Use a PNG or JPEG image.");
export const imageTooLarge = () => new ApiError(413, "imageTooLarge", "Use an image smaller than 5 MB.");
const invalidImage = () => invalid("invalidImage", "This image couldn't be read. Choose a different PNG or JPEG.");

export interface ProcessedImage {
    data: Buffer;
    contentType: ImageContentType;
    extension: "png" | "jpg";
    width: number;
    height: number;
}

/**
 * Checks that the bytes really are a PNG or JPEG (the Content-Type header is not trusted), then
 * re-encodes them. Re-encoding applies the camera's rotation, converts to sRGB, scales oversized
 * images down, and drops all metadata (EXIF, including GPS location), so nothing but pixels is stored.
 */
export async function processImage(data: Buffer, kind: ImageKind): Promise<ProcessedImage> {
    if (data.length === 0) throw invalidImage();
    if (data.length > MAX_UPLOAD_BYTES) throw imageTooLarge();
    try {
        const image = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
        const { format } = await image.metadata();
        if (format !== "png" && format !== "jpeg") throw unsupportedImageType();
        const resized = image
            .rotate()
            .resize({ width: MAX_DIMENSION[kind], height: MAX_DIMENSION[kind], fit: "inside", withoutEnlargement: true });
        const encoded = format === "png" ? resized.png({ compressionLevel: 9 }) : resized.jpeg({ quality: 85, mozjpeg: true });
        const output = await encoded.toBuffer({ resolveWithObject: true });
        return {
            data: output.data,
            contentType: format === "png" ? "image/png" : "image/jpeg",
            extension: format === "png" ? "png" : "jpg",
            width: output.info.width,
            height: output.info.height,
        };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw invalidImage();
    }
}

// Storage keys -------------------------------------------------------------------------------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_PATTERN = new RegExp(`^businesses/${UUID}/(logo|cover)/${UUID}\\.(png|jpg)$`);

/** The blob name for a new image. The business ID comes from the token, never from the client. */
export function newImageKey(businessId: string, kind: ImageKind, extension: "png" | "jpg"): string {
    return `businesses/${businessId}/${kind}/${crypto.randomUUID()}.${extension}`;
}

/** True when `value` has the shape of a key this API issued. Ownership is checked in the database. */
export function isImageKey(value: unknown): value is string {
    return typeof value === "string" && KEY_PATTERN.test(value);
}

// Stores -------------------------------------------------------------------------------------

/** Private storage for image bytes. Apps never get a permanent address, only short-lived URLs. */
export interface ImageStore {
    /** Where images go, for logs and scripts. */
    readonly label: string;
    put(key: string, data: Buffer, contentType: ImageContentType): Promise<void>;
    remove(key: string): Promise<void>;
    /** A URL that can read this one image until it expires. */
    url(key: string): Promise<string>;
    /** Routes the store serves itself. Only the local development store has any. */
    routes?: FastifyPluginAsync;
}

/** How long a delegation key is requested for, and how early a SAS start time is backdated for clock skew. */
const DELEGATION_KEY_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface AzureImageStoreOptions {
    account: string;
    container: string;
    urlTtlSeconds: number;
    credential?: TokenCredential;
}

/**
 * Azure Blob Storage with Microsoft Entra sign-in, like the database: `az login` on a developer
 * machine and a managed identity in Azure, so no account key or connection string exists anywhere.
 * Read URLs are user delegation SAS tokens, signed with a key that Entra issues to this identity.
 */
export class AzureImageStore implements ImageStore {
    private readonly service: BlobServiceClient;
    private readonly container: ContainerClient;
    private readonly options: AzureImageStoreOptions;
    private delegation: { key: UserDelegationKey; expiresAt: number } | undefined;
    private pending: Promise<UserDelegationKey> | undefined;

    constructor(options: AzureImageStoreOptions) {
        this.options = options;
        this.service = new BlobServiceClient(
            `https://${options.account}.blob.core.windows.net`,
            options.credential ?? new DefaultAzureCredential(),
        );
        this.container = this.service.getContainerClient(options.container);
    }

    get label(): string {
        return `Azure Blob Storage (account ${this.options.account}, container ${this.options.container})`;
    }

    async put(key: string, data: Buffer, contentType: ImageContentType): Promise<void> {
        await this.container.getBlockBlobClient(key).uploadData(data, {
            // Keys are never reused, so a stored image never changes.
            blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: "private, max-age=86400, immutable" },
        });
    }

    async remove(key: string): Promise<void> {
        await this.container.getBlockBlobClient(key).deleteIfExists();
    }

    async url(key: string): Promise<string> {
        const delegationKey = await this.delegationKey();
        const now = Date.now();
        const sas = generateBlobSASQueryParameters(
            {
                containerName: this.options.container,
                blobName: key,
                permissions: BlobSASPermissions.parse("r"),
                startsOn: new Date(now - CLOCK_SKEW_MS),
                expiresOn: new Date(now + this.options.urlTtlSeconds * 1000),
                protocol: SASProtocol.Https,
            },
            delegationKey,
            this.options.account,
        );
        return `${this.container.getBlobClient(key).url}?${sas.toString()}`;
    }

    /** One delegation key signs many URLs. It's replaced before a URL could outlive it. */
    private async delegationKey(): Promise<UserDelegationKey> {
        const needed = Date.now() + this.options.urlTtlSeconds * 1000 + CLOCK_SKEW_MS;
        if (this.delegation && this.delegation.expiresAt > needed) return this.delegation.key;
        this.pending ??= (async () => {
            const expiresAt = Date.now() + DELEGATION_KEY_MS;
            const key = await this.service.getUserDelegationKey(new Date(Date.now() - CLOCK_SKEW_MS), new Date(expiresAt));
            this.delegation = { key, expiresAt };
            return key;
        })().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }
}

export interface LocalImageStoreOptions {
    directory: string;
    /** Where apps reach this API, for example http://localhost:8080. */
    baseUrl: string;
    urlTtlSeconds: number;
}

/**
 * Development and test storage: files on disk, served by this API through signed, expiring URLs
 * that behave like Azure's. It lets a teammate without Azure access run the whole image flow.
 * Never used in production.
 */
export class LocalImageStore implements ImageStore {
    private readonly options: LocalImageStoreOptions;
    /** Signs URLs. It's new on every start, so old URLs stop working when the server restarts. */
    private readonly secret = randomBytes(32);

    constructor(options: LocalImageStoreOptions) {
        this.options = options;
    }

    get label(): string {
        return `local folder ${this.options.directory}`;
    }

    async put(key: string, data: Buffer): Promise<void> {
        const file = this.file(key);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, data);
    }

    async remove(key: string): Promise<void> {
        await rm(this.file(key), { force: true });
    }

    async url(key: string): Promise<string> {
        const expires = Math.floor(Date.now() / 1000) + this.options.urlTtlSeconds;
        return `${this.options.baseUrl}/dev/images/${key}?expires=${expires}&signature=${this.sign(key, expires)}`;
    }

    routes: FastifyPluginAsync = async (app) => {
        app.get<{ Params: { "*": string }; Querystring: { expires?: string; signature?: string } }>(
            "/dev/images/*",
            async (request, reply) => {
                const key = request.params["*"];
                const expires = Number(request.query.expires);
                const signature = Buffer.from(request.query.signature ?? "", "utf8");
                const forbidden = () => reply.code(403).send({ error: "forbidden", message: "This image link is invalid or has expired." });
                if (!isImageKey(key) || !Number.isInteger(expires)) return forbidden();
                const expected = Buffer.from(this.sign(key, expires), "utf8");
                if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return forbidden();
                if (expires * 1000 <= Date.now()) return forbidden();
                const data = await readFile(this.file(key)).catch(() => undefined);
                if (!data) return reply.code(404).send({ error: "notFound", message: "No such image." });
                return reply
                    .header("content-type", key.endsWith(".png") ? "image/png" : "image/jpeg")
                    .header("cache-control", "private, max-age=86400, immutable")
                    .send(data);
            },
        );
    };

    private sign(key: string, expires: number): string {
        return createHmac("sha256", this.secret).update(`${key}\n${expires}`).digest("base64url");
    }

    private file(key: string): string {
        // Keys are generated by this API; the check keeps a malformed one from leaving the directory.
        if (!isImageKey(key)) throw new Error("Not an image key");
        return path.join(this.options.directory, key);
    }
}

// Configuration ------------------------------------------------------------------------------

const LOCAL_IMAGE_DIRECTORY = fileURLToPath(new URL("../.dev/images/", import.meta.url));

/** Builds the image store from IMAGE_STORE and the AZURE_STORAGE_* settings. */
export function imagesFromEnv(env: NodeJS.ProcessEnv = process.env): ImageStore {
    const urlTtlSeconds = Number(env.IMAGE_URL_TTL_SECONDS ?? 900);
    if (!Number.isInteger(urlTtlSeconds) || urlTtlSeconds < 60 || urlTtlSeconds > 3600) {
        throw new Error("IMAGE_URL_TTL_SECONDS must be a whole number from 60 to 3600");
    }
    const mode = env.IMAGE_STORE ?? "azure";
    if (mode === "local") {
        if (env.NODE_ENV === "production") throw new Error("IMAGE_STORE=local is not allowed when NODE_ENV=production");
        const baseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/+$/, "");
        return new LocalImageStore({ directory: LOCAL_IMAGE_DIRECTORY, baseUrl, urlTtlSeconds });
    }
    if (mode !== "azure") throw new Error(`IMAGE_STORE must be "azure" or "local", not "${mode}"`);
    const account = env.AZURE_STORAGE_ACCOUNT;
    const container = env.AZURE_STORAGE_CONTAINER ?? "images";
    if (!account || !/^[a-z0-9]{3,24}$/.test(account)) {
        throw new Error("IMAGE_STORE=azure needs AZURE_STORAGE_ACCOUNT, the storage account's name (see backend/.env.example)");
    }
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(container)) {
        throw new Error("AZURE_STORAGE_CONTAINER is not a valid container name");
    }
    return new AzureImageStore({ account, container, urlTtlSeconds });
}
