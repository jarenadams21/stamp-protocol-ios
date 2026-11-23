import SwiftUI

struct TapStatusMessage: View {
    let message: String
    let identifier: String

    var body: some View {
        Label(message, systemImage: "info.circle")
            .font(.subheadline)
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(SurfacePanel())
            .accessibilityIdentifier(identifier)
    }
}
