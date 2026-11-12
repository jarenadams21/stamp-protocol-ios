# JOEYY

A native SwiftUI customer-loyalty prototype for iOS 18 and later.

## Version 3

The local-first customer experience includes:

| Original v3 item | Delivery |
|---|---|
| 1. Physical-looking hole punch | A metal tool approaches, presses the newest hole, and retracts. Motion preferences take precedence |
| 2. Apple Wallet | Deferred: neither signed passes nor native PassKit presentation is implemented |
| 3. Visual discovery | A swipeable Discoverable preview gallery with large cards, next-card peeking, and snapping. No layout switch |
| 4. Stackable reward tickets | Available/used business stacks; tickets accumulate and open independently |
| 5. Queued stamp updates | Persistent FIFO processing, duplicate protection, overflow retention, and launch/restore recovery. Live delivery is not connected |
| 6. Home, group, and location stacks | Home and every named group reuse `PlaceStack`; each location opens individually. Discovery deliberately uses a gallery |
| 7. Reward stacking | Implicit: new rewards accumulate alongside unused tickets, without a preference control |
| 8. Memories | Individual saved punch-card snapshots and automatically retained completed cards, grouped by place |
| 9. Fallback artwork | Original offline presets across place, ticket, and memory views when no custom photo exists |
| 10. Customized redeemed/memory views | Merchant-themed stacks with preserved punches and Available/Used state. History uses current branding, not frozen artwork |

Existing balances, coupons, favorites, groups, and branding are preserved.
See [DESIGN.md](DESIGN.md) for shared colors, components, motion, and interaction rules.
Apple Wallet and live service delivery are deferred; see [Next steps](#next-steps--integration-handoff).

## Run

Open `JOEYY.xcodeproj`, select **JOEYY** and an iPhone simulator, then Run.
No packages, credentials, signing team, or backend are needed for the simulator.
For a physical device, select your signing team in Xcode.

The included project is generated from `project.yml` using XcodeGen.

## Sample businesses

Names and locations come from the businesses' official websites. Offers,
client IDs, artwork, coupons, and transactions are fictional. Nothing here
represents an actual loyalty program or affiliation.

| Business | Location | Demo card |
|---|---|---|
| [Monorail Espresso](https://monorailespresso.com/pages/pike-st) | 510 Pike St, Seattle | 8 stamps for an espresso; starts at 5 |
| [Cloud City Coffee](https://www.cloudcitycoffee.com/pages/where-to-find-cloud-city) | 8801 Roosevelt Way NE, Seattle | 6 stamps for a brewed coffee; starts full |
| [5 Stones Coffee Co](https://5stonescoffeeco.com/pages/kirkland) | 312 Central Way, Kirkland | 10 stamps for a latte; starts at 2 |
| [Saint Bread](https://www.saintbread.com) | 1421 NE Boat St, Seattle | 8 stamps for a pastry; add from Search |
| [Book Larder](https://booklarder.com) | 4252 Fremont Ave N, Seattle | 6 stamps for 10% off one book; add from Search |
| [Gloom Coffee](https://gloom.coffee) | 240 2nd Ave S, Seattle | 8 stamps for an espresso; add from Search |

These are original prototype card treatments, not the businesses' branding.
Customer samples use preset artwork, not bundled merchant logos or photographs.
The separate business sample includes the Norema logo.

## Flow

Fresh installs open a card-led landing with **Customer** and **Business** destinations.
Customer opens the loyalty app. Business opens the business side (below); the app
reopens whichever side was chosen last. Only entering Customer completes customer setup.
Existing welcome completion is preserved. **You > Customer or business** replays setup
from either side without changing saved data.
Choosing Customer opens Home and clears its previous navigation and collection
filter. Closing replay returns to You without changing navigation.

**Home** opens with one artwork-led stack: up to three visible cards, readable
peeking headers, and a total count. **Expand** shows up to six full-width artwork
cards per page; **Collapse** restores three per page. Search finds
any saved place by name or neighborhood, including cards outside that preview.
The collection menu offers **All places**, **Favorites**, **All groups**, and
each named group. Choosing a group makes its name the Home title and shows only
its members, with a direct edit shortcut.
The menu previews up to six named groups; **Find a group** searches the rest
in a paged chooser, keeping management actions within reach.
Groups are searchable by name and use exactly the same stack component,
expansion controls, artwork, and individual-place navigation as Home.
Home and groups have no alternate gallery presentation. Large accessibility text
sizes separate cards without overlap, using thumbnails instead of tall covers.
Group collections and other large collections use bounded pages, not endless expansion.
Touch and hold a card, then drop it onto another card to rearrange it. Home and
each group save independent orders; Favorites follows Home. Drop onto an existing
page arrow to move between pages. VoiceOver offers move earlier/later/front/back
actions. Ordering is disabled while selecting cards, and only completed drops
save changes. New cards append after an existing custom arrangement.
Each business has one reward and a fixed
target between 3 and 12 stamps, matching the merchant model's `requiredPunches`
and `rewardDescription`.

Open Monorail and tap **Add demo stamp** three times. A full card stays full
until **Claim reward** is confirmed. Claiming saves a coupon in **Redeemed**
and starts the next card at zero before applying any queued stamps.
Cancel leaves the full card untouched.
**Add demo stamp** is unavailable while full. Incoming updates can still be
queued; they never automatically reset a completed card or issue a coupon.

Reward stacking is automatic. Unused tickets accumulate across completed cards
and never block another claim. Each ticket remains independently usable.

**Card options > Queue demo stamp** exercises the receiving path even when a card is full.
Incoming updates apply immediately when there is room; otherwise they remain
queued without resetting the card or issuing rewards. Claiming applies as many
queued stamps as fit on the next card. Further overflow waits for the next claim.
Cards moved to Memories pause processing until returned to Home. Queue state survives relaunch;
updates are deduplicated against both pending updates and saved event IDs.
Retries for the same card return `false`; IDs belonging to another card or a
non-stamp event, and nonfinite timestamps, are rejected without changing state.
This is local processing, not a live merchant subscription or offline network outbox.

**Redeemed** filters Available and Used rewards into one stack per place.
Drag business stacks to arrange them; Available and Used share this saved order,
independent of Home. Individual tickets stay together in their business stack
and retain their historical order. Memories and discovery keep their existing order.
Available and Used retain notched ticket stock, merchant marks, and subtle depth.
Opening a stack browses one fully punched card inside its ticket, with previous/next
controls and a position indicator. Three historical sample coupons are included.
Marking a coupon used is a local demo action, happens once, and does not change
current stamps. Saving a card to Memories never consumes an available reward.

**Home's collection title > Memories** and **Redeemed > Memories** open the same
collection. Claimed cards appear automatically with their recorded full punch
count. **Move to Memories** saves an unfinished card's exact punches and pauses
that membership. **Return to Home** resumes the latest paused card; the saved
snapshot remains unchanged. Repeated visits can leave several individual cards
in the same place's stack. Search and three-place pages bound the overview;
individual stacks show one card at a time. There are no earned/enjoyed totals.
Legacy paused cards gain one snapshot with no invented save date. Historical
rewards lacking original targets disclose that limitation rather than invent holes.
Merchant styling follows current branding; images and themes are not frozen.

**Search** opens with **Discoverable**, a swipeable preview gallery of
Saint Bread, Book Larder, and Gloom Coffee. These are fixed pilot selections,
not personalized recommendations. Artwork uses original bakery,
bookshop, and coffee symbols on flat merchant-paper backgrounds unless a merchant
supplies a cover photo. Large previews peek into the next card and snap into place;
brief perspective and image movement follow the swipe. There is no idle motion,
faux-3D artwork shading, grain, or layout switch. Reduce Motion and merchant motion
preferences disable the effects. Accessibility text uses full-width previews with
wrapping captions and smaller artwork. Each collection page contains up to six places.
Opening a place does not join it; **Add card** adds a zero-stamp card to Home.
The three existing cards, balances, and coupons are unchanged.
Typing switches to business-name or exact assigned client GUID matches across
all six places, not neighborhoods or categories. Results use the same gallery;
clearing restores Discoverable.
Try Monorail's demo ID:
`6A2E3D81-7B49-4F12-A0C3-819D62E00101`.
**Place details** contains the address, official website, and client ID.
**Activity** starts collapsed; expand it for recent events and the full history.

Home opens directly onto the cards, without a repeated add-business shortcut.
Discoverable remains in the Search tab. Home's collection title (**Your places**,
**Favorites**, **All groups**, or a group name) also switches collections and contains **Manage groups**
and **Memories**; there is no separate utility row or repeated stack title.
The header search button reveals and focuses search only when requested. Closing
search clears the query and restores the collection. Group-name search remains
available in All groups; within a named group, search finds its places.

Cards have no per-card Organize labels or menus. A collection-level checkmark
control enters compact selection mode. Select cards, then use the shared Favorite,
Groups, or Move to Memories icon actions. Visible checkmarks, accessible labels,
and press feedback preserve control without relying on hidden gestures.
Press feedback respects Reduce Motion and merchant motion preferences.
Groups can contain multiple places, and a place can belong to several groups. Edit names
and membership in **Manage groups**, or select cards and use the Groups action
(also available in detail options). Group management and assignment have inset
group-name search and bounded pages. Assignment offers All/Added scopes;
checkmark rows save immediately, and Done closes. Adding several cards preserves
other members; a checked row means every selected card belongs to that group.
A minus means some belong, and Added includes partially assigned groups.
Group editors use one searchable checklist of joined places. Checked members
and unchecked places stay in the same list when toggled; searching never clears hidden selections.
Save commits the draft; Cancel discards it. New groups opened from a card start
with those cards selected. Empty and no-match states remain actionable.
Moving a card to Memories retains favorites and group membership.
Open a group to rename it, change places, or delete it with confirmation;
there is no duplicate per-row options menu.
Deleting a group does not remove cards, punches, favorites, or coupons.

**You** contains appearance, eight accents, local notification preferences, and
setup replay. Notifications are not connected. Data/export/reset controls and
prototype sections are no longer part of this screen. No profile form or sign-in
is required. One short demo disclosure lives here rather than repeating on cards,
tickets, and discovery.
**Apple Wallet**, customer codes, NFC, authentication, and purchase verification
are not implemented. Placeholder Wallet and Show card actions are not displayed;
there are no fake passes or scannable codes.

## Business side

Business owners set up their business, design the card customers collect, and see how often
customers return. It uses the same design system, `MerchantTheme`, and card views as the
customer app, so the card designer previews exactly what customers see.

- **Welcome**: set up a business, or explore **Norema Cafe** sample data (fictional activity).
- **Overview**: lifetime cardholders, plus stamps, rewards earned, and rewards redeemed for
  Today / 7 / 30 / 90 days / All. Shows the live card as a Home collection tile and
  **rewards to redeem**: rewards on full cards not yet redeemed, including customers with
  stacked rewards. The business sample uses automatic rollover; the customer app
  retains explicit claim and queued stamps. These separate local models must be
  reconciled against an agreed service contract before live integration.
- **Card**: stamps for a reward (3–12, `Place.punchRange`), the reward, and the card's
  `MerchantTheme`: contrast-checked light/dark color pairs, typeface, card stock
  (Clipped `rail`, Rounded `cloud`, Square `stone`), cover photo, and motion. The preview uses
  `PlaceGalleryTile`-style tiles and `PunchCard` with an unpublished theme.
  Publishing creates an immutable **version**. Cards with stamps keep their version's rules and
  look until complete; cards with no stamps, new customers, and next cards use the live version.
  The publish confirmation shows how many cards keep their rules and how many switch.
  **Version history** marks each version Live, Finishing, or Retired.
- **Business**: name, logo, location from Apple Maps suggestions, and client ID.
- **You**: shared appearance and accent, **Customer or business**, sample data controls, and
  **Report a bug**. The ladybug on each page also opens a pre-filled GitHub issue in this
  repository with the app version, device, iOS version, and current screen.

Business data is JSON in Application Support, separate from customer data. There is no business
sign-in, server, or link between published business cards and customer search yet (planned in
[docs/backend-spec.md](docs/backend-spec.md)); location
search text is sent to Apple Maps. Apple Wallet is unavailable for the same signing reason above.
Switching sides preserves both data sets and remembers the chosen experience across launches.
`-ui-testing -reset-demo` also clears business test data; add `-business-sample` to load Norema.

## Appearance and storage

Native Dynamic Type, light/dark palettes, and accent washes apply throughout.
Merchant themes select contrast-safe paper/ink colors, system typeface families,
original artwork, an optional image, and whether motion is enabled. Detail
shows the cover and a separate punch card; wide layouts place them side by side.
Earned slots cut through the paper instead of showing an emoji or a filled icon.
Cards use fine paper fibers, a lit stock edge, printed numbered targets, and
slightly irregular cut edges. A stamp brings a metal punch tool into its slot
and briefly compresses and tips the card;
Reduce Motion keeps it still. The final target has a double printed ring.
Monorail uses clipped stock corners, Cloud City rounded stock, and 5 Stones
square stock; these follow the existing merchant artwork styles.
Stack expansion uses one brief, interruptible spring; there is no idle, staggered,
or paging animation. It is disabled if Reduce Motion or any card in that stack
opts out. Presses have shallow perspective and spring compression; collecting a stamp
punches its slot with a brief impact haptic. Reduce Motion and merchant motion
opt-out remove perspective, spring scaling, and stamp zoom.
Animation never controls loyalty state.

Cards, queued stamp IDs, coupons, events, favorites, groups, themes, and
preferences stay in UserDefaults. Local photo previews are JPEG files in
Application Support.
This update preserves v2 punches and coupons; older v2 cards default to not
favorited and an empty pending queue. Legacy stacking preferences are ignored,
including saved false values, and omitted on the next save.
Older builds do not understand v3 queues and may overwrite them;
running an older build against v3 saved data is not supported.
The earlier v1 migration replaced the fictional starter set with
fresh program IDs, without assigning old balances to real businesses.
Invalid saved records produce an error rather than being overwritten.

The model retains deletion/reset helpers for testing, but You does not expose
them. Setup replay never calls them. Published image URLs contact their image
host, but no loyalty history is uploaded.
Opening a business website uses its external URL.

## Merchant artwork integration

The merchant app chooses a photo and uploads it directly to the merchant service.
That service publishes an HTTPS cover URL and presentation tokens. Customers
receive those published values, not upload credentials or private image bytes.

`MerchantBrandingStore.applyPublishedBranding(_:)` accepts a JSON-encoded
`PublishedMerchantBranding` containing `merchantID` and `theme`. The prototype
uses `Place.id` as `merchantID`; the production mapping to assigned client GUIDs
is not agreed. Theme fields:

| Field | Value |
|---|---|
| `lightPaper`, `lightInk`, `darkPaper`, `darkInk` | RGB integers, 0 through 16777215; text contrast must be at least 4.5:1 |
| `typeface` | `standard`, `rounded`, `serif`, or `monospaced` |
| `artwork` | `rail`, `cloud`, or `stone`; used when a photo is absent |
| `coverURL` | Optional HTTPS image URL without embedded credentials |
| `allowsMotion` | Boolean; accessibility Reduce Motion always takes precedence |

Use versioned image URLs when replacing artwork. Images load asynchronously,
are limited to 20 MB, downsampled to 1600 pixels, and cached in bounded memory.
Invalid images show an error and retry control on the establishment page.
Theme changes do not change stamps, rewards, groups, or coupons.

**Card options > Preview branding** opens a local photo picker and a published
URL preview. A local photo overrides the published cover until removed. It is
not uploaded. Original sample artwork is used without merchant-provided assets.

There is no configured merchant API, authentication, upload endpoint, or live
branding subscription. The receiving model and image renderer are implemented;
wiring a server response to them requires the real service contract.

## Next steps / integration handoff

| Area | Implemented locally | Still required |
|---|---|---|
| Apple Wallet | Deferred, with no placeholder action | Merchant-issued, signed `.pkpass` files; pass type identifier/certificates and server-side signing; authenticated pass delivery; native `PKPass` validation and `PKAddPassesViewController` presentation; supported-device, cancellation, duplicate-pass, and error handling |
| Wallet lifecycle | No fake passes or signing material | Agree serial numbers and customer/program mapping, pass registration/authentication, refresh/push updates, reward-use invalidation, and revocation behavior. Keep signing keys on the service, never in the app |
| Stamp delivery | `LoyaltyStore.enqueueStamp(to:id:receivedAt:)`, saved queue and event IDs, FIFO application, deduplication, overflow retention, restore/launch recovery | Authenticated merchant transport, stable server-issued update IDs, purchase verification, account ownership, ordering/reconciliation, server acknowledgments and retry policy. This API accepts one stamp per update; do not generate a fresh ID for a delivery retry |
| Reward policy | Implicit stacking; explicit claim/reset; locally one-time coupon use | Reconcile merchant automatic reset with customer explicit claim; establish authoritative stacking eligibility and redemption rules. Local behavior is not a security or merchant-policy enforcement boundary |
| Memories | Independent saved-card snapshots, recorded completed-card terms, and live reward-use state | Server-backed history, account migration, and historical artwork snapshots if required. Current history remains on this device |

No backend URLs, accounts, credentials, signing configuration, or live integrations
are assumed by this version. Apple Wallet remains entirely deferred, including
signed-file import. Before service integration, replace local demo trust with
server authority and test redelivery, concurrent devices, stale updates, network
loss, and reward replay. Unlimited local queues/event history are suitable for
this prototype; production needs retention and reconciliation limits that do not
silently discard earned value.

## Checks

Apple Wallet remains blocked on signed passes. The simulator's public PassKit
API reports that adding passes is supported, but rejects an unsigned demo
package with "Signature is missing". A fictional reward still needs a signed
`.pkpass`; no certificates or signing keys are bundled. Merchant artwork can be
rendered into pass images later, within Apple's native pass layout.

Product > Test runs model and simulator UI checks: full-card persistence,
claim/cancel/reset, duplicate claim rejection, one-time coupon use, migration,
search, Memories/return, model deletion, role setup/replay, settings, large text, Reduce Motion, and
light/dark contrast, Favorites, Groups, branding validation, image loading,
local photo persistence, and photo-picker cancellation. UI tests use isolated defaults.
Version 3 adds queue replay/overflow/paused-card recovery and migration checks,
implicit stacking and legacy-preference compatibility, shared-stack expansion/navigation, searchable group
assignment, hidden-selection preservation, editor cancellation and relaunch,
exact memory snapshots, completed/used-card browsing, bounded pagination,
gallery columns, and accessibility-size collection bounds.
The app catalog remains six places. A bounded 256-place model fixture checks
collection search; a 64-group isolated UI fixture checks finding a late group
without scrolling and preserving selection. These are not production-scale
performance or engagement benchmarks.

```sh
xcodebuild test -project JOEYY.xcodeproj -scheme JOEYY \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2'
```

GitHub Actions (`.github/workflows/ios.yml`) runs on every push to `main` and every pull
request: it fails if `JOEYY.xcodeproj` differs from `xcodegen generate`, then builds and runs
unit tests and UI tests on an iPhone simulator. Results
are uploaded as an artifact. Keep `main` green; open a pull request for changes.

`-skip-welcome -reset-demo` supports repeatable walkthroughs.
`-ui-testing` isolates defaults; `-reset-demo` then clears only test state.
`-many-groups` creates the 64-group fixture only when both of those flags are set.
`-many-rewards` similarly creates 12 additional completed Cloud City cards to
exercise repeated-card browsing and independent reward use.
Automated checks do not replace a VoiceOver or physical-device review.
