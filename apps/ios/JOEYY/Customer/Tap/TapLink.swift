import Foundation
import Observation

/// A chip tap that reaches the app as a link instead of from the in-app scanner.
///
/// How it works: an iPhone XS or newer reads an NFC chip that holds a web address, even with the app closed, and
/// offers to open that address. When the address belongs to a domain this app is associated with, iOS opens this
/// app and hands it the full address, including the chip's one-time encrypted message. Two things tie the app to
/// the domain, and both are needed:
///   1. the app's Associated Domains entitlement (`applinks:<host>`, set from LOYALTY_TAP_LINK_HOST), and
///   2. the `apple-app-site-association` file served by that domain's web server.
/// This file recognises such a link and passes it to the same code that handles an in-app scan, so the stamp is
/// added without the person pressing anything else. See docs/setup/tap-opens-app.md.
enum TapLink {
    /// The paths the backend accepts for a chip read (see `verifyTag` in services/api/support.mjs).
    static let paths: Set<String> = ["/tagtt", "/tag", "/tap"]

    /// The domain the chips point at: LOYALTY_TAP_LINK_HOST in Config/App.xcconfig, copied into Info.plist.
    static func configuredHost(bundle: Bundle = .main) -> String? {
        configuredHost(infoValue: bundle.object(forInfoDictionaryKey: "LoyaltyTapLinkHost"))
    }

    static func configuredHost(infoValue: Any?) -> String? {
        guard let value = infoValue as? String else { return nil }
        let host = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // An unexpanded build setting ("$(LOYALTY_TAP_LINK_HOST)") means the app is not configured for links.
        return host.isEmpty || host.contains("$") ? nil : host
    }

    /// True for an https link on `host` whose path is a chip-read path and that carries the chip's signed message.
    /// A link without the message could never be verified, so it is ignored instead of becoming a stuck pending tap.
    static func isTapLink(_ url: URL, host: String?) -> Bool {
        guard let host,
              url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil,
              url.host?.lowercased() == host,
              url.port == nil || url.port == 443,
              paths.contains(url.path.lowercased()) else { return false }
        let names = Set((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map(\.name))
        // Same rule as the backend: `e`, or `picc_data` together with `cmac`.
        return names.contains("e") || (names.contains("picc_data") && names.contains("cmac"))
    }
}

/// Holds the latest chip link until the Tap screen has used it. The link can arrive before that screen exists
/// (the app was closed when the card was tapped), so it waits here.
@MainActor @Observable
final class TapLinkInbox {
    private(set) var url: URL?
    /// Changes every time a new link is accepted, so views can react to it.
    private(set) var revision = 0
    private let host: String?
    private var lastReceived: String?

    init(host: String? = TapLink.configuredHost()) {
        self.host = host
    }

    /// Accepts a chip link for this app. Returns false for any other link, and for a repeat of the last one:
    /// iOS can deliver the same link through more than one callback.
    @discardableResult
    func receive(_ url: URL) -> Bool {
        guard TapLink.isTapLink(url, host: host), url.absoluteString != lastReceived else { return false }
        lastReceived = url.absoluteString
        self.url = url
        revision += 1
        return true
    }

    /// Hands the waiting link over once.
    func take() -> URL? {
        defer { url = nil }
        return url
    }
}

extension TapStore {
    /// Adds the stamp for a chip link that opened the app, the same way an in-app scan would.
    /// Returns the updated card. Returns nil when the link has to wait (a previous tap is still pending, or the
    /// person must sign in first) or the tap failed; in the waiting cases the link is kept for later.
    func submitIncoming(from inbox: TapLinkInbox) async -> LiveCard? {
        guard inbox.url != nil, !isBusy else { return nil }
        // A prototype phone gets its anonymous test card by itself, so a tapped link needs no extra step.
        if !isSignedIn, mode == .prototype { await startPrototype() }
        guard isSignedIn else {
            if mode != .prototype { message = "Sign in to add this visit. Your tap link is kept until you do." }
            return nil
        }
        guard pending == nil else {
            message = "Finish or discard your last tap first. The new tap link is kept."
            return nil
        }
        guard let url = inbox.take() else { return nil }
        return await submit(url: url.absoluteString)
    }
}
