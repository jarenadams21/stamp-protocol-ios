import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const [baseURL, prototypePath] = process.argv.slice(2);
if (!baseURL?.startsWith("https://") || new URL(baseURL).origin !== baseURL || !prototypePath) {
  throw new Error("Usage: node setup-local.mjs https://PUBLIC-HOST /path/to/cafe-wallet-prototype");
}
process.loadEnvFile(join(resolve(prototypePath), ".env"));
if (!process.env.PASS_TYPE_ID || !process.env.TEAM_ID) throw new Error("Prototype Apple identifiers are not configured.");
const quote = (value) => {
  if (/[\r\n"]/.test(String(value))) throw new Error("Set quoted/newline-containing configuration values manually in .env.");
  return `"${value}"`;
};
const contents = [
  "HOST=127.0.0.1", "PORT=3002", `PUBLIC_BASE_URL=${baseURL}`, "SDM_BACKEND_URL=http://127.0.0.1:5005",
  "FACTORY_KEY_TEST=1", "TRUST_CLOUDFLARE=1",
  `PASS_TYPE_ID=${process.env.PASS_TYPE_ID}`, `TEAM_ID=${process.env.TEAM_ID}`,
  `SIGNER_CERT_PATH=${quote(join(resolve(prototypePath), "certs/signerCert.pem"))}`,
  `SIGNER_KEY_PATH=${quote(join(resolve(prototypePath), "certs/signerKey.pem"))}`,
  `WWDR_CERT_PATH=${quote(join(resolve(prototypePath), "certs/wwdr.pem"))}`,
  ...(process.env.SIGNER_KEY_PASSPHRASE ? [`SIGNER_KEY_PASSPHRASE=${quote(process.env.SIGNER_KEY_PASSPHRASE)}`] : []), ""
].join("\n");
await writeFile(".env", contents, { flag: "wx", mode: 0o600 });
await mkdir("../Config", { recursive: true });
const appURL = baseURL.replace("https://", "https:/$()/");
await writeFile("../Config/Local.xcconfig", `LOYALTY_API_BASE_URL = ${appURL}\nDEVELOPMENT_TEAM = ${process.env.TEAM_ID}\n`, { flag: "wx", mode: 0o600 });
console.log("Created ignored local server and app configuration. No private keys copied or credentials printed.");
