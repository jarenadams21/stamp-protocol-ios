import AuthenticationServices
import CryptoKit
import Foundation
import Security
import SwiftUI

enum SignInCrypto {
    /// A random URL-safe string, used for nonces, PKCE verifiers, and OAuth state.
    static func randomString(bytes: Int = 32) -> String {
        var data = Data(count: bytes)
        let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        precondition(status == errSecSuccess, "No secure random bytes")
        return base64URL(data)
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Apple gets SHA-256(nonce) in hex; the backend gets the nonce and checks the hash.
    static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// PKCE S256 code challenge (RFC 7636).
    static func codeChallenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
}

/// Google sign-in without Google's SDK: the authorization code flow with PKCE in a system browser
/// sheet, then the code is exchanged for an ID token that the backend verifies.
struct GoogleOAuth: Sendable {
    let clientID: String

    /// Google's iOS redirect scheme is the client ID reversed: com.googleusercontent.apps.<id>.
    var callbackScheme: String {
        clientID.split(separator: ".").reversed().joined(separator: ".")
    }

    var redirectURI: String { "\(callbackScheme):/oauth2redirect" }

    func authorizationURL(codeChallenge: String, state: String, nonce: String) -> URL {
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            // `email` makes Google include the verified address in the ID token, so the backend can store it.
            URLQueryItem(name: "scope", value: "openid email"),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        return components.url!
    }

    /// The authorization code from Google's redirect, after checking `state`.
    func code(from callback: URL, state: String) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty
        else { throw AuthError.server(code: "signInFailed", message: "Sign-in didn't work. Try again.") }
        return code
    }

    func exchange(code: String, verifier: String, session: URLSession = .shared) async throws -> String {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "code_verifier", value: verifier),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "grant_type", value: "authorization_code"),
        ]
        request.httpBody = Data((form.percentEncodedQuery ?? "").utf8)
        struct Tokens: Decodable { let id_token: String }
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw AuthError.server(code: "signInFailed", message: "Sign-in didn't work. Try again.")
            }
            return try JSONDecoder().decode(Tokens.self, from: data).id_token
        } catch let error as AuthError {
            throw error
        } catch {
            throw AuthError.network
        }
    }

    /// Runs the whole flow and returns the proof for the backend.
    @MainActor
    func signIn(using session: WebAuthenticationSession) async throws -> SignInProof {
        let verifier = SignInCrypto.randomString()
        let state = SignInCrypto.randomString(bytes: 16)
        let nonce = SignInCrypto.randomString()
        let url = authorizationURL(codeChallenge: SignInCrypto.codeChallenge(for: verifier), state: state, nonce: nonce)
        let callback = try await session.authenticate(using: url, callbackURLScheme: callbackScheme, preferredBrowserSession: .ephemeral)
        let idToken = try await exchange(code: try code(from: callback, state: state), verifier: verifier)
        return .google(idToken: idToken, nonce: nonce)
    }
}
