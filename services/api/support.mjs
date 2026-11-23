import { isIP } from "node:net";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.entries = new Map(); }
  check(key) {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key);
    if (!this.entries.has(key)) {
      if (this.entries.size >= 10000) throw new HttpError(429, "Too many requests. Try again later.");
      this.entries.set(key, { count: 0, until: now + this.windowMs });
    }
    if (++this.entries.get(key).count > this.limit) throw new HttpError(429, "Too many requests. Try again later.");
  }
}
export function clientIP(req, trustCloudflare) {
  const peer = req.socket.remoteAddress;
  const forwarded = req.headers["cf-connecting-ip"];
  return trustCloudflare && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) &&
    typeof forwarded === "string" && isIP(forwarded) ? forwarded : peer;
}
export async function jsonBody(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "Send JSON.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16384) throw new HttpError(413, "Request too large.");
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new HttpError(400, "Invalid JSON."); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new HttpError(400, "Expected a JSON object.");
  return result;
}
export async function verifyTag(base, rawURL) {
  let input;
  try { input = new URL(rawURL); }
  catch { throw new HttpError(400, "The chip did not contain a valid URL."); }
  if (input.protocol !== "https:" || !["/tagtt", "/tag", "/tap"].includes(input.pathname) || rawURL.length > 4096) {
    throw new HttpError(400, "Use a programmed NTAG 424 DNA chip.");
  }
  const params = new URLSearchParams();
  for (const field of ["e", "picc_data", "enc", "cmac"]) {
    const values = input.searchParams.getAll(field);
    if (values.length > 1) throw new HttpError(400, "Repeated chip parameters.");
    if (values.length) {
      if (!/^[0-9a-fA-F]+$/.test(values[0]) || values[0].length > 512 || values[0].length % 2) throw new HttpError(400, "Invalid chip data.");
      params.set(field, values[0]);
    }
  }
  if (!params.has("e") && (!params.has("picc_data") || !params.has("cmac"))) throw new HttpError(400, "This chip is missing its dynamic signature.");
  const endpoint = new URL("/api/tagtt", base);
  endpoint.search = params;
  let body;
  try {
    const response = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Verifier unavailable");
    body = await response.json();
  } catch { throw new HttpError(503, "The private NFC verifier is unavailable. Try again."); }
  if (!body || Object.hasOwn(body, "error")) throw new HttpError(422, "Chip verification failed. Check its programming key.");
  if (typeof body.uid !== "string" || !/^[0-9a-fA-F]{14}$/.test(body.uid) ||
      !Number.isInteger(body.read_ctr) || body.read_ctr < 0 || body.read_ctr > 0xffffff ||
      !["AES", "LRP"].includes(body.enc_mode)) throw new HttpError(502, "Invalid verifier response.");
  return { uid: body.uid.toUpperCase(), counter: body.read_ctr };
}
