import SwiftUI

enum Sweech {
    enum Color {
        // Adaptive colors — dark values shown, light values in adaptiveColor()
        static let background   = adaptiveColor(dark: "#0A0A14", light: "#F5F5FA")
        static let surface      = adaptiveColor(dark: "#14142A", light: "#FFFFFF")
        static let surfaceHigh  = adaptiveColor(dark: "#1E1E3A", light: "#EDEDF5")

        static let core         = SwiftUI.Color(hex: "#A78BFA")  // purple — same in both
        static let glow         = SwiftUI.Color(hex: "#C4B5FD")  // light purple
        static let accent       = SwiftUI.Color(hex: "#818CF8")  // indigo
        static let warm         = SwiftUI.Color(hex: "#F9A8D4")  // pink

        static let textPrimary  = adaptiveColor(dark: "#F0EEFF", light: "#1A1A2E")
        static let textMuted    = adaptiveColor(dark: "#7C7C9A", light: "#6B6B85")

        static let ok           = SwiftUI.Color(hex: "#34D399")
        static let warning      = SwiftUI.Color(hex: "#FBBF24")
        static let danger       = SwiftUI.Color(hex: "#F87171")
        static let expiry       = SwiftUI.Color(hex: "#22D3EE")  // cyan — expiring quota alert

        private static func adaptiveColor(dark: String, light: String) -> SwiftUI.Color {
            SwiftUI.Color(nsColor: NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    ? NSColor(SwiftUI.Color(hex: dark))
                    : NSColor(SwiftUI.Color(hex: light))
            })
        }
    }

    enum Gradient {
        static let backgroundRadial = RadialGradient(
            colors: [adaptiveColor(dark: "#1A1040", light: "#E8E0F8").opacity(0.8), Sweech.Color.background],
            center: .top, startRadius: 0, endRadius: 300
        )

        private static func adaptiveColor(dark: String, light: String) -> SwiftUI.Color {
            SwiftUI.Color(nsColor: NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    ? NSColor(SwiftUI.Color(hex: dark))
                    : NSColor(SwiftUI.Color(hex: light))
            })
        }
    }

    enum Animation {
        static let fast = SwiftUI.Animation.easeInOut(duration: 0.15)
        static let medium = SwiftUI.Animation.easeInOut(duration: 0.25)
        static let slow = SwiftUI.Animation.easeInOut(duration: 0.5)
    }

    enum Spacing {
        static let cardPadding: CGFloat = 12
        static let sectionGap: CGFloat = 10
        static let cardRadius: CGFloat = 12
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
