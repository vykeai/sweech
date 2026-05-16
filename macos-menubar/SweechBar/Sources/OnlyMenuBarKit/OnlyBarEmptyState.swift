import SwiftUI

public struct OnlyBarEmptyState: View {
    private let icon: String
    private let title: String
    private let subtitle: String
    private let theme: OnlyBarTheme

    public init(
        icon: String = "tray",
        title: String,
        subtitle: String = "",
        theme: OnlyBarTheme = .defaultTheme
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.theme = theme
    }

    public var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 28))
                .foregroundStyle(theme.colors.textMuted)
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.colors.textSecondary)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.colors.textMuted)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }
}
