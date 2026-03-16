import SwiftUI

enum Sweech {
    enum Color {
        static let background   = SwiftUI.Color(hex: "#0A0A14")
        static let surface      = SwiftUI.Color(hex: "#14142A")
        static let surfaceHigh  = SwiftUI.Color(hex: "#1E1E3A")

        static let core         = SwiftUI.Color(hex: "#A78BFA")  // purple
        static let glow         = SwiftUI.Color(hex: "#C4B5FD")  // light purple
        static let accent       = SwiftUI.Color(hex: "#818CF8")  // indigo
        static let warm         = SwiftUI.Color(hex: "#F9A8D4")  // pink

        static let textPrimary  = SwiftUI.Color(hex: "#F0EEFF")
        static let textMuted    = SwiftUI.Color(hex: "#7C7C9A")

        static let ok           = SwiftUI.Color(hex: "#34D399")
        static let warning      = SwiftUI.Color(hex: "#FBBF24")
        static let danger       = SwiftUI.Color(hex: "#F87171")
    }

    enum Gradient {
        static let backgroundRadial = RadialGradient(
            colors: [SwiftUI.Color(hex: "#1A1040").opacity(0.8), Sweech.Color.background],
            center: .top, startRadius: 0, endRadius: 300
        )
    }
}

extension SwiftUI.Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: .init(charactersIn: "#"))
        let val = UInt64(hex, radix: 16) ?? 0
        let r = Double((val >> 16) & 0xFF) / 255
        let g = Double((val >> 8)  & 0xFF) / 255
        let b = Double( val        & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}
