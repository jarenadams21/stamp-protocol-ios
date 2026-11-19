// Prints new secrets for AUTH_MODE=live. Store them in the secrets store, never in the repository.
//   npm run auth:key
import { generateSigningKey } from "../src/auth.ts";

console.log(`AUTH_SIGNING_KEY=${JSON.stringify(await generateSigningKey())}`);
console.log(`PHONE_HASH_PEPPER=${crypto.getRandomValues(Buffer.alloc(32)).toString("base64url")}`);
