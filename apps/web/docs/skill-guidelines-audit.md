# Web Interface Guidelines audit

Skill: `web-design-guidelines` (Vercel), rules fetched 2026-11-15 from
`vercel-labs/web-interface-guidelines/main/command.md`. Scope: `src/screens/*.ts`, `src/ui/*.ts`,
`src/styles/*.css` (plus `index.html` for the document-level rules), on base commit 705a152.

Raw findings below, in the skill's `file:line` format, line numbers from the base commit. Each one
ends with what happened to it: **fixed**, or **kept** with the reason. Where a rule clashes with
CLAUDE.md, CLAUDE.md wins (noted as such).

72 findings: 64 fixed, 8 kept on purpose.

## src/styles/base.css

src/styles/base.css:62 - no `touch-action: manipulation` on buttons, links, summaries → **fixed** (global rule)
src/styles/base.css:7 - no rubber-band suppression for fine pointers (`overscroll-behavior: none` on html in `@media (pointer: fine)`) → **fixed**
src/styles/base.css:78 - `h1:focus { outline: none }` → **kept**: the h1 only takes programmatic focus on route change (tabindex -1), it is not a control
src/styles/base.css:103 - `.button` has no hover state, only `:active` → **fixed**
src/styles/base.css:151 - `.link-button` no hover state → **fixed**
src/styles/base.css:166 - `.sheet` scrolls but has no `overscroll-behavior: contain` (page scrolls behind the sheet on iOS) → **fixed**
src/styles/base.css:202 - `.sheet-title` no `text-wrap: balance` → **fixed**
src/styles/base.css:261 - `.field-input:focus { outline: none }` → **kept**: replaced by an accent border and 3px ring, which is the focus treatment the rule asks for

## src/styles/screens.css

src/styles/screens.css:27 - `.topbar-link` no hover state → **fixed**
src/styles/screens.css:74 - `.section-title` no `text-wrap: balance` → **fixed**
src/styles/screens.css:108 - `.footer-links a` no hover state → **fixed**
src/styles/screens.css:262 - `.wallet` animates `height` (not compositor-only) → **kept**: the wallet's height has to follow the opened card so the details below move with it; the cards themselves move by transform
src/styles/screens.css:299 - `.staff-facts dd` figures not `tabular-nums` → **fixed**
src/styles/screens.css:225 - staff band loops forever (>5s autoplay motion) → **kept**: it is the anti-screenshot proof for staff, essential to the screen; it already stops under Reduce Motion and after 2 minutes
src/styles/screens.css:562 - `.biz-directions` no hover state → **fixed**
src/styles/screens.css:521 - `.biz-meta` long addresses can't break → **fixed** (`overflow-wrap: anywhere`)
src/styles/screens.css:693 - `.discover-track` sideways scroller has no `overscroll-behavior-x: contain` (a fling can trigger browser back-swipe) → **fixed**
src/styles/screens.css:717 - `.spot-button` no hover state; focus ring clipped by the scroller → **fixed**
src/styles/screens.css:754 - `.spot-name` long names not handled → **fixed**
src/styles/screens.css:833 - `.account-chip` no hover state → **fixed**
src/styles/screens.css:1121 - `.consent-email` has `text-overflow: ellipsis` but no `white-space: nowrap`, so it never truncates → **fixed**
src/styles/screens.css:1145 - `.signin-go` no hover state → **fixed**
src/styles/screens.css:1227 - `.dock-tile` no hover state; busy state only dims (no "Adding…" feedback) → **fixed**
src/styles/screens.css:1374 - `.visit-strip` sideways scroller has no `overscroll-behavior-x: contain` → **fixed**
src/styles/screens.css:1497 - `.bio-field dd` figures not `tabular-nums` → **fixed**
src/styles/screens.css:1555 - `.entry-name` long names not handled; `.entry-stamp` has press but no hover → **fixed**

## src/styles/card.css

src/styles/card.css:17 - `.peek` is a fixed 54px tall flex row; a long business name wraps and spills out → **fixed** (truncate with `min-width: 0` + ellipsis)
src/styles/card.css:117 - `.passport-count` figures not `tabular-nums` → **fixed**
src/styles/card.css:332 - `.wallet-edit`, `.wallet-back` no hover state → **fixed**
src/styles/card.css:418 - `.card-placeholder` is a blank grey block: loading state gives no sense of what's coming → **fixed** (replaced by a page-shaped skeleton; old CSS removed)
src/styles/card.css:467 - `.ticket-use` focus ring is clipped by the ticket's notch mask; no hover state → **fixed**
src/styles/card.css:559 - `.next-count` figure not `tabular-nums` → **fixed**
src/styles/card.css:741 - `.reorder-button` no hover state → **fixed**

## index.html

✓ pass: `color-scheme: dark`, `theme-color` matches `--paper`, zoom not disabled, fonts preconnected with `display=swap`

## src/ui/components.ts

src/ui/components.ts:52 - toast is a brand-new `role="status"` node each time; live regions inserted with their text already in are often not read → **fixed** (toast also speaks through the page's persistent announcer)
src/ui/components.ts:64 - brand name "Joeyy" not marked `translate="no"` → **fixed** (header, footer, bio page)
src/ui/components.ts:89 - "Use now" repeated per reward with no context for screen readers → **fixed** (`aria-label="Use a free espresso now"`)
src/ui/components.ts:106 - Wallet tile disabled during request with no visible progress → **fixed** ("Adding…" while busy)
src/ui/components.ts:285 - consent button label "Continue" is generic → **fixed** ("Sign in with Apple/Google")
src/ui/components.ts:419 - Sign out disables with no progress → **fixed** ("Signing out…")
src/ui/components.ts:446 - phone placeholder doesn't end with `…` → **kept**: the placeholder is the example number itself; an ellipsis after a phone number reads as part of it
src/ui/components.ts:455 - "We’ll text you" first person → **fixed** ("You’ll get a text with…")
src/ui/components.ts:468 - submit disabled with no spinner or label change → **fixed** ("Sending code…")
src/ui/components.ts:487 - code input missing `spellcheck="false"` / `autocapitalize="off"` → **fixed**
src/ui/components.ts:511 - verify submit disabled with no progress → **fixed** ("Checking…")

## src/screens/shared.ts

src/screens/shared.ts:114 - "See all" link is vague out of context → **fixed** ("See all cards")
src/screens/shared.ts:209 - footer brand not `translate="no"` → **fixed**
src/screens/shared.ts:118 - `<header>` sits inside `<main>`, so there is no banner landmark and no skip link → **kept**: every route moves focus to its h1 on arrival, which does what a skip link does; moving the header out of `<main>` means touching every screen's frame and the layout CSS for no change a diner would notice

## src/screens/cards.ts

src/screens/cards.ts:21 - Your cards shows nothing (or the old page) while cards load → **fixed** (page-shaped loading skeleton after 150ms, `aria-busy` and a spoken "Loading…")
src/screens/cards.ts:31 - empty state is one line of text → **fixed** (a blank passport page where the first stamp will land, plus How JOEYY works)
src/screens/cards.ts:96 - card page has no loading state → **fixed**
src/screens/cards.ts:126 - home intro is a headline and a paragraph, nothing to look at → **fixed** (blank passport page and How JOEYY works)

## src/screens/tap.ts

src/screens/tap.ts:27 - verifying state is a blank block (see card.css:418) → **fixed** (same skeleton as other loads)
src/screens/tap.ts:132 - "We couldn’t read that stand" first person → **fixed** ("Couldn’t read that stand")

## src/screens/redeem.ts

src/screens/redeem.ts:16 - Start disables with no progress → **fixed** ("Starting…")
src/screens/redeem.ts:87 - countdown is `aria-hidden` and only announced once; screen-reader users never hear time running out → **fixed** (`role="timer"`, spoken at 30 and 10 seconds)
src/screens/redeem.ts:122 - renders an empty `<p>` when the reward isn't found → **fixed**
src/screens/redeem.ts:137 - rebuilds the whole SVG ring 4× a second → **fixed** (updates `stroke-dashoffset` only)
src/screens/redeem.ts:144 - "Try again" after time runs out goes to the card, not a retry → **fixed** ("Back to your card")
src/screens/redeem.ts:72 - no loading state while the intent loads → **fixed**

## src/screens/staff.ts

src/screens/staff.ts:13 - hardcoded hex day colours → **kept**: CLAUDE.md-documented exception, they must look the same at every place

## src/screens/profile.ts

src/screens/profile.ts:96 - empty "Places you’ve been" is one line of text → **fixed** (dashed empty stamp slot)
src/screens/profile.ts:117 - no loading state → **fixed**

## src/ui/passport.ts

src/ui/passport.ts:64 - business name not `translate="no"` → **fixed** (passport and peek names)

## src/ui/motion.ts

src/ui/motion.ts:18 - `getBoundingClientRect()` on every pointermove during tilt → **fixed** (measured once per gesture)
src/ui/motion.ts:63 - `getComputedStyle()` per stamp just to read an inline custom property → **fixed** (reads the inline style)
src/ui/motion.ts:93 - interleaves layout reads with class writes in one loop → **fixed** (reads first, then writes)

## src/ui/business.ts

src/ui/business.ts:89 - cover `<img>` has no `width`/`height` → **fixed**
src/ui/business.ts:112 - "Directions" opens a new tab with no warning → **fixed** (accessible name says it opens Maps)

## src/ui/details.ts

src/ui/details.ts:37 - "One more visit" → numerals for counts → **fixed** ("1 more visit")

## src/ui/sections.ts

src/ui/sections.ts:54 - sideways visit strip can't be scrolled by keyboard (not focusable) → **fixed** (`tabindex="0"`, label, focus ring)
src/ui/sections.ts:76 - `.how-summary` no hover state → **fixed**

## src/ui/stamp-style.ts

src/ui/stamp-style.ts:6 - hardcoded month names instead of `Intl.DateTimeFormat` → **kept**: the stamp face ("NOV 11") is shared with the Wallet pass art on the server and must match it exactly

## src/ui/discover.ts, src/ui/vessel.ts, src/ui/theme.ts, src/ui/dom.ts

✓ pass

## Rules not applied

- "Title Case for headings/buttons": CLAUDE.md says sentence case. CLAUDE.md wins.
- Hydration safety, virtualization, `<video>`/GIF rules: not applicable (no SSR, no long lists, no media).
