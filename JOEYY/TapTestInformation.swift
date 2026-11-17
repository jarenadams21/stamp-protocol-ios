import SwiftUI

struct TapTestInformation: View {
    var prototype = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Factory-key tags. Not valid for real rewards.", systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("tap.testWarning")
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 12) {
                    if prototype {
                        Text("This phone keeps an anonymous test card, not a verified customer account. Account setup is separate work.")
                        Text("The phone sends the encrypted chip read to the backend. The backend decrypts and verifies it before adding a stamp. Fresh physical reads keep counting; retrying the same read never counts twice.")
                        Text("After a verified scan, confirm Add to Apple Wallet once. Later scans update that same installed card. Cancelling Wallet never undoes a confirmed stamp.")
                    }
                    Text("These verified cards are separate from your local demo cards.")
                    Text("Hardware test only. Factory zero-key tags are not secure for production rewards.")
                    Text("Scanning needs a supported iPhone. Add a Wallet card once with Apple's confirmation; later scans can update that installed card. This is not an Apple Pay payment.")
                }
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
            } label: {
                Label("How this test works", systemImage: "info.circle")
                    .font(.subheadline)
                    .foregroundStyle(Color.primary)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("tap.testInformationLabel")
            }
            .accessibilityIdentifier("tap.testInformation")
        }
    }
}
