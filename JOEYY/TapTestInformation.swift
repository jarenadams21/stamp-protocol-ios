import SwiftUI

struct TapTestInformation: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Factory-key tags. Not valid for real rewards.", systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("tap.testWarning")
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 12) {
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
