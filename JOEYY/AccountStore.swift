import Foundation
import Observation
import Security

/// The two sides of the app. Each signs in separately, and a token for one side never works on the other.
enum AccountRole: String, CaseIterable, Codable, Sendable {
    case customer, partner
}

enum SignInMethod: String, Codable, Sendable {
    case apple, google, phone

    var label: String {
        switch self {
        case .apple: "Apple"
        case .google: "Google"
        case .phone: "phone number"
        }
    }
}

/// Proof from a sign-in method, sent once to the backend in exchange for JOEYY tokens.
enum SignInProof: Sendable, Equatable {
    case apple(identityToken: String, nonce: String)
    case google(idToken: String, nonce: String)
    case phone(number: String, code: String)

    var method: SignInMethod {
        switch self {
        case .apple: .apple
        case .google: .google
        case .phone: .phone
        }
    }
}

struct TokenResponse: Decodable, Sendable, Equatable {
    let accessToken: String
    let expiresIn: Int
    let refreshToken: String
}

struct PhoneCodeSent: Decodable, Sendable, Equatable {
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
    func signIn(role: AccountRole, proof: SignInProof) async throws -> TokenResponse
    func sendPhoneCode(to number: String) async throws -> PhoneCodeSent
    func refresh(_ refreshToken: String) async throws -> TokenResponse
    func signOut(_ refreshToken: String) async
}

enum AppConfiguration {
    /// Where the apps reach the backend. Override with the `apiBaseURL` user default, for example
    /// to reach a dev server on your Mac from a phone.
    static var apiBaseURL: URL {
        if let value = UserDefaults.standard.string(forKey: "apiBaseURL"), let url = URL(string: value) { return url }
        return URL(string: "http://localhost:8080")!
    }

    /// The Google OAuth iOS client ID. Google sign-in stays off until it's set (backend README, Sign-in).
    static let googleIOSClientID: String? = nil
}

struct HTTPAuthAPI: AuthAPI {
    let baseURL: URL
    var session: URLSession = .shared

    func signIn(role: AccountRole, proof: SignInProof) async throws -> TokenResponse {
        switch proof {
        case .apple(let identityToken, let nonce):
            return try await post("v1/auth/apple", ["role": role.rawValue, "identityToken": identityToken, "nonce": nonce])
        case .google(let idToken, let nonce):
            return try await post("v1/auth/google", ["role": role.rawValue, "idToken": idToken, "nonce": nonce])
        case .phone(let number, let code):
            return try await post("v1/auth/phone/verify", ["role": role.rawValue, "phoneNumber": number, "code": code])
        }
    }

    func sendPhoneCode(to number: String) async throws -> PhoneCodeSent {
        try await post("v1/auth/phone/start", ["phoneNumber": number])
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
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
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

    func sendPhoneCode(to number: String) async throws -> PhoneCodeSent {
        try await api.sendPhoneCode(to: number)
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
