import Foundation
import Observation

@MainActor @Observable
final class TapStore {
    private(set) var session: TapSession?
    private(set) var cards: [LiveCard] = []
    private(set) var isBusy = false
    private(set) var needsSignIn = false
    var message: String?
    private let api: any TapAPI
    private let storage: any TapSessionStorage

    var isSignedIn: Bool { session != nil && !needsSignIn }
    var pending: TapRequest? { session?.pending }

    init(api: any TapAPI = HTTPTapAPI(), storage: any TapSessionStorage = KeychainTapSessionStorage()) {
        self.api = api
        self.storage = storage
        do { session = try storage.load() }
        catch { message = "Could not restore your secure session. Unlock your device and try again." }
    }

    static func validCredentials(username: String, password: String) -> Bool {
        username.range(of: "\\A[A-Za-z0-9._-]{3,40}\\z", options: .regularExpression) != nil &&
        password.count >= 12 && password.utf16.count <= 128
    }

    func authenticate(username: String, password: String, create: Bool) async {
        guard !isBusy else { return }
        guard Self.validCredentials(username: username, password: password) else {
            message = "Use a 3–40 character username (ASCII letters, digits, dot, underscore or hyphen) and a password of 12–128 characters."
            return
        }
        isBusy = true
        defer { isBusy = false }
        do {
            var authenticated = try await api.authenticate(username: username, password: password, create: create)
            if authenticated.username == session?.username { authenticated.pending = session?.pending }
            try storage.save(authenticated)
            session = authenticated
            needsSignIn = false
            cards = []
            cards = try await api.cards(token: authenticated.token)
            message = cards.isEmpty ? "Ready. Your first verified cafe scan creates your card." : "Your cards are up to date."
        } catch { report(error) }
    }

    func refresh() async {
        guard let session, isSignedIn, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            cards = try await api.cards(token: session.token)
        } catch { report(error) }
    }

    func submit(url: String) async -> LiveCard? {
        guard isSignedIn, !isBusy else { return nil }
        guard pending == nil else {
            message = "Retry or discard the pending tap before scanning again."
            return nil
        }
        guard let parsed = URL(string: url), parsed.scheme?.lowercased() == "https", parsed.host != nil else {
            message = "This tag does not contain a supported HTTPS cafe URL."
            return nil
        }
        do {
            guard var updated = session else { return nil }
            updated.pending = TapRequest(url: url, requestId: UUID())
            // Persist before sending: an ambiguous response must never generate a second request ID.
            try storage.save(updated)
            session = updated
        } catch {
            report(error)
            return nil
        }
        return await retry()
    }

    func retry() async -> LiveCard? {
        guard let session, let pending = session.pending, isSignedIn, !isBusy else { return nil }
        isBusy = true
        defer { isBusy = false }
        do {
            let result = try await api.tap(pending, token: session.token)
            if let index = cards.firstIndex(where: { $0.id == result.card.id }) {
                cards[index] = result.card
            } else {
                cards.append(result.card)
            }
            var updated = session
            updated.pending = nil
            try storage.save(updated)
            self.session = updated
            message = result.duplicate ? "This tap was already recorded. Your balance is confirmed." : "Verified visit. Your card is updated."
            return result.card
        } catch {
            report(error)
            return nil
        }
    }

    func discardPending() {
        guard !isBusy, var session else { return }
        do {
            session.pending = nil
            try storage.save(session)
            self.session = session
            message = "Pending tap discarded. An accepted visit remains on the server; refresh your cards before a fresh scan."
        } catch { report(error) }
    }

    func passData(for card: LiveCard) async -> Data? {
        guard let session, isSignedIn, !isBusy else { return nil }
        isBusy = true
        defer { isBusy = false }
        do { return try await api.pass(cardID: card.id, token: session.token) }
        catch { report(error); return nil }
    }

    func logout() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        var revoked = true
        if let session {
            do { try await api.logout(token: session.token) }
            catch { revoked = false }
        }
        do {
            try storage.save(nil)
            session = nil
            cards = []
            needsSignIn = false
            message = revoked ? "Signed out." : "Signed out on this device. The service could not confirm session revocation."
        } catch { report(error) }
    }

    private func report(_ error: Error) {
        if case TapError.unauthorized = error { needsSignIn = true }
        message = (error as? TapError)?.errorDescription ?? "The loyalty service returned an unreadable response. Retry your pending tap or refresh."
    }
}
