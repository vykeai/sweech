import SwiftUI

public struct OnlyBarPanel<Content: View>: View {
    private let theme: OnlyBarTheme
    private let width: CGFloat
    private let content: Content

    public init(
        theme: OnlyBarTheme = .defaultTheme,
        width: CGFloat = 360,
        @ViewBuilder content: () -> Content
    ) {
        self.theme = theme
        self.width = width
        self.content = content()
    }

    public var body: some View {
        ZStack {
            theme.backgroundGradient.ignoresSafeArea()
            VStack(spacing: 0) {
                content
            }
        }
        .frame(width: width)
    }
}

public struct OnlyBarHeader<Leading: View, Trailing: View>: View {
    private let theme: OnlyBarTheme
    private let title: String
    private let subtitle: String?
    private let leading: Leading
    private let trailing: Trailing

    public init(
        title: String,
        subtitle: String? = nil,
        theme: OnlyBarTheme = .defaultTheme,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.theme = theme
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 10) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(theme.colors.textPrimary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(theme.colors.textSecondary)
                }
            }
            Spacer()
            trailing
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}

public struct OnlyBarSectionHeader: View {
    private let theme: OnlyBarTheme
    private let title: String
    private let count: Int?

    public init(_ title: String, count: Int? = nil, theme: OnlyBarTheme = .defaultTheme) {
        self.title = title
        self.count = count
        self.theme = theme
    }

    public var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(theme.colors.accent)
            if let count {
                Text("\(count)")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(theme.colors.textMuted)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(theme.colors.surfaceHigh)
                    .clipShape(Capsule())
            }
            Spacer()
        }
    }
}

public struct OnlyBarCard<Content: View>: View {
    private let theme: OnlyBarTheme
    private let borderColor: Color
    private let glowColor: Color
    private let content: Content

    public init(
        theme: OnlyBarTheme = .defaultTheme,
        borderColor: Color? = nil,
        glowColor: Color = .clear,
        @ViewBuilder content: () -> Content
    ) {
        self.theme = theme
        self.borderColor = borderColor ?? theme.colors.surfaceHigh
        self.glowColor = glowColor
        self.content = content()
    }

    public var body: some View {
        content
            .padding(12)
            .background(theme.colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(borderColor.opacity(0.65), lineWidth: 1)
            )
            .shadow(color: glowColor, radius: glowColor == .clear ? 0 : 10, x: 0, y: 4)
    }
}

public struct OnlyBarBadge: View {
    public enum Tone {
        case accent
        case success
        case warning
        case danger
        case muted
    }

    private let theme: OnlyBarTheme
    private let text: String
    private let tone: Tone

    public init(_ text: String, tone: Tone, theme: OnlyBarTheme = .defaultTheme) {
        self.text = text
        self.tone = tone
        self.theme = theme
    }

    private var color: Color {
        switch tone {
        case .accent: return theme.colors.accent
        case .success: return theme.colors.success
        case .warning: return theme.colors.warning
        case .danger: return theme.colors.danger
        case .muted: return theme.colors.textMuted
        }
    }

    public var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

public struct OnlyBarDivider: View {
    private let theme: OnlyBarTheme

    public init(theme: OnlyBarTheme = .defaultTheme) {
        self.theme = theme
    }

    public var body: some View {
        Divider()
            .overlay(theme.colors.surfaceHigh.opacity(0.7))
    }
}
