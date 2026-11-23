import Foundation
import Security

enum TapMode: Equatable {
    case account, prototype

    static var configured: Self {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("-ui-testing") {
            return arguments.contains("-tap-prototype") ? .prototype : .account
        }
        #endif
        return (Bundle.main.object(forInfoDictionaryKey: "LoyaltyPrototypeMode") as? String)?
            .uppercased() == "YES" ? .prototype : .account
    }
}

struct LiveCard: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let cafeId: UUID
    let cafeName: String
    let stamps: Int
    let target: Int
    let rewardsAvailable: Int
    let updatedAt: String

    var place: Place {
        Place(id: "live-\(cafeId)", clientID: cafeId.uuidString, name: cafeName,
              neighborhood: "Verified visits", address: "", requiredPunches: target,
              rewardDescription: "Cafe reward", website: "", cardStyle: .rail)
    }
}

struct TapRequest: Codable, Equatable, Sendable {
    let url: String
    let requestId: UUID
}

struct TapResponse: Decodable, Sendable {
    let eventId: UUID
    let card: LiveCard
    let duplicate: Bool
    let verification: TapVerification?

    init(eventId: UUID, card: LiveCard, duplicate: Bool, verification: TapVerification? = nil) {
        self.eventId = eventId
        self.card = card
        self.duplicate = duplicate
        self.verification = verification
    }
}

struct TapVerification: Decodable, Equatable, Sendable {
    let verified: Bool
    let counter: Int
}

struct TapSession: Codable, Equatable, Sendable {
    let token: String
    let username: String
    var pending: TapRequest?
    var prototype: Bool?

    var isPrototype: Bool { prototype == true }
}

enum TapError: LocalizedError {
    case message(String)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .message(let text): text
        case .unauthorized: "Your session expired. Sign in again to continue."
        }
    }
}

@MainActor
protocol TapAPI {
    func startPrototypeSession(token: String?) async throws -> TapSession
    func authenticate(username: String, password: String, create: Bool) async throws -> TapSession
    func cards(token: String) async throws -> [LiveCard]
    func tap(_ request: TapRequest, token: String) async throws -> TapResponse
    func pass(cardID: UUID, token: String) async throws -> Data
    func logout(token: String) async throws
}

@MainActor
final class HTTPTapAPI: TapAPI {
    private let baseURL: URL?
    private let transport: URLSession

    init(baseURL: URL? = URL(string: Bundle.main.object(forInfoDictionaryKey: "LoyaltyAPIBaseURL") as? String ?? ""),
         transport: URLSession = URLSession(configuration: .ephemeral)) {
        self.baseURL = baseURL
        self.transport = transport
    }

    static func validateBaseURL(_ url: URL?) throws -> URL {
        guard let url, url.scheme == "https", let host = url.host, !host.isEmpty,
              host != "example.invalid", !host.hasSuffix(".invalid"),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw TapError.message("Tap is not configured. Set a real HTTPS LOYALTY_API_BASE_URL in Config/Local.xcconfig and rebuild.")
        }
        return url
    }

    func authenticate(username: String, password: String, create: Bool) async throws -> TapSession {
        struct Credentials: Encodable { let username: String; let password: String }
        let body = try JSONEncoder().encode(Credentials(username: username, password: password))
        let data = try await request(create ? "accounts" : "sessions", method: "POST", body: body)
        return try JSONDecoder().decode(TapSession.self, from: data)
    }

    func startPrototypeSession(token: String?) async throws -> TapSession {
        let data = try await request("prototype/session", method: "POST", token: token)
        return try JSONDecoder().decode(TapSession.self, from: data)
    }

    func cards(token: String) async throws -> [LiveCard] {
        struct Cards: Decodable { let cards: [LiveCard] }
        let data = try await request("cards", token: token)
        return try JSONDecoder().decode(Cards.self, from: data).cards
    }

    func tap(_ request: TapRequest, token: String) async throws -> TapResponse {
        let data = try await self.request("taps", method: "POST", token: token,
                                          body: JSONEncoder().encode(request))
        return try JSONDecoder().decode(TapResponse.self, from: data)
    }

    func pass(cardID: UUID, token: String) async throws -> Data {
        try await request("cards/\(cardID.uuidString)/pass", token: token, isPass: true)
    }

    func logout(token: String) async throws {
        _ = try await request("session", method: "DELETE", token: token)
    }

    private func request(_ path: String, method: String = "GET", token: String? = nil,
                         body: Data? = nil, isPass: Bool = false) async throws -> Data {
        let base = try Self.validateBaseURL(baseURL)
        var request = URLRequest(url: base.appendingPathComponent("api/v1/\(path)"))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(isPass ? "application/vnd.apple.pkpass" : "application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch {
            // Never surface transport errors containing credentials or encrypted tag data.
            if let network = error as? URLError {
                switch network.code {
                case .cannotFindHost, .dnsLookupFailed:
                    throw TapError.message("The loyalty server address is unavailable. Check for an app update or contact the test organizer. Any pending tap stays saved.")
                case .notConnectedToInternet:
                    throw TapError.message("You're offline. Reconnect, then refresh your cards or retry your saved pending tap.")
                case .timedOut, .cannotConnectToHost, .networkConnectionLost:
                    throw TapError.message("The loyalty server isn't responding. Try again when it's available; any pending tap stays saved.")
                default: break
                }
            }
            throw TapError.message("Cannot securely reach the loyalty service. Check your connection and retry. Any pending tap stays saved.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw TapError.message("The loyalty service returned an invalid response.")
        }
        switch http.statusCode {
        case 200...299: break
        case 401:
            if path == "prototype/session" {
                throw TapError.message("The saved prototype session could not be resumed. Your saved tap has not been discarded; contact the test organizer.")
            }
            if token == nil { throw TapError.message("Sign-in failed. Check your username and password.") }
            throw TapError.unauthorized
        case 400, 409, 422, 503:
            struct Failure: Decodable { let error: String; let message: String? }
            if let failure = try? JSONDecoder().decode(Failure.self, from: data) {
                let explanation = failure.message ?? failure.error
                if !explanation.isEmpty, explanation.count <= 500 {
                    throw TapError.message(explanation)
                }
            }
            throw TapError.message("The service could not complete this request. Retry the pending tap or check your account details.")
        default:
            if http.statusCode == 404, path == "prototype/session" {
                throw TapError.message("This server has not enabled the no-account NFC prototype. Contact the test organizer.")
            }
            throw TapError.message("The loyalty request failed (HTTP \(http.statusCode)). Please retry.")
        }
        if isPass, http.mimeType != "application/vnd.apple.pkpass" {
            throw TapError.message("The service did not return an Apple Wallet pass.")
        }
        return data
    }
}

@MainActor
protocol TapSessionStorage {
    func load() throws -> TapSession?
    func save(_ session: TapSession?) throws
}

@MainActor
struct KeychainTapSessionStorage: TapSessionStorage {
    let account: String

    init(mode: TapMode = .account) {
        let base = mode == .prototype ? "prototype-session" : "session"
        #if DEBUG
        account = ProcessInfo.processInfo.arguments.contains("-ui-testing") ? "\(base).ui-testing" : base
        #else
        account = base
        #endif
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.joeyy.customer.loyalty",
         kSecAttrAccount as String: account]
    }

    func load() throws -> TapSession? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw TapError.message("Could not read your secure session. Unlock your device and retry.")
        }
        return try JSONDecoder().decode(TapSession.self, from: data)
    }

    func save(_ session: TapSession?) throws {
        guard let session else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw TapError.message("Could not remove the secure session.")
            }
            return
        }
        let data = try JSONEncoder().encode(session)
        let status = SecItemUpdate(query as CFDictionary,
                                  [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                throw TapError.message("Could not save your secure session.")
            }
        } else if status != errSecSuccess {
            throw TapError.message("Could not save your secure session.")
        }
    }
}
