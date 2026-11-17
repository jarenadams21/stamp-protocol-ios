import Foundation
import Observation

@MainActor @Observable
final class TapStore {
    enum CardLoadState: Equatable {
        case notLoaded, loading, loaded, failed
    }

    private(set) var session: TapSession?
    private(set) var cards: [LiveCard] = []
    private(set) var cardLoadState = CardLoadState.notLoaded
    private(set) var isBusy = false
    private(set) var needsSignIn = false
    private(set) var lastVerification: TapVerification?
    let mode: TapMode
    var message: String?
    private(set) var walletMessage: String?
    private let api: any TapAPI
    private let storage: any TapSessionStorage
    private var needsSessionReload = false

    var isSignedIn: Bool { session != nil && !needsSignIn }
    var pending: TapRequest? { session?.pending }

    init(api: any TapAPI = HTTPTapAPI(), storage: (any TapSessionStorage)? = nil, mode: TapMode = .account) {
        self.mode = mode
        self.api = api
        self.storage = storage ?? KeychainTapSessionStorage(mode: mode)
        do { session = try self.storage.load() }
        catch {
            needsSessionReload = true
            message = "Could not restore your secure session. Unlock your device and try again."
        }
    }

    static func validCredentials(username: String, password: String) -> Bool {
        username.range(of: "\\A[A-Za-z0-9._-]{3,40}\\z", options: .regularExpression) != nil &&
        password.count >= 12 && password.utf16.count <= 128
    }

    func authenticate(username: String, password: String, create: Bool) async {
        guard !isBusy else { return }
        guard mode == .account else {
            message = "No customer sign-in is needed in the NFC prototype."
            return
        }
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
            if await loadCards(token: authenticated.token) {
                message = cards.isEmpty ? "Ready. Your first verified cafe scan creates your card." : "Your cards are up to date."
            }
        } catch { report(error) }
    }

    func startPrototype() async {
        guard mode == .prototype, !isBusy else { return }
        isBusy = true
        message = nil
        defer { isBusy = false }
        do {
            if needsSessionReload {
                session = try storage.load()
                needsSessionReload = false
            }
            if let session, !session.isPrototype {
                throw TapError.message("The saved session is not an anonymous test card. It has been kept unchanged.")
            }
            var connected = try await api.startPrototypeSession(token: session?.token)
            guard connected.isPrototype else {
                throw TapError.message("The server did not start an anonymous prototype session. Ask the test organizer to enable prototype mode.")
            }
            if let previous = session {
                guard previous.token == connected.token, previous.username == connected.username else {
                    throw TapError.message("The server returned a different test card. Your saved session and pending tap have been kept.")
                }
                connected.pending = previous.pending
            }
            try storage.save(connected)
            session = connected
            needsSignIn = false
            if await loadCards(token: connected.token) {
                message = "Ready to scan. No customer account is needed."
            }
        } catch { report(error) }
    }

    func refresh() async {
        if mode == .prototype, session != nil, needsSignIn {
            await startPrototype()
            return
        }
        guard let session, isSignedIn, !isBusy else { return }
        isBusy = true
        message = nil
        defer { isBusy = false }
        _ = await loadCards(token: session.token)
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
        walletMessage = nil
        defer { isBusy = false }
        do {
            let result = try await api.tap(pending, token: session.token)
            if mode == .prototype {
                guard let verification = result.verification, verification.verified,
                      (0...0xFFFFFF).contains(verification.counter) else {
                    throw TapError.message("The server did not confirm chip verification. Your tap stays saved for retry.")
                }
                lastVerification = verification
            }
            if let index = cards.firstIndex(where: { $0.id == result.card.id }) {
                cards[index] = result.card
            } else {
                cards.append(result.card)
            }
            var updated = session
            updated.pending = nil
            try storage.save(updated)
            self.session = updated
            if mode == .prototype {
                message = result.duplicate
                    ? "This verified tap was already recorded. No extra stamp was added."
                    : "Chip verified by the backend. Your test card is updated."
            } else {
                message = result.duplicate ? "This tap was already recorded. Your balance is confirmed." : "Verified visit. Your card is updated."
            }
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
        walletMessage = nil
        defer { isBusy = false }
        do { return try await api.pass(cardID: card.id, token: session.token) }
        catch {
            if case TapError.unauthorized = error {
                needsSignIn = true
                walletMessage = mode == .prototype
                    ? "Your confirmed stamps are kept. Resume the prototype, then choose Add / Update Apple Wallet."
                    : "Your confirmed stamps are kept. Sign in again, then choose Add / Update Apple Wallet."
            } else {
                let explanation = (error as? TapError)?.errorDescription ?? "The pass could not be downloaded."
                walletMessage = "Your confirmed stamps are kept, but Wallet could not update. \(explanation)"
            }
            return nil
        }
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
            cardLoadState = .notLoaded
            lastVerification = nil
            walletMessage = nil
            needsSignIn = false
            if mode == .prototype {
                message = revoked ? "Prototype session ended." : "Prototype session removed on this device. The service could not confirm revocation."
            } else {
                message = revoked ? "Signed out." : "Signed out on this device. The service could not confirm session revocation."
            }
        } catch { report(error) }
    }

    private func loadCards(token: String) async -> Bool {
        cardLoadState = .loading
        do {
            cards = try await api.cards(token: token)
            cardLoadState = .loaded
            return true
        } catch {
            cardLoadState = .failed
            report(error)
            return false
        }
    }

    private func report(_ error: Error) {
        if case TapError.unauthorized = error {
            needsSignIn = true
            if mode == .prototype {
                message = "Resume the prototype to reconnect your test card. Any pending tap stays saved."
                return
            }
        }
        message = (error as? TapError)?.errorDescription ?? "The loyalty service returned an unreadable response. Retry your pending tap or refresh."
    }
}
