# JOEYY design

Shared customer-app reference. The implementation lives in `Design.swift`,
`MerchantBranding.swift`, and `MerchantViews.swift`.

## Color and type

| Token | Light | Dark | Purpose |
|---|---|---|---|
| Paper | `#F5F5F1` | `#131515` | App canvas |
| Surface | `#FFFFFF` | `#1C1F1E` | Controls and grouped content |
| Muted | `#585B55` | `#B8BDB8` | Secondary text |
| Rule | `#D8DBD3` | `#3A403B` | Fine separators |

Eight customer accents are Orange, Yellow, Purple, Green, Clay, Moss, Ink,
and Plum. `AppAccent` owns light/dark ink, solid-button text, and surface washes;
reuse those tokens rather than deriving arbitrary accent opacity for text.
Primary actions use the solid accent and its paired foreground.

Merchant presentation is separate from the customer's app accent. Every theme
supplies paired light/dark paper and ink, a standard/rounded/serif/monospaced
system typeface, rail/cloud/stone artwork, an optional HTTPS photo, and motion
permission. Published theme validation requires at least 4.5:1 text contrast.
Never use merchant colors to change loyalty state.

Use semantic system typography and Dynamic Type. Page headings are medium
weight with tight tracking; section headings use the app accent. Merchant names
and rewards adopt the merchant typeface. Avoid fixed text heights or truncating
reward terms. Touch targets are at least 44 points.

## Components

| Component | Treatment and behavior |
|---|---|
| `PlaceStack` | Shared Home/group stack. Three preview cards or six expanded cards per page. Counts and paging expose omitted cards; only empty bottom padding overlaps. Home omits the duplicate stack title |
| `StackPlaceTile` | Merchant-paper caption, original preset/photo, fine border, 14-point corners. Preview headers retain business/progress; the front and expanded cards show large artwork. Accessibility sizes use separated thumbnail cards |
| `DiscoveryGallery` | Large swipeable previews with next-card peeking and view-aligned snapping; full-width accessibility cards; up to six places per page |
| `CollectionSearchField` | Shared clearable search input; Search dismisses the keyboard. Home/place selection match names and neighborhoods; discovery retains business-name/exact-GUID lookup |
| `MerchantCover` | Local preview, then published image, otherwise original preset artwork. Loading/error states retain artwork; detail offers retry for failures |
| `PunchCard` | Textured stock with style-specific corners, numbered targets and a double-ring final target. Earned holes cut through paper; no emoji stamps |
| `CardHistoryCollection` | One layered stack per place, search, three-place pages, and a count badge |
| `CardHistoryStack` | One historical card at a time with previous/next controls; reward use remains independent |
| Reward tickets | Notched `TicketShape` stock, merchant marks, fine edges, and subtle depth in Available/Used covers and detail; full historical punches remain visible |
| Memories | Saved unfinished snapshots plus automatic completed cards. Exact historical punches, minimal status/date, no reward statistics. Styling uses current branding |
| `SelectionRow` / `CollectionPager` | Shared checkmark selection and bounded navigation; selection persists independently of visible rows |
| Buttons | Solid accent primary, paired secondary, or text action; preserve error and confirmation states |

Original rail/cloud/stone treatments are always available offline when no custom
photo exists. Discovery uses flat bakery, bookshop, and coffee symbols without
faux-3D shading or grain. Reuse `MerchantCover` in new card/reward/memory surfaces rather than adding
bundled merchant logos or network-dependent placeholder images.

## Navigation and state

Home's collection title is its only heading and collection switcher. Manage groups
and Memories live inside that menu, not in separate utility rows. The header
search button reveals and focuses search on demand; closing it clears the query
and restores the collection. No search field is present on initial entry.
Home has one stack, not Wallet and Gallery modes. Expand spreads the preview
into up to six complete cards per page; collapse returns to three per page. Every visible card opens its
location without requiring expansion. Home search includes saved cards outside
the preview. All places, Favorites, All groups, and named groups are content filters, not layouts.
Choosing a named group makes its name the Home title and renders only its members.
Its edit shortcut opens that group's draft directly.
The menu previews six groups and keeps management actions first. Larger sets
use the existing searchable, paged group list as a chooser.
Groups reuse the exact same `PlaceStack`, including its expansion, card geometry,
motion, navigation, and accessibility behavior. All groups and management retain
group-name search and bounded pages. Empty named groups offer an edit shortcut.
Moving to Memories pauses memberships without deleting assignments or usable rewards.
Touch-and-hold dragging reorders existing cards without handles or an extra mode.
Home and each group persist independent display orders; Favorites follows Home.
Available and Used share a separate business-stack order, keeping repeated tickets
together without changing their chronology. Existing page arrows accept drops
across pages; VoiceOver offers earlier/later/front/back actions. Drops commit
immediately, not on hover, so cancellation leaves order unchanged. Selection mode
disables dragging. Newly added cards append to a custom arrangement; hidden and
paused cards retain their place. Discovery and Memories are not reordered.

Search starts with a gallery of fixed discoverable places. Opening a card
does not join it; Add card does. Typing searches business names or exact client
GUIDs, not neighborhoods. Matching places use the same gallery.
The curated gallery uses large swipeable previews, next-card peeking, and
view-aligned snapping, not a uniform grid. Perspective and image movement follow
the swipe rather than running continuously. At accessibility sizes, previews
use smaller artwork and wrapping captions on merchant paper. System Reduce Motion
and merchant motion opt-out disable movement. No gallery/grid switch or alternate
layout preference remains.

Normal cards have no per-card action tabs, labels, or menus. One collection-level
checkmark control enters compact selection mode. Selected cards expose checkmarks and a
shared Favorite/Groups/Move to Memories action bar. Icons have explicit accessible
names and 44-point targets; controls never require a hidden gesture. Favoriting a
mixed selection favorites all; removing favorites requires all selected cards to
be favorites. Discovery cards remain action-free.
Assignment uses All/Added scopes and checkmark rows, saving immediately.
Partial batch membership uses a minus, remains visible in Added, and becomes
fully assigned on selection without removing unrelated members.
Group management has no redundant row menus. Search sits outside List/Form
clipping boundaries with consistent insets. Editors use a single stable checklist;
names and place selections stay drafts until Save. Search, scopes, and pages never
reset hidden selections. Cancel preserves the original group. Paused memberships remain
visible in editing and retain their assignments.

A full card waits for explicit claim confirmation. Cancel preserves the card.
Claim saves one ticket, resets progress, then applies waiting stamps up to the
next card's capacity. Overflow remains queued. Reward stacking is implicit:
unused tickets never block another claim, and there is no preference control.
Queued stamps never issue rewards themselves.

Card details keep the punch card and one primary action prominent. Place details
and Activity start collapsed. Queue demo stamp lives in Card options, not beside
the primary action. You holds the single demo disclosure; cards, tickets, and
discovery do not repeat it.

Redeemed separates Available and Used; historical records without coupons remain
in Memories. Both use a shared place-stack overview and individual card browser.
Available and used cards render their recorded target with every hole punched,
not the current membership balance. A ticket's use requires
confirmation and cannot be repeated. Memories remains accessible from both Home
and Redeemed. Completed cards enter automatically on claim. Manually putting a
card away freezes its punches/target/reward/date in a separate saved record.
Returning the latest paused card to Home never rewrites older snapshots.
Legacy paused records migrate once with unknown save dates. Multiple cards from
one place form one stack, not repeated rows or an unbounded disclosure list.

Appearance, stack expansion, and loyalty changes remain independent. Expansion
is transient; favorites, group assignments, and loyalty values persist. Old
layout preferences are ignored rather than migrated into another mode. Storage errors are
visible; invalid saved records must not be replaced with demo data.

## Motion and accessibility

The punch tool approaches the newest slot, presses, and retracts. Hole expansion
and card compression are presentation only: animation never commits a stamp.
Card presses use shallow perspective. Stack expansion uses a single interruptible
spring (0.32-second response, 0.88 damping), not staged card delays or idle movement.
Collapsing keeps the card order stable. Any merchant motion opt-out disables
the whole stack transition, avoiding movement of an opted-out card.
Respect both system Reduce Motion and merchant motion opt-out. Suppress punch
tool movement, perspective, and spring scaling when either opts out.

At accessibility text sizes, show up to six matches per page as separated thumbnail cards with
wrapping labels and normal vertical scrolling. Do not retain overlap or an
ineffective expand control. A decorative punch tool and artwork are
hidden from VoiceOver; card labels announce the business and progress. Native
disclosures, pickers, toggles, confirmations, and error alerts remain accessible.

## Design rationale and evidence limits

These are adopted principles, not replicas of other apps or claims that the
stack has been validated by those companies:

| Source | Principle used here |
|---|---|
| [Spotify Your Library](https://support.spotify.com/us/article/your-library/) and [library redesign](https://newsroom.spotify.com/2021-04-29/listeners-can-explore-their-spotify-collections-faster-and-easier-with-a-new-your-library-2/) | Search within a saved collection and filter content without repeatedly browsing the full catalog. Spotify's optional grid is deliberately not adopted |
| [Pinterest Gestalt ComboBox](https://gestalt.pinterest.systems/v1/web/combobox) | Filterable selection with explicit selected/no-result states. This web example does not establish Pinterest's current iOS board picker |
| [My Netflix](https://about.netflix.com/en/news/introducing-my-netflix-a-one-stop-shop-for-series-and-movies-you-want-to) | Direct access to personally relevant saved/history content; it is not evidence for a particular stack gesture |
| [Partiful](https://partiful.com) | Expressive visual identity around a short, focused interaction; not a verified collection-stack specification |
| [Depop's App Store listing](https://apps.apple.com/us/app/depop-buy-sell-clothes/id518684914) | Photo-led identity, favorites, and concise actions without sacrificing readable labels |
| [Apple HIG Motion](https://developer.apple.com/design/human-interface-guidelines/motion) | Brief, purposeful, optional motion that does not block interaction |

arXiv distributes research; it does not approve UI designs.
[Salako et al., 2025](https://arxiv.org/abs/2507.16563) report a preliminary
seven-participant qualitative visualization study: simple transitions favored
swiftness while more elaborate transitions helped traceability.
[Gemini2](https://arxiv.org/abs/2108.04385) studies staged transitions between
statistical graphics. Both are different tasks from mobile loyalty collections.
They inform a restrained continuity hypothesis, not proof of engagement or a
reason to add animation everywhere.

Acceptance checks cover stack consistency, location navigation, searchable
assignment, hidden selections, cancellation, persistence, large text, motion
preferences, and existing loyalty flows. Screenshots can establish rendered
geometry, not delight or improved engagement. A representative user task study
would still need to compare finding/assigning a saved place, completion time,
errors, and comfort before making a usability-improvement claim. No analytics
collection or experiment is enabled by this implementation.

## Integration boundary

Apple Wallet is not a styled substitute for a native pass. Omit placeholder
Wallet and Show card actions until their integrations exist. Customer
codes, verified purchases, live stamp delivery, and authentication are also not
implemented. See the README handoff before connecting a service.
