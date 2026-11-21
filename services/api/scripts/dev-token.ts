// Mints a development token for AUTH_MODE=dev.
//   npm run token -- partner owner-1     -> token for the partner app as subject "owner-1"
//   npm run token -- customer alice
import { devSigner, type Audience } from "../src/auth.ts";

const [audience, subject] = process.argv.slice(2);
if ((audience !== "partner" && audience !== "customer") || !subject) {
    console.error("Usage: npm run token -- <partner|customer> <subject>");
    process.exit(1);
}
const signer = await devSigner({ persist: true });
console.log(await signer.sign(audience as Audience, subject, "12h"));
