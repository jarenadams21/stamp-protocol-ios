import XCTest
@testable import JOEYY

@MainActor
final class TapStoreTests: XCTestCase {
    func testCredentialsAndConfigurationValidation() throws {
        XCTAssertTrue(TapStore.validCredentials(username: "test.cafe_1-2", password: "twelve-chars!"))
        for username in ["ab", "contains space", "café", String(repeating: "a", count: 41), "abc\n"] {
            XCTAssertFalse(TapStore.validCredentials(username: username, password: "twelve-chars!"))
        }
        XCTAssertFalse(TapStore.validCredentials(username: "customer", password: "short"))
        XCTAssertFalse(TapStore.validCredentials(username: "customer", password: String(repeating: "a", count: 129)))
        for value in ["https://example.invalid", "http://cafe.test", "https://user:pass@cafe.test", "https://cafe.test?q=x"] {
            XCTAssertThrowsError(try HTTPTapAPI.validateBaseURL(URL(string: value)))
        }
        XCTAssertEqual(try HTTPTapAPI.validateBaseURL(URL(string: "https://cafe.test")).host, "cafe.test")
    }

    func testAmbiguousTapRetriesIdenticalURLAndIDIncludingAfterRelaunch() async throws {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        let store = TapStore(api: api, storage: storage)
        api.tapFailures = 1
        let first = await store.submit(url: "https://cafe.test/t?picc=secret&cmac=secret")
        XCTAssertNil(first)
        let pending = try XCTUnwrap(store.pending)
        XCTAssertEqual(storage.value?.pending, pending)
        XCTAssertEqual(api.requests, [pending])
        XCTAssertTrue(store.cards.isEmpty)

        let restored = TapStore(api: api, storage: storage)
        let result = await restored.retry()
        XCTAssertEqual(result, api.card)
        XCTAssertEqual(api.requests, [pending, pending])
        XCTAssertNil(restored.pending)
        XCTAssertNil(storage.value?.pending)
        XCTAssertEqual(restored.cards, [api.card])
        XCTAssertEqual(restored.cards.first?.place.id, "live-\(api.card.cafeId)")
    }

    func testPendingTapPreventsFreshScanAndDoesNotMutateBalancesLocally() async {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        let store = TapStore(api: api, storage: storage)
        api.tapFailures = 1
        _ = await store.submit(url: "https://cafe.test/t?counter=1")
        _ = await store.submit(url: "https://cafe.test/t?counter=2")
        XCTAssertEqual(api.requests.count, 1)
        XCTAssertEqual(store.pending?.url, "https://cafe.test/t?counter=1")
        XCTAssertTrue(store.cards.isEmpty)
    }

    func testFailedCardLoadIsNotAnEmptyConfirmedCollection() async {
        let api = MockTapAPI()
        api.cardLoadFailure = true
        let store = TapStore(api: api, storage: MemoryTapStorage())
        XCTAssertEqual(store.cardLoadState, .notLoaded)
        await store.refresh()
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertEqual(store.cardLoadState, .failed)
        XCTAssertNotNil(store.message)

        api.cardLoadFailure = false
        api.existingCards = []
        await store.refresh()
        XCTAssertEqual(store.cardLoadState, .loaded)
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertNil(store.message)
    }

    func testFailedRefreshPreservesConfirmedCardsAndPendingTap() async throws {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        let store = TapStore(api: api, storage: storage)
        await store.refresh()
        api.tapFailures = 1
        _ = await store.submit(url: "https://cafe.test/t?counter=1")
        let pending = try XCTUnwrap(store.pending)
        api.cardLoadFailure = true
        await store.refresh()
        XCTAssertEqual(store.cardLoadState, .failed)
        XCTAssertEqual(store.cards, [api.card])
        XCTAssertEqual(store.pending, pending)
        XCTAssertEqual(storage.value?.pending, pending)
    }

    func testSignInCanSucceedWhileInitialCardLoadFails() async {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        storage.value = nil
        api.cardLoadFailure = true
        let store = TapStore(api: api, storage: storage)
        await store.authenticate(username: "customer", password: "twelve-chars!", create: false)
        XCTAssertTrue(store.isSignedIn)
        XCTAssertEqual(store.cardLoadState, .failed)
        XCTAssertNotNil(store.message)
    }

    func testCannotSendTapIfDurableReservationFails() async {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        storage.failSave = true
        let store = TapStore(api: api, storage: storage)
        _ = await store.submit(url: "https://cafe.test/t")
        XCTAssertTrue(api.requests.isEmpty)
        XCTAssertNil(store.pending)
    }

    func testFailedCleanupAfterAcceptedTapRetainsOriginalRequest() async throws {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        let store = TapStore(api: api, storage: storage)
        api.tapFailures = 1
        _ = await store.submit(url: "https://cafe.test/t")
        let pending = try XCTUnwrap(store.pending)
        storage.failSave = true
        _ = await store.retry()
        XCTAssertEqual(store.cards, [api.card])
        XCTAssertEqual(store.pending, pending)
        storage.failSave = false
        _ = await store.retry()
        XCTAssertEqual(api.requests, [pending, pending, pending])
        XCTAssertNil(store.pending)
        XCTAssertEqual(store.cards.first?.stamps, api.card.stamps)
    }

    func testUnsupportedSimulatorScanFailsClearly() async {
        #if targetEnvironment(simulator)
        do {
            _ = try await NFCTagScanner().scan()
            XCTFail("Simulator must not claim to scan an NFC tag.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("physical iPhone"))
        }
        #endif
    }

    func testInvalidWalletPassNeverClaimsSuccess() {
        let wallet = TapWallet()
        wallet.accept(Data("not a signed pass".utf8), onlyIfInstalled: false)
        XCTAssertNil(wallet.presentation)
        XCTAssertNotNil(wallet.message)
        XCTAssertFalse(wallet.message?.contains("was updated") == true)
        XCTAssertFalse(wallet.message?.contains("Pass added") == true)
    }

    func testAuthoritativeDuplicateSnapshotReplacesCardWithoutIncrement() async {
        let api = MockTapAPI()
        let store = TapStore(api: api, storage: MemoryTapStorage())
        await store.refresh()
        api.card = LiveCard(id: api.card.id, cafeId: api.card.cafeId, cafeName: "Actual Cafe",
                            stamps: 4, target: 8, rewardsAvailable: 1, updatedAt: "2026-11-12T23:00:00.123Z")
        _ = await store.submit(url: "https://cafe.test/t")
        XCTAssertEqual(store.cards, [api.card])
        _ = await store.submit(url: "https://cafe.test/t")
        XCTAssertEqual(store.cards.count, 1)
        XCTAssertEqual(store.cards.first?.stamps, 4)
    }

    func testExpiredSessionRetainsPendingTapThroughSameAccountLogin() async {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        let store = TapStore(api: api, storage: storage)
        api.unauthorized = true
        _ = await store.submit(url: "https://cafe.test/t")
        let pending = store.pending
        XCTAssertTrue(store.needsSignIn)
        XCTAssertFalse(store.isSignedIn)
        api.unauthorized = false
        await store.authenticate(username: "customer", password: "twelve-chars!", create: false)
        XCTAssertEqual(store.pending, pending)
        XCTAssertTrue(store.isSignedIn)
        _ = await store.retry()
        XCTAssertEqual(api.requests.first, api.requests.last)
    }

    func testLogoutClearsSecureSessionEvenIfServerUnavailable() async {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        let store = TapStore(api: api, storage: storage)
        await store.refresh()
        api.logoutFailure = true
        await store.logout()
        XCTAssertNil(storage.value)
        XCTAssertNil(store.session)
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertEqual(store.cardLoadState, .notLoaded)
        XCTAssertFalse(store.isSignedIn)
        XCTAssertTrue(store.message?.contains("could not confirm") == true)
    }

    func testNewAccountStartsEmptyAndRejectsUnsupportedTagURL() async {
        let api = MockTapAPI()
        api.existingCards = []
        let storage = MemoryTapStorage()
        storage.value = nil
        let store = TapStore(api: api, storage: storage)
        await store.authenticate(username: "customer", password: "twelve-chars!", create: true)
        XCTAssertTrue(store.isSignedIn)
        XCTAssertTrue(store.cards.isEmpty)
        _ = await store.submit(url: "http://cafe.test/t")
        XCTAssertNil(store.pending)
        XCTAssertTrue(api.requests.isEmpty)
    }

    func testCardDecodesFractionalOrNonFractionalTimestampAsString() throws {
        let json = """
        {"id":"A0000000-0000-4000-8000-000000000001","cafeId":"A0000000-0000-4000-8000-000000000002",
         "cafeName":"Real Cafe","stamps":3,"target":8,"rewardsAvailable":0,"updatedAt":"2026-11-12T22:00:00.123Z"}
        """
        let card = try JSONDecoder().decode(LiveCard.self, from: Data(json.utf8))
        XCTAssertEqual(card.updatedAt, "2026-11-12T22:00:00.123Z")
        XCTAssertFalse(Place.catalog.contains(where: { $0.id == card.place.id }))
    }

    func testPrototypeStartsWithoutCustomerCredentialsAndUsesSeparateSecureStorage() async {
        let api = MockTapAPI()
        api.existingCards = []
        let storage = MemoryTapStorage()
        storage.value = nil
        let store = TapStore(api: api, storage: storage, mode: .prototype)
        await store.startPrototype()
        XCTAssertTrue(store.isSignedIn)
        XCTAssertTrue(store.session?.isPrototype == true)
        XCTAssertEqual(api.prototypeTokens, [nil])
        XCTAssertEqual(api.credentialRequests, 0)
        XCTAssertEqual(store.cards, [])
        XCTAssertNotEqual(KeychainTapSessionStorage().account, KeychainTapSessionStorage(mode: .prototype).account)
    }

    func testPrototypeResumePreservesSavedReadAndOnlyUsesVerifiedServerBalance() async throws {
        let api = MockTapAPI()
        api.verification = TapVerification(verified: true, counter: 14)
        let storage = MemoryTapStorage()
        storage.value = nil
        let store = TapStore(api: api, storage: storage, mode: .prototype)
        await store.startPrototype()
        api.tapFailures = 1
        _ = await store.submit(url: "https://cafe.test/t?encrypted=fixture")
        let pending = try XCTUnwrap(store.pending)
        let token = try XCTUnwrap(store.session?.token)

        let restored = TapStore(api: api, storage: storage, mode: .prototype)
        await restored.startPrototype()
        XCTAssertEqual(api.prototypeTokens, [nil, token])
        XCTAssertEqual(restored.pending, pending)
        let retried = await restored.retry()
        XCTAssertEqual(retried, api.card)
        XCTAssertEqual(api.requests, [pending, pending])
        XCTAssertNil(restored.pending)
        XCTAssertEqual(restored.lastVerification, api.verification)
        XCTAssertEqual(api.credentialRequests, 0)
        XCTAssertEqual(api.passRequests, 0)
    }

    func testPrototypeRejectsMissingCryptoConfirmationWithoutClearingRead() async {
        let api = MockTapAPI()
        api.existingCards = []
        let storage = MemoryTapStorage()
        storage.value = nil
        let store = TapStore(api: api, storage: storage, mode: .prototype)
        await store.startPrototype()
        let result = await store.submit(url: "https://cafe.test/t?encrypted=fixture")
        XCTAssertNil(result)
        XCTAssertNotNil(store.pending)
        XCTAssertNil(store.lastVerification)
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertTrue(store.message?.contains("did not confirm chip verification") == true)
    }

    func testPrototypeNeverSilentlyReplacesSavedIdentityOrPendingRequest() async throws {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        storage.value = TapSession(token: "original-prototype", username: "nfc-original",
                                   pending: TapRequest(url: "https://cafe.test/t", requestId: UUID()), prototype: true)
        let saved = storage.value
        let store = TapStore(api: api, storage: storage, mode: .prototype)
        api.prototypeResponse = TapSession(token: "different", username: "nfc-other", prototype: true)
        await store.startPrototype()
        XCTAssertEqual(store.session, saved)
        XCTAssertEqual(storage.value, saved)
        XCTAssertTrue(store.message?.contains("different test card") == true)
    }

    func testExpiredPrototypeResumesWithoutAskingForCustomerPassword() async {
        let api = MockTapAPI()
        api.verification = TapVerification(verified: true, counter: 15)
        let storage = MemoryTapStorage()
        storage.value = TapSession(token: "prototype-existing", username: "nfc-fixture", prototype: true)
        let store = TapStore(api: api, storage: storage, mode: .prototype)
        api.unauthorized = true
        _ = await store.submit(url: "https://cafe.test/t")
        let pending = store.pending
        XCTAssertTrue(store.needsSignIn)
        XCTAssertTrue(store.message?.contains("Resume the prototype") == true)
        api.unauthorized = false
        await store.refresh()
        XCTAssertTrue(store.isSignedIn)
        XCTAssertEqual(store.pending, pending)
        let card = await store.retry()
        XCTAssertEqual(card, api.card)
        XCTAssertEqual(api.credentialRequests, 0)
    }

    func testLegacyAccountSessionStillDecodesWithoutPrototypeFlag() throws {
        let data = Data(#"{"token":"legacy","username":"customer"}"#.utf8)
        XCTAssertFalse(try JSONDecoder().decode(TapSession.self, from: data).isPrototype)
    }

    func testPrototypeRetriesSecureRestoreBeforeItCanCreateAnotherIdentity() async {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        storage.value = TapSession(token: "saved-prototype", username: "nfc-fixture",
                                   pending: TapRequest(url: "https://cafe.test/t", requestId: UUID()), prototype: true)
        let original = storage.value
        storage.loadFailures = 2
        let store = TapStore(api: api, storage: storage, mode: .prototype)
        await store.startPrototype()
        XCTAssertTrue(api.prototypeTokens.isEmpty)
        XCTAssertEqual(storage.value, original)
        await store.startPrototype()
        XCTAssertEqual(api.prototypeTokens, ["saved-prototype"])
        XCTAssertEqual(store.pending, original?.pending)
        XCTAssertEqual(storage.value?.token, original?.token)
    }

    func testPrototypeForegroundRefreshReusesItsSessionInsteadOfHittingTheStartRateLimit() async {
        let api = MockTapAPI()
        let storage = MemoryTapStorage()
        storage.value = nil
        let store = TapStore(api: api, storage: storage, mode: .prototype)
        await store.startPrototype()
        for _ in 0..<15 { await store.refresh() }
        XCTAssertEqual(api.prototypeTokens, [nil])
        XCTAssertEqual(api.credentialRequests, 0)
        XCTAssertTrue(store.isSignedIn)
        XCTAssertEqual(store.cards, [api.card])
    }
}

@MainActor
private final class MemoryTapStorage: TapSessionStorage {
    var value: TapSession? = TapSession(token: "test-only", username: "customer")
    var failSave = false
    var loadFailures = 0
    func load() throws -> TapSession? {
        if loadFailures > 0 {
            loadFailures -= 1
            throw TapError.message("Storage unavailable")
        }
        return value
    }
    func save(_ session: TapSession?) throws {
        if failSave { throw TapError.message("Storage unavailable") }
        value = session
    }
}

@MainActor
private final class MockTapAPI: TapAPI {
    var card = LiveCard(id: UUID(), cafeId: UUID(), cafeName: "Actual Cafe", stamps: 2,
                        target: 8, rewardsAvailable: 0, updatedAt: "2026-11-12T22:00:00Z")
    var existingCards: [LiveCard]?
    var requests: [TapRequest] = []
    var tapFailures = 0
    var unauthorized = false
    var logoutFailure = false
    var cardLoadFailure = false
    var prototypeTokens: [String?] = []
    var prototypeResponse: TapSession?
    var verification: TapVerification?
    var credentialRequests = 0
    var passRequests = 0

    func startPrototypeSession(token: String?) async throws -> TapSession {
        prototypeTokens.append(token)
        return prototypeResponse ?? TapSession(token: token ?? "prototype-created", username: "nfc-fixture", prototype: true)
    }
    func authenticate(username: String, password: String, create: Bool) async throws -> TapSession {
        credentialRequests += 1
        return TapSession(token: "test-refreshed", username: username)
    }
    func cards(token: String) async throws -> [LiveCard] {
        if unauthorized { throw TapError.unauthorized }
        if cardLoadFailure { throw TapError.message("Loyalty service unavailable.") }
        return existingCards ?? [card]
    }
    func tap(_ request: TapRequest, token: String) async throws -> TapResponse {
        requests.append(request)
        if unauthorized { throw TapError.unauthorized }
        if tapFailures > 0 {
            tapFailures -= 1
            throw TapError.message("Service temporarily unavailable.")
        }
        return TapResponse(eventId: UUID(), card: card, duplicate: requests.count > 1, verification: verification)
    }
    func pass(cardID: UUID, token: String) async throws -> Data {
        passRequests += 1
        return Data()
    }
    func logout(token: String) async throws {
        if logoutFailure { throw TapError.message("Service unavailable.") }
    }
}
