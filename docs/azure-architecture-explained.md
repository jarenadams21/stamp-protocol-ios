# How JOEYY Works: The Story Behind the Architecture Chart

*Read this next to `azure-architecture.html`. Each section matches one of the four flows on the chart.*

---

## The big picture

JOEYY has a simple job. When a customer taps their iPhone on the NFC chip at the counter, they get a stamp, and the loyalty card in their Apple Wallet updates on its own.

To make that safe and reliable, the work is split across a few places:

- **Your iPhone**: the JOEYY app (it reads the chip) and Apple Wallet (it shows the card).
- **The NFC chip** (an NTAG 424 DNA) sitting at the counter.
- **Azure**: Microsoft's cloud. This is where our backend runs 24/7, so it no longer depends on your Mac being switched on.
- **Apple's push service (APNs)**: Apple's server that can nudge an iPhone to say "something changed."
- **GitHub**: where the code lives and where new versions get built and shipped from.

Everything we own in Azure sits inside one **resource group** called `joeyy-dev-rg`. Think of it as a folder. The `joeyy-devs` team group are Owners of that folder.

---

## Flow 1: Scanning a chip

This is the most important flow. Here's what happens in the second or two after a customer taps.

**1. Tap the chip.**
The JOEYY app turns on the iPhone's NFC reader. The chip gives back a web link that looks like gibberish. The chip creates a brand-new scrambled link every single time it is tapped. Hidden inside it are:
- the chip's ID,
- a **read counter** (a number that goes up by one with every tap; yours was at 21),
- a **signature** (called a CMAC) proving the link really came from that chip.

The phone can't read any of this. It only has the scrambled text.

**2. Send it to Azure.**
The app sends that scrambled text over a secure (HTTPS) connection to our backend's permanent address:
`joeyy-api.happycoast-32e2d60b.westus.azurecontainerapps.io`.
That address belongs to a **Container App** called `joeyy-api`. Think of it as a kitchen that is open 24/7.

**3. Ask the private verifier.**
Inside the Container App there are actually **two containers** (two small programs) running side by side:
- the **api container**: the Node.js program that handles everything the public talks to;
- the **verifier**: a small Python helper whose only job is to unscramble chip links.

The verifier is called a **sidecar** because it rides alongside the main program. It is only reachable from *inside* the Container App (address `127.0.0.1`). Nobody on the internet can talk to it directly. The api container hands it the scrambled text.

**4. Decrypt and check.**
The verifier uses the **chip master key** to unscramble the link. That key is a secret, and it is kept in Azure **Key Vault**, our locked safe. The verifier:
- pulls out the chip ID and read counter;
- checks the signature;
- rejects a link that has been tampered with (the backend answers with error 422).

**5. Award the stamp (one transaction).**
Back in the api container, the backend asks the **PostgreSQL database** (`joeyy-dev-pg`) a few questions:
- **Is this chip known and linked to a cafe?** If not, it answers "chip not linked."
- **Is this read counter higher than the last one we saw?** If not, someone is replaying an old link. That's rejected with error 409. Because the counter must always go up, a copied or screenshotted link can't earn a second stamp.

If both checks pass, then in **one database transaction** (everything happens together, or nothing does) it:
- records the tap event,
- saves the new last counter,
- adds +1 stamp to the customer's card,
- marks the Wallet pass as "changed."

**6. Reply to the phone.**
The backend tells the app "verified, read counter 21, you now have X stamps." That's the message you saw on your phone.

**7. Update Apple Wallet.**
This happens on its own. See Flow 2.

---

## Flow 2: The Wallet card updating by itself

Apple Wallet cards don't refresh themselves on a timer. Something has to tell the iPhone to check. Here's how that works.

**When the card is first added:** your iPhone's Wallet **registers** with our backend. It says "this phone has this card; tell me if it changes." That registration is saved in the database.

**After a stamp:** a background **worker** inside the api container wakes up **every 15 seconds** and looks for cards marked "changed." When it finds one, it sends a tiny, empty **push notification** through **Apple's push service (APNs)**. It is basically a tap on the shoulder that says "something changed." It is signed with our Apple pass certificate, so Apple knows it's really from us.

**The iPhone then asks for the new card:**
1. Wallet wakes up and calls our backend's Wallet address (`/wallet/v1`): "Which of my cards changed?"
2. Our backend answers, and Wallet downloads a fresh **.pkpass** file (the card itself).
3. That file is **signed** with our **Apple Wallet certificate and private key**, plus Apple's **WWDR certificate**. All three are stored in Key Vault. Wallet only accepts the card if the signature checks out.
4. The card on the phone now shows the new stamp count.

This is why you don't need to rebuild or re-add the card. It updates in place, usually within seconds to a minute.

---

## Flow 3: Shipping new code (GitHub to Azure)

A common mix-up is to think Azure "reads from GitHub." It doesn't. **GitHub pushes to Azure.**

1. **Code lives in GitHub.** That includes the backend, the `infra/` setup files and the iOS app.
2. **Merge to `main`.** When a change is merged, **GitHub Actions** (GitHub's robot) runs the tests first.
3. **Sign in to Azure without a password.** If the tests pass, the robot logs into Azure using a managed identity (an ID badge) called **`joeyy-github-deployer`**. It uses a method called **OIDC**: Azure trusts GitHub's word that "this is the `main` branch of our repo." So no password is stored anywhere. Only code on `main` can deploy.
4. **Build the images.** The robot packs the backend and the verifier into **images** (frozen, ready-to-run copies). It stores them in the **Container Registry** (`joeyydevacrq6nfbh`). Think of it as a shelf of packaged meals, each labelled with a version.
5. **Swap to the new version.** The robot tells the Container App "run version X now." The Container App pulls that image from the shelf, starts it, and checks it's healthy. Only then does it send real traffic to it.

Today, I deployed by hand with `infra/deploy.sh`. The automatic version switches on once the repo admin adds three settings to GitHub (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) and the branch is merged.

---

## Flow 4: App start-up and security

When the Container App starts (or restarts), it gets ready like this:

1. **It shows its ID badge.** The running app has its own managed identity, **`joeyy-api-identity`**. This badge, not a password, is what lets it into the other Azure services.
2. **It opens the safe.** Using the badge, Azure fetches the secrets from **Key Vault** (`joeyy-dev-kv-q6nfbh`):
   - the Apple Wallet certificate and key,
   - the Apple WWDR certificate,
   - the chip master key.

   The certificates become files the api container can read. The chip master key is given **only to the verifier**. None of these secrets are ever stored in GitHub.
3. **It pulls its image** from the Container Registry, again using the badge.
4. **It signs in to the database.** PostgreSQL has password login turned off. The app signs in with its badge, through Microsoft Entra ID (Microsoft's login system), as the database user `joeyy-api-identity`.
5. **It runs a health check.** The app reports healthy only if:
   - the database is reachable and up to date (all migrations applied), **and**
   - the verifier is running.

   Azure won't send customers to a copy that isn't healthy.
6. **It keeps a diary.** All logs and errors go to **Log Analytics** (`joeyy-dev-logs`), so we can debug problems later.

There is always **exactly one copy** running, so the 15-second Wallet worker never stops.

---

## The Azure pieces, in one place

| Piece | Name | Think of it as | Why it's there |
|---|---|---|---|
| Resource group | `joeyy-dev-rg` | A folder | Holds everything, with shared permissions |
| Container Apps environment | `joeyy-dev-env` | The building | The private area our containers live in; more services (e.g. a .NET one) can move in later |
| Container App | `joeyy-api` | The kitchen, open 24/7 | Runs the api and verifier containers at a permanent HTTPS address |
| Container Registry | `joeyydevacrq6nfbh` | A shelf of packaged meals | Stores each built version |
| Key Vault | `joeyy-dev-kv-q6nfbh` | A locked safe | Apple certificates and the chip master key |
| PostgreSQL | `joeyy-dev-pg` | The filing cabinet | Cafes, chips, cards, stamps, tap events, Wallet registrations (this already existed) |
| Blob storage | `joeyydevimages` | A photo album | Cafe and partner images (this already existed) |
| Log Analytics | `joeyy-dev-logs` | A diary | Logs and errors for debugging |
| Managed identities | `joeyy-api-identity`, `joeyy-github-deployer` | ID badges | Let the app and the GitHub robot in without passwords |

---

## Key ideas to remember

- **The chip proves the tap is real.** The secret key never leaves Azure, so only our backend can unscramble chip links.
- **The read counter stops cheating.** A link can only be used once, because the counter must always go up.
- **The verifier is a private helper (sidecar).** It is hidden inside the Container App and never exposed to the internet.
- **No passwords anywhere.** Everything uses managed identities (badges) and OIDC.
- **Secrets live only in Key Vault**, never in GitHub or on your Mac.
- **Wallet updates are push-then-pull.** Apple nudges the phone, and the phone downloads the new signed card from us.
- **GitHub pushes to Azure, not the other way around.** Tests run first, and only `main` can deploy.
- **Your Mac is no longer needed.** It all runs in Azure around the clock.
