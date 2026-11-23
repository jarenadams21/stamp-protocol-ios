import Foundation
import Observation
import Security

/// The two sides of the app. Each signs in separately, and a token for one side never works on the other.
enum AccountRole: String, CaseIterable, Codable, Sendable {
    case customer, partner
}

/// Sign-in methods, in the order the Sign in screen shows them. There are no passwords.
enum SignInMethod: String, CaseIterable, Codable, Sendable {
    case google, apple, email, phone

    var label: String {
        switch self {
        case .apple: "Apple"
        case .google: "Google"
        case .email: "email"
        case .phone: "phone number"
        }
    }
}

/// Where a one-time code is sent.
enum CodeChannel: String, Sendable {
    case email, phone

    var method: SignInMethod {
        switch self {
        case .email: .email
        case .phone: .phone
        }
    }
}

/// Proof from a sign-in method, sent once to the backend in exchange for JOEYY tokens.
enum SignInProof: Sendable, Equatable {
    case apple(identityToken: String, nonce: String)
    case google(idToken: String, nonce: String)
    case code(CodeChannel, target: String, code: String)

    var method: SignInMethod {
        switch self {
        case .apple: .apple
        case .google: .google
        case .code(let channel, _, _): channel.method
        }
    }
}

struct TokenResponse: Decodable, Sendable, Equatable {
    let accessToken: String
    let expiresIn: Int
    let refreshToken: String
}

struct CodeSent: Decodable, Sendable, Equatable {
    let expiresIn: Int
    let resendAfter: Int
}

enum AuthError: LocalizedError, Equatable {
    /// The backend refused the request; `code` matches the backend's error codes.
    case server(code: String, message: String)
    /// The session ended on the server (signed out elsewhere, expired, or revoked).
    case signedOut
    case network
    case notConfigured(String)

    var errorDescription: String? {
        switch self {
        case .server(_, let message): message
        case .signedOut: "You were signed out. Sign in again."
        case .network: "Couldn't reach JOEYY. Check your connection and try again."
        case .notConfigured(let message): message
        }
    }
}

/// The backend's sign-in routes (docs/backend-spec.md section 8.5).
protocol AuthAPI: Sendable {
    /// The methods the backend has switched on.
    func availableMethods() async throws -> [SignInMethod]
    func signIn(role: AccountRole, proof: SignInProof) async throws -> TokenResponse
    func sendCode(_ channel: CodeChannel, to target: String) async throws -> CodeSent
    func refresh(_ refreshToken: String) async throws -> TokenResponse
    func signOut(_ refreshToken: String) async
}

enum AppConfiguration {
    /// The user default that overrides the API address, set with the launch argument
    /// `-apiBaseURL <url>` or the hidden "API server" field (long-press the App setup footer on You).
    static let apiBaseURLKey = "apiBaseURL"
    static let fallbackAPIBaseURL = URL(string: "http://localhost:8080")!

    /// Where the apps reach the backend: the `apiBaseURL` user default, else the address the build
    /// was made with (the `JOEYY_API_BASE_URL` build setting), else localhost.
    static var apiBaseURL: URL {
        resolveAPIBaseURL(override: UserDefaults.standard.string(forKey: apiBaseURLKey), built: builtInAPIBaseURLString)
    }

    /// The address this build was made with, ignoring any override.
    static var builtInAPIBaseURL: URL { resolveAPIBaseURL(override: nil, built: builtInAPIBaseURLString) }

    private static var builtInAPIBaseURLString: String? {
        Bundle.main.object(forInfoDictionaryKey: "JOEYY_API_BASE_URL") as? String
    }

    static func resolveAPIBaseURL(override: String?, built: String?) -> URL {
        serverURL(override) ?? serverURL(built) ?? fallbackAPIBaseURL
    }

    /// An http or https address with a host, or nil (also for an unset build setting).
    static func serverURL(_ value: String?) -> URL? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
              let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host(), !host.isEmpty
        else { return nil }
        return url
    }

    /// The Google OAuth iOS client "JOEYY iOS" (project joeyy-515223, bundle com.joeyy.customer). Not a secret.
    /// Google redirects to its reversed form, which ASWebAuthenticationSession catches itself, so no
    /// URL type is registered in Info.plist.
    static let googleIOSClientID: String? = "461007702405-0fe1j629n2a79j3n0ss2mkoso67l9gqq.apps.googleusercontent.com"
}

struct HTTPAuthAPI: AuthAPI {
    let baseURL: URL
    var session: URLSession = .shared

    func availableMethods() async throws -> [SignInMethod] {
        struct Methods: Decodable { let methods: [String] }
        let response: Methods = try await send("GET", "v1/auth/methods", body: nil)
        return SignInMethod.allCases.filter { response.methods.contains($0.rawValue) }
    }

    func signIn(role: AccountRole, proof: SignInProof) async throws -> TokenResponse {
        switch proof {
        case .apple(let identityToken, let nonce):
            return try await post("v1/auth/apple", ["role": role.rawValue, "identityToken": identityToken, "nonce": nonce])
        case .google(let idToken, let nonce):
            return try await post("v1/auth/google", ["role": role.rawValue, "idToken": idToken, "nonce": nonce])
        case .code(.email, let email, let code):
            return try await post("v1/auth/email/verify", ["role": role.rawValue, "email": email, "code": code])
        case .code(.phone, let number, let code):
            return try await post("v1/auth/phone/verify", ["role": role.rawValue, "phoneNumber": number, "code": code])
        }
    }

    func sendCode(_ channel: CodeChannel, to target: String) async throws -> CodeSent {
        switch channel {
        case .email: return try await post("v1/auth/email/start", ["email": target])
        case .phone: return try await post("v1/auth/phone/start", ["phoneNumber": target])
        }
    }

    func refresh(_ refreshToken: String) async throws -> TokenResponse {
        do {
            return try await post("v1/auth/refresh", ["refreshToken": refreshToken])
        } catch AuthError.server(let code, _) where code == "unauthorized" {
            throw AuthError.signedOut
        }
    }

    func signOut(_ refreshToken: String) async {
        _ = try? await post("v1/auth/sign-out", ["refreshToken": refreshToken]) as Empty
    }

    private struct Empty: Decodable {}
    private struct ErrorBody: Decodable {
        let error: String
        let message: String
    }

    private func post<Response: Decodable>(_ path: String, _ body: [String: String]) async throws -> Response {
        try await send("POST", path, body: body)
    }

    private func send<Response: Decodable>(_ method: String, _ path: String, body: [String: String]?) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        request.timeoutInterval = 20
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AuthError.network
        }
        guard let http = response as? HTTPURLResponse else { throw AuthError.network }
        guard (200..<300).contains(http.statusCode) else {
            if let error = try? JSONDecoder().decode(ErrorBody.self, from: data) {
                throw AuthError.server(code: error.error, message: error.message)
            }
            throw AuthError.server(code: "http\(http.statusCode)", message: "Something went wrong. Try again.")
        }
        if http.statusCode == 204, let empty = Empty() as? Response { return empty }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

/// UI tests: no network. Google and email are on, codes are "sent", and every code is wrong, so
/// tests can walk the screens without a server.
struct UITestAuthAPI: AuthAPI {
    func availableMethods() async throws -> [SignInMethod] { [.google, .email] }
    func signIn(role: AccountRole, proof: SignInProof) async throws -> TokenResponse {
        throw AuthError.server(code: "invalidCode", message: "That code is wrong or has expired. Ask for a new one.")
    }
    func sendCode(_ channel: CodeChannel, to target: String) async throws -> CodeSent {
        CodeSent(expiresIn: 600, resendAfter: 30)
    }
    func refresh(_ refreshToken: String) async throws -> TokenResponse { throw AuthError.signedOut }
    func signOut(_ refreshToken: String) async {}
}
// MARK: Storage

/// Where refresh tokens are kept between launches.
@MainActor
protocol SecureStore: AnyObject {
    func read(_ key: String) -> Data?
    func write(_ data: Data?, for key: String) throws
}

/// The Keychain, readable only on this device after its first unlock, and never backed up.
@MainActor
final class KeychainStore: SecureStore {
    private let service: String

    init(service: String = "com.joeyy.auth") {
        self.service = service
    }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    func read(_ key: String) -> Data? {
        var item: CFTypeRef?
        var search = query(key)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    func write(_ data: Data?, for key: String) throws {
        SecItemDelete(query(key) as CFDictionary)
        guard let data else { return }
        var item = query(key)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}

/// UI tests and unit tests: nothing survives the process.
@MainActor
final class MemorySecureStore: SecureStore {
    private var items: [String: Data] = [:]

    func read(_ key: String) -> Data? { items[key] }
    func write(_ data: Data?, for key: String) throws { items[key] = data }
}

// MARK: Accounts

/// A side's saved sign-in. Only the refresh token is stored; access tokens stay in memory.
struct StoredAccount: Codable, Equatable, Sendable {
    let method: SignInMethod
    let refreshToken: String
    let signedInAt: Date
}

/// Signed-in state for both sides of the app. Screens still use on-device data; the remote data
/// sources (spec section 11) will ask this store for access tokens.
@MainActor
@Observable
final class AccountStore {
    private(set) var accounts: [AccountRole: StoredAccount] = [:]
    @ObservationIgnored private let api: any AuthAPI
    @ObservationIgnored private let store: any SecureStore
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var accessTokens: [AccountRole: (token: String, expiresAt: Date)] = [:]
    /// One refresh at a time per side: the backend revokes a session when a used refresh token comes back.
    @ObservationIgnored private var refreshes: [AccountRole: Task<String, any Error>] = [:]

    init(api: any AuthAPI, store: any SecureStore, now: @escaping () -> Date = { .now }) {
        self.api = api
        self.store = store
        self.now = now
        for role in AccountRole.allCases {
            if let data = store.read(role.rawValue), let account = try? JSONDecoder().decode(StoredAccount.self, from: data) {
                accounts[role] = account
            }
        }
    }

    func account(for role: AccountRole) -> StoredAccount? { accounts[role] }

    func availableMethods() async throws -> [SignInMethod] {
        try await api.availableMethods()
    }

    func sendCode(_ channel: CodeChannel, to target: String) async throws -> CodeSent {
        try await api.sendCode(channel, to: target)
    }

    /// Exchanges a provider's proof for JOEYY tokens and saves the session for this side only.
    func signIn(_ role: AccountRole, with proof: SignInProof) async throws {
        let tokens = try await api.signIn(role: role, proof: proof)
        try save(role, tokens: tokens, method: proof.method)
    }

    /// A valid access token for this side, refreshed when it has less than a minute left.
    func accessToken(for role: AccountRole) async throws -> String {
        if let cached = accessTokens[role], cached.expiresAt.timeIntervalSince(now()) > 60 { return cached.token }
        if let pending = refreshes[role] { return try await pending.value }
        guard let account = accounts[role] else { throw AuthError.signedOut }
        let task = Task<String, any Error> {
            defer { refreshes[role] = nil }
            do {
                let tokens = try await api.refresh(account.refreshToken)
                try save(role, tokens: tokens, method: account.method)
                return tokens.accessToken
            } catch AuthError.signedOut {
                clear(role)
                throw AuthError.signedOut
            }
        }
        refreshes[role] = task
        return try await task.value
    }

    /// Signs this side out on the device right away, then tells the backend to end the session.
    func signOut(_ role: AccountRole) async {
        guard let account = accounts[role] else { return }
        clear(role)
        await api.signOut(account.refreshToken)
    }

    private func save(_ role: AccountRole, tokens: TokenResponse, method: SignInMethod) throws {
        let account = StoredAccount(method: method, refreshToken: tokens.refreshToken, signedInAt: accounts[role]?.signedInAt ?? now())
        try store.write(try JSONEncoder().encode(account), for: role.rawValue)
        accounts[role] = account
        accessTokens[role] = (tokens.accessToken, now().addingTimeInterval(TimeInterval(tokens.expiresIn)))
    }

    private func clear(_ role: AccountRole) {
        try? store.write(nil, for: role.rawValue)
        accounts[role] = nil
        accessTokens[role] = nil
        refreshes[role]?.cancel()
        refreshes[role] = nil
    }
}

/// Trims and lowercases an email address, as the backend does, or returns nil when it can't be one.
enum EmailFormat {
    static func normalized(_ input: String) -> String? {
        let email = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard email.count <= 254, parts.count == 2, !parts[0].isEmpty, parts[0].count <= 64,
              parts[1].contains("."), !parts[1].hasPrefix("."), !parts[1].hasSuffix("."),
              !email.contains(where: \.isWhitespace)
        else { return nil }
        return email
    }
}

/// Turns what someone typed into E.164. Ten digits are read as a US or Canadian number.
enum PhoneNumberFormat {
    static func e164(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = trimmed.filter(\.isASCII).filter(\.isNumber)
        let number: String
        if trimmed.hasPrefix("+") {
            number = "+" + digits
        } else if digits.count == 10 {
            number = "+1" + digits
        } else if digits.count == 11, digits.hasPrefix("1") {
            number = "+" + digits
        } else {
            return nil
        }
        guard (9...16).contains(number.count), number.dropFirst().first != "0" else { return nil }
        return number
    }
}
