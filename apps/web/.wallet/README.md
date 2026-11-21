# Apple Wallet signing (private)

Everything in this folder except this README is git-ignored. Never commit or share
`signerKey.pem`: it signs passes as you.

The demo signs real passes when these four files are here:

| File | What it is | Where it comes from |
| --- | --- | --- |
| `signerKey.pem` | Your private key | Already made (with `pass.csr`) |
| `signerCert.pem` | Your Pass Type ID certificate | Step 3 below |
| `wwdr.pem` | Apple's intermediate certificate (WWDR G4) | Step 4 below |
| `pass-type.json` | Your Pass Type ID and Team ID | Step 5 below |

## Steps

1. **Create a Pass Type ID.** In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list/passTypeId),
   add an identifier, choose **Pass Type IDs**, and use something like `pass.com.yourname.joeyy`.
2. **Create its certificate.** Open that Pass Type ID, choose **Create Certificate**, and upload
   `apps/web/.wallet/pass.csr` from this folder.
3. **Download** the certificate (`pass.cer`) and put it in this folder. Then run, from `apps/web/`:

   ```bash
   openssl x509 -inform der -in .wallet/pass.cer -out .wallet/signerCert.pem
   ```

4. **Apple's intermediate certificate:** download *Worldwide Developer Relations - G4* from
   [apple.com/certificateauthority](https://www.apple.com/certificateauthority/) (`AppleWWDRCAG4.cer`),
   put it here, then run:

   ```bash
   openssl x509 -inform der -in .wallet/AppleWWDRCAG4.cer -out .wallet/wwdr.pem
   ```

5. **Create `pass-type.json`.** Your Team ID is shown at the top right of the developer site:

   ```json
   { "passTypeIdentifier": "pass.com.yourname.joeyy", "teamIdentifier": "ABCDE12345", "organizationName": "JOEYY" }
   ```

6. **Restart the dev server.** Check http://localhost:5180/api/wallet/apple/status, which should say
   `"configured": true`. Then tap **Add to Apple Wallet** on your iPhone.

## Live updates on your iPhone

The same certificate signs the pushes that make passes update themselves. Nothing more is needed
from Apple. But iOS only accepts a pass whose update address is HTTPS: a pass naming an `http://`
address is refused with "Safari cannot download this file". So when the demo runs on plain
`http://10.0.0.184:5180`, passes leave the update address out, and **Update Wallet card** refreshes
them instead.

**Easiest: an HTTPS tunnel.** With the demo running (`npm run dev`), run this in another terminal:

```bash
cloudflared tunnel --url http://localhost:5180
```

It prints an address like `https://something.trycloudflare.com`. Open that on the phone (not the
`10.0.0.x` one) and add the pass. Passes added from that address update themselves after every
stamp, with no phone settings. The address changes each time the tunnel starts, so add the pass
again after a restart. Anyone with the address can reach the demo while the tunnel runs; stop it
with Ctrl+C when you're done.

To try live updates over `http://` instead:

1. Turn on Developer Mode (Settings → Privacy & Security → Developer Mode). It appears once the
   phone has been connected to Xcode.
2. Turn on **Settings → Developer → Allow HTTP Services** (under PassKit Testing).
3. Start the demo with `WALLET_HTTP_SERVICES=1 npm run dev`.
4. Add the pass again from the card page. The dev server logs `[wallet] … registered for updates`.

After that, each stamp logs `update pushed` and the pass changes within a few seconds. Served over
HTTPS (a tunnel or a real host), passes include the update address with no setup.
