import XCTest
@testable import JOEYY

/// Stands in for the backend's sign-in routes.
private actor FakeAuthAPI: AuthAPI {
    private(set) var signIns: [(AccountRole, SignInProof)] = []
    private(set) var refreshes: [String] = []
    private(set) var signOuts: [String] = []
    var refreshError: AuthError?
    private var issued = 0

    func setRefreshError(_ error: AuthError?) { refreshError = error }

    private func tokens(_ prefix: String) -> TokenResponse {
        issued += 1
        return TokenResponse(accessToken: "\(prefix)-access-\(issued)", expiresIn: 900, refreshToken: "\(prefix)-refresh-\(issued)")
    }

    func signIn(role: AccountRole, proof: SignInProof) async throws -> TokenResponse {
        signIns.append((role, proof))
        return tokens(role.rawValue)
    }

    private(set) var codesSent: [(CodeChannel, String)] = []

    func availableMethods() async throws -> [SignInMethod] { [.google, .email] }

    func sendCode(_ channel: CodeChannel, to target: String) async throws -> CodeSent {
        codesSent.append((channel, target))
        return CodeSent(expiresIn: 600, resendAfter: 30)
    }

    func refresh(_ refreshToken: String) async throws -> TokenResponse {
        refreshes.append(refreshToken)
        if let refreshError { throw refreshError }
        // Slow enough that overlapping callers would each refresh if the store didn't share one.
        try await Task.sleep(for: .milliseconds(50))
        return tokens(String(refreshToken.split(separator: "-")[0]))
    }

    func signOut(_ refreshToken: String) async {
        signOuts.append(refreshToken)
    }
}

@MainActor
final class AccountStoreTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_790_000_000)

    private func makeStore(api: FakeAuthAPI, store: MemorySecureStore = MemorySecureStore()) -> AccountStore {
        AccountStore(api: api, store: store, now: { [unowned self] in clock })
    }

    func testSignInKeepsEachSideSeparate() async throws {
        let api = FakeAuthAPI()
        let accounts = makeStore(api: api)
        XCTAssertNil(accounts.account(for: .customer))

        try await accounts.signIn(.customer, with: .apple(identityToken: "apple-token", nonce: "nonce"))
        XCTAssertEqual(accounts.account(for: .customer)?.method, .apple)
        XCTAssertNil(accounts.account(for: .partner), "Signing in as a customer doesn't sign in the business side")

        try await accounts.signIn(.partner, with: .code(.phone, target: "+12065550101", code: "123456"))
        let customerToken = try await accounts.accessToken(for: .customer)
        let partnerToken = try await accounts.accessToken(for: .partner)
        XCTAssertTrue(customerToken.hasPrefix("customer-"))
        XCTAssertTrue(partnerToken.hasPrefix("partner-"))
        let refreshes = await api.refreshes
        XCTAssertTrue(refreshes.isEmpty, "A fresh access token is used without refreshing")
    }

    func testSessionSurvivesRelaunchAndRefreshesOnce() async throws {
        let api = FakeAuthAPI()
        let keychain = MemorySecureStore()
        try await makeStore(api: api, store: keychain).signIn(.customer, with: .google(idToken: "id", nonce: "n"))

        // After a relaunch only the refresh token is known, so the first request refreshes.
        let relaunched = makeStore(api: api, store: keychain)
        XCTAssertEqual(relaunched.account(for: .customer)?.method, .google)
        async let first = relaunched.accessToken(for: .customer)
        async let second = relaunched.accessToken(for: .customer)
        let tokens = try await [first, second]
        XCTAssertEqual(tokens[0], tokens[1])
        let refreshes = await api.refreshes
        XCTAssertEqual(refreshes, ["customer-refresh-1"], "Overlapping requests share one refresh")
        XCTAssertNotEqual(relaunched.account(for: .customer)?.refreshToken, "customer-refresh-1", "The rotated token is saved")
    }

    func testRefreshesWhenTheAccessTokenIsAboutToExpire() async throws {
        let api = FakeAuthAPI()
        let accounts = makeStore(api: api)
        try await accounts.signIn(.partner, with: .apple(identityToken: "t", nonce: "n"))
        clock = clock.addingTimeInterval(850)
        let token = try await accounts.accessToken(for: .partner)
        XCTAssertEqual(token, "partner-access-2")
    }

    func testRevokedSessionSignsOutThatSideOnly() async throws {
        let api = FakeAuthAPI()
        let keychain = MemorySecureStore()
        let accounts = makeStore(api: api, store: keychain)
        try await accounts.signIn(.customer, with: .apple(identityToken: "t", nonce: "n"))
        try await accounts.signIn(.partner, with: .apple(identityToken: "t", nonce: "n"))
        clock = clock.addingTimeInterval(3600)
        await api.setRefreshError(.signedOut)

        do {
            _ = try await accounts.accessToken(for: .customer)
            XCTFail("Expected the customer side to be signed out")
        } catch {
            XCTAssertEqual(error as? AuthError, .signedOut)
        }
        XCTAssertNil(accounts.account(for: .customer))
        XCTAssertNil(keychain.read(AccountRole.customer.rawValue))
        XCTAssertNotNil(accounts.account(for: .partner))
    }

    func testNetworkErrorKeepsTheSession() async throws {
        let api = FakeAuthAPI()
        let accounts = makeStore(api: api)
        try await accounts.signIn(.customer, with: .apple(identityToken: "t", nonce: "n"))
        clock = clock.addingTimeInterval(3600)
        await api.setRefreshError(.network)
        do {
            _ = try await accounts.accessToken(for: .customer)
            XCTFail("Expected a network error")
        } catch {
            XCTAssertEqual(error as? AuthError, .network)
        }
        XCTAssertNotNil(accounts.account(for: .customer))
    }

    func testSignOutClearsTheDeviceAndEndsTheServerSession() async throws {
        let api = FakeAuthAPI()
        let keychain = MemorySecureStore()
        let accounts = makeStore(api: api, store: keychain)
        try await accounts.signIn(.customer, with: .apple(identityToken: "t", nonce: "n"))
        await accounts.signOut(.customer)
        XCTAssertNil(accounts.account(for: .customer))
        XCTAssertNil(keychain.read(AccountRole.customer.rawValue))
        let signOuts = await api.signOuts
        XCTAssertEqual(signOuts, ["customer-refresh-1"])
        do {
            _ = try await accounts.accessToken(for: .customer)
            XCTFail("Expected no session")
        } catch {
            XCTAssertEqual(error as? AuthError, .signedOut)
        }
    }

    func testEmailCodeSignInIsItsOwnMethod() async throws {
        let api = FakeAuthAPI()
        let accounts = makeStore(api: api)
        let methods = try await accounts.availableMethods()
        XCTAssertEqual(methods, [.google, .email])
        _ = try await accounts.sendCode(.email, to: "pat@example.com")
        let sent = await api.codesSent
        XCTAssertEqual(sent.map { $0.0 }, [.email])
        XCTAssertEqual(sent.map { $0.1 }, ["pat@example.com"])
        try await accounts.signIn(.customer, with: .code(.email, target: "pat@example.com", code: "123456"))
        XCTAssertEqual(accounts.account(for: .customer)?.method, .email)
        XCTAssertNil(accounts.account(for: .partner))
    }

    func testEmailFormatting() {
        XCTAssertEqual(EmailFormat.normalized("  Pat.Owner@Example.COM "), "pat.owner@example.com")
        XCTAssertNil(EmailFormat.normalized("pat"))
        XCTAssertNil(EmailFormat.normalized("pat@example"))
        XCTAssertNil(EmailFormat.normalized("pat smith@example.com"))
        XCTAssertNil(EmailFormat.normalized("@example.com"))
    }

    func testPhoneNumberFormatting() {
        XCTAssertEqual(PhoneNumberFormat.e164("(206) 555-0101"), "+12065550101")
        XCTAssertEqual(PhoneNumberFormat.e164("1 206 555 0101"), "+12065550101")
        XCTAssertEqual(PhoneNumberFormat.e164("+44 7700 900123"), "+447700900123")
        XCTAssertNil(PhoneNumberFormat.e164("555-0101"))
        XCTAssertNil(PhoneNumberFormat.e164("+0 123 456 789"))
    }

    func testSignInCrypto() {
        // RFC 7636-style S256 challenge, checked against Node's crypto.
        XCTAssertEqual(
            SignInCrypto.codeChallenge(for: "dBjftJeZ4CVP-mA9o1lI7Nz5SyAi0Rps2gh1rOT6Dr0"),
            "dXFnLMOZnAvhfGNN4hEU5gE26h_UxRrgr2x9CQOMg6o"
        )
        XCTAssertEqual(SignInCrypto.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let nonce = SignInCrypto.randomString()
        XCTAssertEqual(nonce.count, 43)
        XCTAssertNotEqual(nonce, SignInCrypto.randomString())
    }

    func testGoogleRedirectUsesTheReversedClientID() throws {
        let google = GoogleOAuth(clientID: "123-abc.apps.googleusercontent.com")
        XCTAssertEqual(google.callbackScheme, "com.googleusercontent.apps.123-abc")
        let url = google.authorizationURL(codeChallenge: "challenge", state: "state", nonce: "nonce")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "redirect_uri" }?.value, "com.googleusercontent.apps.123-abc:/oauth2redirect")
        XCTAssertEqual(items.first { $0.name == "code_challenge_method" }?.value, "S256")
        XCTAssertEqual(items.first { $0.name == "nonce" }?.value, "nonce")
        XCTAssertEqual(items.first { $0.name == "scope" }?.value, "openid email")

        let callback = URL(string: "com.googleusercontent.apps.123-abc:/oauth2redirect?state=state&code=auth-code")!
        XCTAssertEqual(try google.code(from: callback, state: "state"), "auth-code")
        XCTAssertThrowsError(try google.code(from: callback, state: "other"))

        let configured = try XCTUnwrap(AppConfiguration.googleIOSClientID)
        XCTAssertEqual(
            GoogleOAuth(clientID: configured).redirectURI,
            "com.googleusercontent.apps.461007702405-0fe1j629n2a79j3n0ss2mkoso67l9gqq:/oauth2redirect"
        )
    }

    func testAPIAddressPrefersOverrideThenBuildSettingThenLocalhost() {
        let hosted = "https://api.example.com"
        XCTAssertEqual(AppConfiguration.resolveAPIBaseURL(override: "http://192.168.1.20:8080", built: hosted).absoluteString, "http://192.168.1.20:8080")
        XCTAssertEqual(AppConfiguration.resolveAPIBaseURL(override: nil, built: hosted).absoluteString, hosted)
        XCTAssertEqual(AppConfiguration.resolveAPIBaseURL(override: "  ", built: " \(hosted) ").absoluteString, hosted)
        XCTAssertEqual(AppConfiguration.resolveAPIBaseURL(override: "not a url", built: hosted).absoluteString, hosted)
        // An unset build setting leaves an empty value in Info.plist.
        XCTAssertEqual(AppConfiguration.resolveAPIBaseURL(override: nil, built: "").absoluteString, "http://localhost:8080")
        XCTAssertEqual(AppConfiguration.resolveAPIBaseURL(override: "ftp://example.com", built: nil).absoluteString, "http://localhost:8080")
        // Unit tests run a Debug build, which points at localhost.
        XCTAssertEqual(AppConfiguration.builtInAPIBaseURL.absoluteString, "http://localhost:8080")
    }
}
