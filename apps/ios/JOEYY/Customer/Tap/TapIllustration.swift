import SwiftUI

struct TapIllustration: View {
    @Environment(\.appAccent) private var accent

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            RoundedRectangle(cornerRadius: 12)
                .fill(accent.surfaceColor)
                .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color.rule, lineWidth: 0.75) }
                .frame(width: 108, height: 82)
                .rotationEffect(.degrees(7))
                .offset(x: 4, y: -7)

            VStack(alignment: .leading, spacing: 17) {
                Text("JOEYY").font(.caption.weight(.semibold)).tracking(1.2)
                HStack(spacing: 9) {
                    ForEach(0..<4) { index in
                        Circle()
                            .fill(index < 2 ? Color.paper : accent.surfaceColor)
                            .overlay { Circle().strokeBorder(accent.color.opacity(0.5), lineWidth: 0.75) }
                            .frame(width: 15, height: 15)
                    }
                }
            }
            .foregroundStyle(accent.color)
            .padding(14)
            .frame(width: 112, height: 86)
            .background(Color.surface, in: .rect(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color.rule, lineWidth: 0.75) }
            .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 5)
            .rotationEffect(.degrees(-8))

            Image(systemName: "wave.3.right")
                .font(.title3.weight(.medium))
                .foregroundStyle(accent.onSolidColor)
                .frame(width: 40, height: 40)
                .background(accent.solidColor, in: Circle())
                .overlay { Circle().strokeBorder(Color.paper, lineWidth: 3) }
                .offset(x: 7, y: 14)
        }
        .frame(width: 126, height: 118)
        .accessibilityHidden(true)
    }
}
