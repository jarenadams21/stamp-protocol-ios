import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CustomerStore } from "./store.mjs";
import { customerAPI } from "./api.mjs";
import { verifyTag } from "./support.mjs";
import { CustomerWallet, applePush } from "./wallet.mjs";

const baseURL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
if (!baseURL || !baseURL.startsWith("https://") || new URL(baseURL).origin !== baseURL) throw new Error("Set PUBLIC_BASE_URL to a public HTTPS origin.");
const port = Number(process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
if (!process.env.PASS_TYPE_ID?.startsWith("pass.") || !process.env.TEAM_ID) throw new Error("Configure the Apple pass identifier and team.");
const verifier = process.env.SDM_BACKEND_URL ?? "http://127.0.0.1:5005";
const verifierURL = new URL(verifier);
if (verifierURL.protocol !== "http:" || verifierURL.username || verifierURL.password) throw new Error("Use a private HTTP SDM service.");
const dataDir = resolve(process.env.DATA_DIR ?? "data");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const certificates = {
  signerCert: await readFile(process.env.SIGNER_CERT_PATH),
  signerKey: await readFile(process.env.SIGNER_KEY_PATH),
  wwdr: await readFile(process.env.WWDR_CERT_PATH),
  ...(process.env.SIGNER_KEY_PASSPHRASE ? { signerKeyPassphrase: process.env.SIGNER_KEY_PASSPHRASE } : {})
};
const store = new CustomerStore(join(dataDir, "customers.sqlite"));
const wallet = new CustomerWallet({ store, dataDir, baseURL, passType: process.env.PASS_TYPE_ID,
  teamID: process.env.TEAM_ID, certificates, sendPush: applePush(certificates, process.env.PASS_TYPE_ID) });
// Finish pass publication after a restart without replaying or re-awarding any NFC event.
for (const row of store.db.prepare("SELECT id,customer_id FROM cards").all()) await wallet.publish(store.card(row.id, row.customer_id));
const runPush = () => wallet.flush().catch(() => console.error("Wallet push worker failed; jobs remain queued."));
const timer = setInterval(runPush, 15000);
timer.unref();
runPush();
const handler = customerAPI({ store, wallet, verify: (url) => verifyTag(verifier, url),
  trustCloudflare: process.env.TRUST_CLOUDFLARE === "1", factoryTest: process.env.FACTORY_KEY_TEST !== "0" });
const server = createServer(handler);
server.requestTimeout = 15000;
server.on("error", () => { console.error("Customer API could not listen on its configured address."); process.exit(1); });
server.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`Customer API listening on port ${port}. Signing keys remain outside the repository.`));
