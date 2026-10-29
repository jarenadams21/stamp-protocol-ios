import SwiftUI

enum AppAccent: String, CaseIterable, Identifiable, Sendable {
    case orange = "Orange"
    case yellow = "Yellow"
    case purple = "Purple"
    case green = "Green"
    case terracotta = "Clay"
    case moss = "Moss"
    case blue = "Ink"
    case plum = "Plum"

    var id: String { rawValue }

    private var values: (ink: UInt32, darkInk: UInt32, surface: UInt32, darkSurface: UInt32, fill: UInt32, onFill: UInt32) {
        switch self {
        case .orange: (0xA03B00, 0xFFB07C, 0xFFF3E9, 0x28201B, 0xF47B35, 0x191B18)
        case .yellow: (0x735800, 0xF2D466, 0xFBF5DD, 0x282519, 0xF0CE4E, 0x191B18)
        case .purple: (0x7042A8, 0xC6A7EE, 0xF4EFFA, 0x231E2B, 0x7950B8, 0xFFFFFF)
        case .green: (0x2F6545, 0x9CCFAF, 0xEDF4EE, 0x1B2720, 0x32734D, 0xFFFFFF)
        case .terracotta: (0xA13F2C, 0xE6A58D, 0xFAEFEB, 0x291F1C, 0xA13F2C, 0xFFFFFF)
        case .moss: (0x426246, 0xA3C5A3, 0xEFF3EC, 0x20271E, 0x426246, 0xFFFFFF)
        case .blue: (0x335D87, 0xA7C6EB, 0xEDF2F8, 0x1C232D, 0x335D87, 0xFFFFFF)
        case .plum: (0x7B456F, 0xD8AED0, 0xF8EFF5, 0x281E26, 0x7B456F, 0xFFFFFF)
        }
    }

    var color: Color { .adaptive(light: values.ink, dark: values.darkInk) }
    var surfaceColor: Color { .adaptive(light: values.surface, dark: values.darkSurface) }
    var solidColor: Color { Color(hex: values.fill) }
    var onSolidColor: Color { Color(hex: values.onFill) }
    var washColor: Color { Color.paper.mix(with: solidColor, by: 0.14) }
}

private struct AppAccentKey: EnvironmentKey {
    static let defaultValue = AppAccent.orange
}

extension EnvironmentValues {
    var appAccent: AppAccent {
        get { self[AppAccentKey.self] }
        set { self[AppAccentKey.self] = newValue }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }

    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }

    static let paper = Color.adaptive(light: 0xF5F5F1, dark: 0x131515)
    static let surface = Color.adaptive(light: 0xFFFFFF, dark: 0x1C1F1E)
    static let muted = Color.adaptive(light: 0x585B55, dark: 0xB8BDB8)
    static let rule = Color.adaptive(light: 0xD8DBD3, dark: 0x3A403B)
}

struct PageTitle: View {
    let text: String
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 36

    init(text: String, size: CGFloat = 36) {
        self.text = text
        _size = ScaledMetric(wrappedValue: size, relativeTo: .largeTitle)
    }

    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .medium))
            .tracking(-1.1)
            .foregroundStyle(.tint)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct Eyebrow: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.medium))
            .tracking(0.7)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct BrandMark: View {
    var body: some View {
        Text("JOEYY")
            .font(.headline.weight(.semibold))
            .tracking(-0.5)
            .foregroundStyle(.tint)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Joeyy")
    }
}

struct PrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.appAccent) private var accent

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 16)
            .foregroundStyle(accent.onSolidColor)
            .background {
                RoundedRectangle(cornerRadius: 8)
                    .fill(accent.solidColor)
            }
            .opacity(isEnabled ? (configuration.isPressed ? 0.78 : 1) : 0.5)
    }
}

struct SectionHeading: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.headline.weight(.medium)).foregroundStyle(.tint)
            Spacer()
            if let detail {
                Text(detail).font(.caption).foregroundStyle(Color.muted)
            }
        }
    }
}

private struct NavigationHeading: ViewModifier {
    let title: String

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(.headline.weight(.medium)).foregroundStyle(.tint)
                }
            }
    }
}

extension View {
    func appNavigationTitle(_ title: String) -> some View {
        modifier(NavigationHeading(title: title))
    }
}

struct SecondaryButton: ButtonStyle {
    @Environment(\.appAccent) private var accent

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline)
            .foregroundStyle(accent.color)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct TextButton: ButtonStyle {
    @Environment(\.appAccent) private var accent
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? accent.color : Color.muted)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct AppBackground: View {
    @Environment(\.appAccent) private var accent

    var body: some View {
        RadialGradient(
            colors: [accent.washColor, .paper],
            center: .topTrailing, startRadius: 0, endRadius: 640
        )
        .ignoresSafeArea()
    }
}

struct ClientRow: View {
    let place: Place
    var stamps: Int? = nil
    @Environment(\.appAccent) private var accent

    var body: some View {
        HStack(spacing: 16) {
            PlaceMark(place: place, size: 28)
                .foregroundStyle(accent.color)
                .frame(width: 44, height: 44)
                .background(accent.surfaceColor, in: RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 6) {
                Text(place.name)
                    .font(.headline.weight(.medium))
                    .foregroundStyle(accent.color)
                    .fixedSize(horizontal: false, vertical: true)
                Text(place.neighborhood).font(.caption).foregroundStyle(Color.muted)
            }
            Spacer(minLength: 8)
            if let stamps {
                VStack(alignment: .trailing, spacing: 3) {
                    Text("\(stamps)").font(.title3.weight(.medium).monospacedDigit())
                        .foregroundStyle(accent.color)
                    Text(stamps == 1 ? "stamp" : "stamps")
                        .font(.caption).foregroundStyle(Color.muted)
                }
            }
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Color.muted)
        }
        .padding(18)
        .frame(minHeight: 88)
        .contentShape(Rectangle())
    }
}

struct StampBalance: View {
    let place: Place
    let stamps: Int
    @Environment(\.appAccent) private var accent

    var body: some View {
        HStack(alignment: .center) {
            Text("\(stamps) \(stamps == 1 ? "stamp" : "stamps")")
                .font(.largeTitle.weight(.medium).monospacedDigit())
                .foregroundStyle(accent.color)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("detail.balance")
            Spacer()
            PlaceMark(place: place, size: 38)
                .foregroundStyle(accent.color)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 8)
                .fill(LinearGradient(
                    colors: [accent.surfaceColor, Color.surface],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ))
            }
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(accent.color.opacity(0.15)))
    }
}

struct Notice: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).foregroundStyle(.tint).frame(width: 24)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.tint)
                Text(message).font(.footnote).foregroundStyle(Color.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct PlaceMark: View {
    let place: Place
    var size: CGFloat = 24

    var body: some View {
        Group {
            switch place.icon {
            case .burger:
                BurgerShape().fill()
            case .system(let name):
                Image(systemName: name).resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct BurgerShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: w * 0.1, y: h * 0.38))
        path.addCurve(
            to: CGPoint(x: w * 0.9, y: h * 0.38),
            control1: CGPoint(x: w * 0.1, y: -h * 0.04),
            control2: CGPoint(x: w * 0.9, y: -h * 0.04)
        )
        path.addLine(to: CGPoint(x: w * 0.9, y: h * 0.42))
        path.addLine(to: CGPoint(x: w * 0.1, y: h * 0.42))
        path.closeSubpath()
        path.addRoundedRect(
            in: CGRect(x: w * 0.04, y: h * 0.48, width: w * 0.92, height: h * 0.1),
            cornerSize: CGSize(width: w * 0.05, height: h * 0.05)
        )
        path.addRoundedRect(
            in: CGRect(x: w * 0.07, y: h * 0.63, width: w * 0.86, height: h * 0.12),
            cornerSize: CGSize(width: w * 0.06, height: h * 0.06)
        )
        path.addRoundedRect(
            in: CGRect(x: w * 0.1, y: h * 0.8, width: w * 0.8, height: h * 0.14),
            cornerSize: CGSize(width: w * 0.08, height: h * 0.08)
        )
        return path
    }
}
