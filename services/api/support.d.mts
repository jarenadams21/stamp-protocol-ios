export class HttpError extends Error {
    constructor(status: number, message: string);
    status: number;
}
export class RateLimiter {
    constructor(limit: number, windowMs: number);
    check(key: string): void;
}
export function verifyTag(base: string, rawURL: string): Promise<{ uid: string; counter: number }>;
