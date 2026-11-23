import CoreNFC
import Foundation

@MainActor
final class NFCTagScanner: NSObject, NFCNDEFReaderSessionDelegate {
    private var reader: NFCNDEFReaderSession?
    private var continuation: CheckedContinuation<String, Error>?

    func scan() async throws -> String {
        guard NFCNDEFReaderSession.readingAvailable else {
            throw TapError.message("NFC scanning requires a supported physical iPhone. It is not available on this device or simulator.")
        }
        guard continuation == nil else { throw TapError.message("A scan is already in progress.") }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let reader = NFCNDEFReaderSession(delegate: self, queue: .main, invalidateAfterFirstRead: false)
            self.reader = reader
            reader.alertMessage = "Hold your iPhone near the cafe loyalty tag."
            reader.begin()
        }
    }

    func cancel() {
        finish(.failure(TapError.message("Scan cancelled. No visit was submitted.")))
    }

    nonisolated func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
        let readerID = ObjectIdentifier(session)
        let urls = messages.flatMap(\.records).compactMap { $0.wellKnownTypeURIPayload()?.absoluteString }
        // Only Sendable strings cross into the main actor, never CoreNFC message/session objects.
        Task { @MainActor [weak self] in
            guard let self, self.reader.map(ObjectIdentifier.init) == readerID else { return }
            guard urls.count == 1, let url = urls.first else {
                self.finish(.failure(TapError.message("Expected one cafe URL on the tag. No visit was submitted.")))
                return
            }
            self.finish(.success(url))
        }
    }

    nonisolated func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        let readerID = ObjectIdentifier(session)
        let cancelled = (error as? NFCReaderError)?.code == .readerSessionInvalidationErrorUserCanceled
        let message = cancelled ? "Scan cancelled. No visit was submitted." : "NFC scan ended or timed out. Hold your iPhone near the tag and try again."
        Task { @MainActor [weak self] in
            guard let self, self.reader.map(ObjectIdentifier.init) == readerID else { return }
            self.finish(.failure(TapError.message(message)))
        }
    }

    private func finish(_ result: Result<String, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        reader?.invalidate()
        reader = nil
        continuation.resume(with: result)
    }
}
