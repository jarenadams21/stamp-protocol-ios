import Observation
import PassKit
import SwiftUI

struct WalletPresentation: Identifiable {
    let id = UUID()
    let pass: PKPass
}

@MainActor @Observable
final class TapWallet {
    var presentation: WalletPresentation?
    var message: String?
    private let library = PKPassLibrary()
    private var awaitingPass: PKPass?

    func accept(_ data: Data, onlyIfInstalled: Bool) {
        do {
            guard PKPassLibrary.isPassLibraryAvailable() else {
                throw TapError.message("Apple Wallet is not available on this device.")
            }
            let pass = try PKPass(data: data)
            if library.containsPass(pass) {
                guard library.replacePass(with: pass) else {
                    throw TapError.message("Wallet could not replace this pass. Check the app’s Wallet entitlement and try Update Wallet again.")
                }
                message = "Your existing Wallet pass was updated."
            } else if !onlyIfInstalled {
                guard PKAddPassesViewController.canAddPasses(),
                      PKAddPassesViewController(pass: pass) != nil else {
                    throw TapError.message("This device cannot present Add to Apple Wallet.")
                }
                awaitingPass = pass
                presentation = WalletPresentation(pass: pass)
            } else {
                message = "Your card is ready. Choose Add / Update Wallet to add it once."
            }
        } catch {
            message = (error as? TapError)?.errorDescription ?? "The service’s pass could not be opened. Check server-side pass signing and try again."
        }
    }

    func finished() {
        guard let pass = awaitingPass else { return }
        message = library.containsPass(pass) ? "Pass added to Apple Wallet." : "Add to Wallet was cancelled or the pass was not added. You can try again."
        awaitingPass = nil
        presentation = nil
    }
}

struct AddLoyaltyPassSheet: UIViewControllerRepresentable {
    let pass: PKPass
    let finished: @MainActor () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(finished: finished) }

    func makeUIViewController(context: Context) -> UIViewController {
        guard let controller = PKAddPassesViewController(pass: pass) else {
            let fallback = UIViewController()
            Task { @MainActor in finished() }
            return fallback
        }
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    @MainActor final class Coordinator: NSObject, PKAddPassesViewControllerDelegate {
        let finished: @MainActor () -> Void
        init(finished: @escaping @MainActor () -> Void) { self.finished = finished }
        nonisolated func addPassesViewControllerDidFinish(_ controller: PKAddPassesViewController) {
            Task { @MainActor in finished() }
        }
    }
}
