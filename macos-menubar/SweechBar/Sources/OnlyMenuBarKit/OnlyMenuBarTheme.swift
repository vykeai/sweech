import SwiftUI

public struct OnlyBarTheme: Sendable {
    public struct Colors: Sendable {
        public var background: Color
        public var surface: Color
        public var surfaceHigh: Color
        public var textPrimary: Color
        public var textSecondary: Color
        public var textMuted: Color
        public var accent: Color
        public var success: Color
        public var warning: Color
        public var danger: Color

        public init(
            background: Color,
            surface: Color,
            surfaceHigh: Color,
            textPrimary: Color,
            textSecondary: Color,
            textMuted: Color,
            accent: Color,
            success: Color,
            warning: Color,
            danger: Color
        ) {
            self.background = background
            self.surface = surface
            self.surfaceHigh = surfaceHigh
            self.textPrimary = textPrimary
            self.textSecondary = textSecondary
            self.textMuted = textMuted
            self.accent = accent
            self.success = success
            self.warning = warning
            self.danger = danger
        }
    }

    public var colors: Colors
    public var backgroundGradient: RadialGradient

    public init(colors: Colors, backgroundGradient: RadialGradient) {
        self.colors = colors
        self.backgroundGradient = backgroundGradient
    }

    public static let defaultTheme = OnlyBarTheme(
        colors: .init(
            background: Color(hex: "#11131C"),
            surface: Color(hex: "#181C28"),
            surfaceHigh: Color(hex: "#232938"),
            textPrimary: Color.white.opacity(0.92),
            textSecondary: Color.white.opacity(0.62),
            textMuted: Color.white.opacity(0.38),
            accent: Color(hex: "#7DD3FC"),
            success: Color(hex: "#34D399"),
            warning: Color(hex: "#FBBF24"),
            danger: Color(hex: "#F87171")
        ),
        backgroundGradient: RadialGradient(
            colors: [Color(hex: "#1B2240").opacity(0.78), Color(hex: "#11131C")],
            center: .top,
            startRadius: 0,
            endRadius: 380
        )
    )
}

// `Color.init(hex:)` is defined in Design.swift in this target — vendored
// copy intentionally omitted to avoid duplicate-symbol errors. If the
// vendored module ever moves to a separate target, restore this extension.
