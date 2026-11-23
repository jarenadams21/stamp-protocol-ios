import SwiftUI

struct UtilityButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.appAccent) private var accent

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.body.weight(.medium))
            .foregroundStyle(isEnabled ? accent.color : Color.muted)
            .frame(width: 44, height: 44)
            .background(configuration.isPressed ? accent.surfaceColor : Color.surface, in: Circle())
            .overlay { Circle().strokeBorder(Color.rule, lineWidth: 0.75) }
    }
}
