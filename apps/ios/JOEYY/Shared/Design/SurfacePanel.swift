import SwiftUI

struct SurfacePanel: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color.surface, in: .rect(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(Color.rule, lineWidth: 0.75)
            }
    }
}
