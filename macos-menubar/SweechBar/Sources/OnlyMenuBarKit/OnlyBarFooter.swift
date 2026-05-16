import SwiftUI

public struct OnlyBarFooter: View {
    private let version: String
    private let actions: [OnlyBarFooterAction]
    private let theme: OnlyBarTheme

    public init(
        version: String,
        theme: OnlyBarTheme = .defaultTheme,
        actions: [OnlyBarFooterAction] = []
    ) {
        self.version = version
        self.theme = theme
        self.actions = actions
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(actions) { action in
                Button(action: action.handler) {
                    HStack(spacing: 8) {
                        if !action.icon.isEmpty {
                            Image(systemName: action.icon)
                                .font(.system(size: 11))
                                .foregroundStyle(action.accent ?? theme.colors.textMuted)
                                .frame(width: 16)
                        }
                        Text(action.title)
                            .font(.system(size: 11))
                            .foregroundStyle(theme.colors.textSecondary)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { isHovered in
                    // Simple hover feedback
                }
            }

            Text("v\(version)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(theme.colors.textMuted)
                .frame(maxWidth: .infinity)
                .padding(.top, 2)
                .padding(.bottom, 4)
        }
        .padding(.vertical, 4)
    }
}

public struct OnlyBarFooterAction: Identifiable {
    public let id = UUID()
    public let title: String
    public let icon: String
    public let accent: Color?
    public let handler: () -> Void

    public init(
        title: String,
        icon: String = "",
        accent: Color? = nil,
        handler: @escaping () -> Void
    ) {
        self.title = title
        self.icon = icon
        self.accent = accent
        self.handler = handler
    }
}
