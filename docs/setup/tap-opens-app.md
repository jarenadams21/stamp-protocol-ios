# Tap opens the app

When someone with the JOEYY app installed taps an NFC chip, iOS opens the app, and the app adds the stamp. No
need to open the app first and press **Scan**.

## What the person sees

1. They hold an iPhone XS or newer (screen on, unlocked) to the chip. The app can be closed.
2. iOS shows a notification for the chip's link. They tap it.
3. JOEYY opens on the **Tap** tab. It adds the stamp by itself, and the Wallet card updates.

iOS always asks for that one tap on the notification. Apple does not allow a silent launch.

Without the app installed, the same tap opens `try.thejoeyy.site` in Safari instead (the website).

## How it works: three pieces that must all be in place

| Piece | Where | What it does |
|---|---|---|
| **The chip's link** | on the card (programmed with the NFC Developer app) | `https://try.thejoeyy.site/tagtt?picc_data=…&cmac=…`. The part after `?` changes on every tap. |
| **The app claims the domain** | `apps/ios/JOEYY/App/JOEYY.entitlements` (`applinks:$(LOYALTY_TAP_LINK_HOST)`) and `apps/ios/Config/App.xcconfig` | Tells iOS this app wants links from that domain. |
| **The domain vouches for the app** | `apps/web/public/.well-known/apple-app-site-association`, served at `https://try.thejoeyy.site/.well-known/apple-app-site-association` | Tells iOS the domain's owner agrees. Apple will not open an app for a domain that does not vouch for it. |

Then the app code takes over: `TapLink.swift` recognises the link, the app opens the Tap tab, and the same code that
handles an in-app scan sends it to the server (`POST /api/v1/taps`), which verifies the chip and adds the stamp.
A link for any other domain or path, or without the chip's signed message, is ignored.

## What whoever deploys the website must do

The file already exists in the repository. It only has to be **published** by the next build of the website.

1. Make sure `apps/web/public/.well-known/apple-app-site-association` goes into the web image (Vite copies
   `public/` into the build as it is; checked).
2. Apple's rules for the file: HTTPS, **HTTP 200**, **no redirect**, valid JSON. The site's catch-all that returns the
   home page for unknown addresses does not apply once the file exists, because the real file is found first.
3. Recommended: serve it as `application/json`. Without this it is served as `application/octet-stream`, which Apple
   usually accepts. In the web image's nginx config, next to the other `location` blocks:

   ```nginx
   location = /.well-known/apple-app-site-association {
     default_type application/json;
     try_files $uri =404;
   }
   ```
4. Check it from `apps/ios`:

   ```sh
   node Tools/check-tap-link.mjs https://try.thejoeyy.site
   ```

   It prints `OK` or says exactly what is wrong. Before the file is published it says the server returns its normal web
   page instead of the file.

The web image is built from `apps/web/deploy/Dockerfile` (`az acr build ... --file deploy/Dockerfile .` from `apps/web`).
The nginx rule for the file is already in `apps/web/deploy/nginx.conf`.

## Testing on a phone

1. The checker above says `OK`.
2. Install an app build that contains the entitlement (build 6 or later; earlier builds do not have it). iOS reads the
   domain file when the app is installed or updated, through Apple's own cache.
3. Force-quit JOEYY. Wake and unlock the phone. Hold a programmed card to the top of the iPhone.
4. Tap the notification. JOEYY should open on the Tap tab and add the stamp.

If Safari opens instead, check in this order: the checker passes; the build is 6 or later; the phone is an iPhone XS
or newer; the card's link is on the configured domain with the path `/tagtt`. Apple caches the domain file, so a change
can take a while to reach phones. Deleting and reinstalling the app makes iOS fetch it again.

## Things to know

- **The domain is stored on every chip.** It is one setting, `LOYALTY_TAP_LINK_HOST` in `apps/ios/Config/App.xcconfig`.
  To change it: reprogram the chips, change that setting, publish the domain file on the new domain, ship a new build.
- **Only `/tagtt` opens the app.** The website's own tap page (`/t?picc=…`) is a different design and is not included.
  The two should eventually use one address.
- **The chip programmer's trial version** adds a `_____TRIAL_VERSION______NOT_FOR_PRODUCTION_____` parameter to the link.
  The server ignores it. Use the full version of the programmer before real cafes.
- **The in-app Scan button still works**, and is the only option on iPhones older than the XS.
- A link that opens the app while another tap is still pending, or before sign-in, is kept and used as soon as the
  screen is free. Nothing is lost.

## If the website cannot publish the file

Use a hostname served by our own API instead (for example `tap.thejoeyy.site` pointing at the NFC api's Container App
with a managed certificate, and the file served by the API). That needs one DNS record for the domain, a custom
domain on the Container App, and reprogramming the cards to the new host. Nothing in the app changes except
`LOYALTY_TAP_LINK_HOST`.
