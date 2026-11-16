import XCTest
@testable import JOEYY

@MainActor
final class TapHTTPTests: XCTestCase {
    private func api(host: String = "cafe.test") -> HTTPTapAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TapHTTPFixture.self]
        return HTTPTapAPI(baseURL: URL(string: "https://\(host)"),
                          transport: URLSession(configuration: configuration))
    }

    func testPersonalPassUsesAuthenticatedCustomerRoute() async throws {
        let id = try XCTUnwrap(UUID(uuidString: "abcdef00-1234-4567-89ab-abcdef123456"))
        let data = try await api().pass(cardID: id, token: "fixture-session")
        XCTAssertEqual(data, Data("fixture-pass".utf8))
    }

    func testAccountValidationDisplaysTheServicesActionableMessage() async {
        do {
            _ = try await api().authenticate(username: "fixture", password: "fixture-password", create: true)
            XCTFail("The fixture rejects this account.")
        } catch {
            XCTAssertEqual(error.localizedDescription, "That username is already taken.")
        }
    }

    func testExpiredServerAddressExplainsWhySavedTapCannotBeConfirmed() async {
        do {
            _ = try await api(host: "missing.cafe.test").cards(token: "fixture-session")
            XCTFail("The fixture server address cannot be resolved.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("server address is unavailable"))
            XCTAssertTrue(error.localizedDescription.contains("pending tap stays saved"))
            XCTAssertFalse(error.localizedDescription.contains("fixture-session"))
        }
    }

    func testOfflineErrorDoesNotClaimCardsAreMissing() async {
        do {
            _ = try await api(host: "offline.cafe.test").cards(token: "fixture-session")
            XCTFail("The fixture is offline.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("You're offline"))
            XCTAssertFalse(error.localizedDescription.contains("No verified cards"))
        }
    }

    func testSharedServerErrorUsesHumanMessageInsteadOfErrorCode() async {
        do {
            _ = try await api(host: "shared.cafe.test").cards(token: "fixture-session")
            XCTFail("The fixture requires native NFC configuration.")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Native NFC is not enabled on this server.")
        }
    }
}

private final class TapHTTPFixture: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        if url.host == "missing.cafe.test" || url.host == "offline.cafe.test" {
            let code: URLError.Code = url.host == "missing.cafe.test" ? .cannotFindHost : .notConnectedToInternet
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
        }
        let status: Int
        let contentType: String
        let data: Data
        if url.host == "shared.cafe.test" {
            status = 503
            contentType = "application/json"
            data = Data(#"{"error":"nativeUnavailable","message":"Native NFC is not enabled on this server."}"#.utf8)
        } else if url.path.hasSuffix("/pass") {
            XCTAssertEqual(url.path, "/api/v1/cards/ABCDEF00-1234-4567-89AB-ABCDEF123456/pass")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-session")
            XCTAssertEqual(request.httpMethod, "GET")
            status = 200
            contentType = "application/vnd.apple.pkpass"
            data = Data("fixture-pass".utf8)
        } else {
            XCTAssertEqual(url.path, "/api/v1/accounts")
            XCTAssertEqual(request.httpMethod, "POST")
            status = 409
            contentType = "application/json"
            data = Data(#"{"error":"That username is already taken."}"#.utf8)
        }
        guard let response = HTTPURLResponse(url: url, statusCode: status,
                                              httpVersion: nil, headerFields: ["Content-Type": contentType]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
