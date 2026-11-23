import SwiftUI

struct TapWelcomeHeader: View {
    let signedIn: Bool
    var prototype = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    context
                    testMode
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    context
                    Spacer(minLength: 0)
                    testMode
                }
            }
            HStack(alignment: .center, spacing: 12) {
                PageTitle(text: prototype ? "Read. Verify.\nStamp." : signedIn ? "Your visits" : "Every visit\nadds up.", size: 40)
                    .accessibilityLabel(prototype ? "Read. Verify. Stamp." : signedIn ? "Your visits" : "Every visit adds up.")
                    .accessibilityIdentifier("tap.heading")
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !signedIn && !typeSize.isAccessibilitySize {
                    TapIllustration()
                }
            }

            Text(prototype ? "Real chip verification on the backend. No customer account needed." : signedIn
                 ? "Your cafe cards, one visit at a time."
                 : "Scan at the counter. Keep your stamps together.")
                .font(.subheadline)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var context: some View {
        Eyebrow(text: prototype ? "NFC prototype" : "At the counter").foregroundStyle(Color.muted)
    }

    private var testMode: some View {
        Label("Test mode", systemImage: "flask")
            .font(.footnote)
            .foregroundStyle(Color.muted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("tap.testMode")
    }
}

#Preview {
    TapWelcomeHeader(signedIn: false)
        .padding(24)
        .background { AppBackground() }
}
