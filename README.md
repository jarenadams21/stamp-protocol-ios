# JOEYY

A native SwiftUI customer-loyalty prototype for iOS 18 and later.

## Run

Open `JOEYY.xcodeproj`, select the **JOEYY** scheme and an iPhone simulator,
then Run. No packages, credentials, signing team, or backend are needed for
the simulator. For a physical device, select your own signing team in Xcode.

The project is generated from `project.yml` using XcodeGen. The generated
project is included; XcodeGen is only needed if you change the target setup.

## Walkthrough

- **Home** shows three compact rows: Dick's Drive-In has 5 stamps, Cozy Cafe
  has 6, and Jango Smoothies has 2. There is no fixed card target.
- Open a card and scroll to **Add demo stamp**.
- At Cozy Cafe, use 5 stamps for a regular coffee or keep collecting for a
  10-stamp sandwich. Confirmation deducts only the chosen cost; unused stamps
  remain. Redemption opens a coupon and saves it in **Redeemed**.
- **Redeemed** groups available and used coupons across businesses. Its tab badge
  counts available coupons. Three examples come from Dick's Drive-In, Cozy Cafe,
  and Jango Smoothies. Open a coupon to view it, open the Wallet placeholder,
  or mark it used locally. Using it does not deduct more stamps.
- **Apple Wallet** and **Show card** directly state that Wallet and customer
  codes are not implemented. Neither presents a fake pass or scannable code.
- **Search** accepts a business name or exact assigned client GUID. It starts
  empty, without categories, neighborhood search, or an unverified directory.
  Common Ground and The Neat are additional sample programs that can be joined.
- **Program details** on each card contains its client ID and a copy action.
  Try Cozy Cafe's fictional ID: `29BFF0A1-7EB3-4E8A-A02D-8FA39CC00102`.
  Archived cards can be restored using the archive button on Home.
- **You** starts with light/dark/system appearance and eight accents, including
  orange, yellow, purple, and green. It also has preview communication
  preferences, data controls, and a demo reset. There is no profile or display-name form.

## Visual system

The interface uses the system sans-serif family throughout, with consistent
weights and tabular balances. The selected accent applies to page and
navigation titles, section labels, merchant names, stamps, card surfaces,
controls, and a radial background fade. Text and filled controls use separate contrast-safe
color tokens; yellow and orange controls use dark lettering.

Cards retain their identity through names, locations, and icons rather than
unrelated color palettes. Dick's Drive-In uses a custom vector burger icon in
Home, balances, and search results. Copy describes actions,
rewards, and state without promotional taglines.

All establishments use sample Seattle locations. All loyalty programs, offers,
and transactions are fictional and are not affiliated with named businesses.
There is no authentication, NFC integration, purchase verification, actual
redemption, live Wallet integration, location access, analytics, or networking.
Showing the placeholder customer code does not collect a stamp.

Cards, coupons, activity, and preferences persist locally using UserDefaults. Existing
balances and legacy activity are retained; old redemption events do not
invent reward details that were never recorded. Those records appear under
**Earlier redemptions**, not as newly usable coupons.
The first launch after this update adds three historical demo coupons to existing
sample memberships once, without changing balances or archive state. Deletion
does not recreate them on relaunch; resetting the demo restores the examples.
The demo
export writes a JSON file in the app's temporary directory and only shares it
when the user chooses the system share action. Deleting cards also removes that
temporary export; preferences remain. No server account exists.

## Checks

Run Product > Test in Xcode for model and UI walkthrough tests.
Checks include persistence, partial redemption, saving for larger rewards,
invalid redemption, balance overflow, legacy data, name/GUID search, joining, archiving, deletion,
coupon issuance and one-time use, sample migration, appearance, the largest
accessibility text size, and text contrast. Coupon use is a local demo action;
NFC validation and Apple Wallet coupon passes are not implemented. The screen
audit excludes contrast findings for text underneath the native translucent
tab bar or its scroll-edge dimming overlay; app text palettes are also checked
numerically at 4.5:1.
These checks do not replace a full VoiceOver or device accessibility review.

```sh
xcodebuild test -project JOEYY.xcodeproj -scheme JOEYY \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2'
```

Launch arguments `-skip-welcome -reset-demo` are available for repeatable
walkthroughs. UI tests additionally use `-ui-testing` for isolated cards and
preferences; with `-reset-demo`, only that test suite's local state is cleared.
