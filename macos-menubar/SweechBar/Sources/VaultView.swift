import SwiftUI

/// Tile-grid view with two sections:
///   Accounts   — OAuth identities (anthropic/openai from vault) plus
///                synthetic API-key entries derived from external-provider
///                workspaces (kimi, ollama, glm, minimax, dashscope, …).
///   Workspaces — every ~/.<name>/ directory rendered as a card with cli
///                badge, provider/plan, 5h+7d usage bars, and either an
///                inline account picker (vault-bound) or a read-only
///                provider label (external).
struct VaultView: View {
    @ObservedObject var service: SweechService
    @AppStorage("sweechBarAccountsExpanded") private var accountsExpanded: Bool = true
    @State private var workingWorkspace: String?

    private let columns: [GridItem] = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    var body: some View {
        ZStack {
            Sweech.Gradient.backgroundRadial

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    accountsSection
                    Divider().overlay(Sweech.Color.core.opacity(0.2))
                    workspacesSection
                    errorFooter
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 520, height: 760)
        .onAppear {
            service.fetchVault()
            if service.accounts.isEmpty { service.fetch() }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            Text("🍭 sweech")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Sweech.Color.textPrimary)
            Spacer()
            Button(action: { service.fetchVault(); service.fetch() }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Sweech.Color.core)
            }
            .buttonStyle(.plain)
            .help("Reload vault + workspaces")

            Button(action: { service.refreshVaultTokens() }) {
                Image(systemName: "key.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Sweech.Color.warm)
            }
            .buttonStyle(.plain)
            .help("Refresh expiring OAuth tokens")
        }
    }

    // MARK: - Accounts section

    private var accountsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: { accountsExpanded.toggle() }) {
                HStack(spacing: 4) {
                    Image(systemName: accountsExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Sweech.Color.core)
                    Text("Accounts")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Sweech.Color.textPrimary)
                    Text("(\(allAccountTiles().count))")
                        .font(.system(size: 11))
                        .foregroundStyle(Sweech.Color.textMuted)
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            if accountsExpanded {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                    ForEach(allAccountTiles(), id: \.id) { tile in
                        accountTile(tile)
                    }
                }
            }
        }
    }

    /// Synthetic union of vault accounts (OAuth) + external-provider
    /// summaries (one entry per unique non-anthropic/openai provider that
    /// has at least one workspace).
    private struct AccountTile: Identifiable, Hashable {
        let id: String
        let kind: String        // "anthropic" | "openai" | external provider key
        let label: String       // email or provider display name
        let subtitle: String?   // plan, key-count, etc
        let expiryLabel: String?
        let status: String?
        let isExternal: Bool
        let workspaceCount: Int
    }

    private func allAccountTiles() -> [AccountTile] {
        var tiles: [AccountTile] = []

        // OAuth vault accounts
        for a in service.vaultAccounts.sorted(by: { $0.email < $1.email }) {
            let mountedIn = service.accounts.filter { $0.activeAccount?.id == a.id }.count
            tiles.append(AccountTile(
                id: "vault:\(a.id)",
                kind: a.kind,
                label: a.displayEmail,
                subtitle: a.plan,
                expiryLabel: a.expiryLabel,
                status: a.status,
                isExternal: false,
                workspaceCount: mountedIn
            ))
        }

        // External-provider summary tiles, one per unique provider in use
        var seen = Set<String>()
        for ws in service.accounts where ws.isExternal {
            guard let provider = ws.provider, !seen.contains(provider) else { continue }
            seen.insert(provider)
            let wsCount = service.accounts.filter { $0.provider == provider }.count
            tiles.append(AccountTile(
                id: "ext:\(provider)",
                kind: provider,
                label: ws.providerLabel,
                subtitle: "API key",
                expiryLabel: nil,
                status: nil,
                isExternal: true,
                workspaceCount: wsCount
            ))
        }
        return tiles
    }

    private func accountTile(_ tile: AccountTile) -> some View {
        let glyph = providerGlyph(kind: tile.kind, isExternal: tile.isExternal)
        let tint = providerTint(kind: tile.kind, isExternal: tile.isExternal)
        let isExpired = tile.expiryLabel == "expired"
        let badStatus = (tile.status != nil && tile.status != "ok" && tile.status != "expired")

        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: glyph)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                Text(tile.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Sweech.Color.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }

            HStack(spacing: 4) {
                kindBadge(kind: tile.kind, isExternal: tile.isExternal)
                if let sub = tile.subtitle {
                    Text(sub)
                        .font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Sweech.Color.core.opacity(0.12))
                        .clipShape(Capsule())
                        .foregroundStyle(Sweech.Color.core)
                }
            }

            HStack(spacing: 4) {
                if let exp = tile.expiryLabel {
                    HStack(spacing: 2) {
                        Image(systemName: "key.fill").font(.system(size: 8))
                        Text(exp).font(.system(size: 9))
                    }
                    .foregroundStyle(isExpired ? Sweech.Color.danger : Sweech.Color.textMuted)
                }
                if badStatus, let s = tile.status {
                    Text(s)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Sweech.Color.danger)
                }
                Spacer(minLength: 0)
                if tile.workspaceCount > 0 {
                    Text("·")
                        .font(.system(size: 9))
                        .foregroundStyle(Sweech.Color.textMuted)
                    Text("\(tile.workspaceCount) ws")
                        .font(.system(size: 9))
                        .foregroundStyle(Sweech.Color.textMuted)
                        .help("Mounted in \(tile.workspaceCount) workspace(s)")
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sweech.Color.surface.opacity(0.8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Workspaces section

    private var workspacesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text("Workspaces")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Sweech.Color.textPrimary)
                Text("(\(service.accounts.count))")
                    .font(.system(size: 11))
                    .foregroundStyle(Sweech.Color.textMuted)
                Spacer()
            }

            if service.accounts.isEmpty {
                Text("No workspaces found.")
                    .font(.system(size: 11))
                    .foregroundStyle(Sweech.Color.textMuted)
            } else {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                    ForEach(service.accounts, id: \.commandName) { ws in
                        workspaceTile(ws)
                    }
                }
            }
        }
    }

    private func workspaceTile(_ ws: SweechAccount) -> some View {
        let cliType = ws.cliType ?? "?"
        let isVault = !ws.isExternal
        let busy = workingWorkspace == ws.commandName
        let kind = ws.isExternal ? (ws.provider ?? "") : (cliType == "claude" ? "anthropic" : "openai")
        let tint = providerTint(kind: kind, isExternal: ws.isExternal)
        let glyph = providerGlyph(kind: kind, isExternal: ws.isExternal)
        let activeId = ws.activeAccount?.id
        let compatible = compatibleAccounts(for: cliType)

        return VStack(alignment: .leading, spacing: 6) {
            // Top: glyph + name + status pill
            HStack(spacing: 6) {
                Image(systemName: glyph)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                Text(ws.commandName)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Sweech.Color.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                if ws.needsReauth == true {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(Sweech.Color.warning)
                        .help("Re-auth needed")
                }
            }

            // Badges row
            HStack(spacing: 4) {
                kindBadge(kind: kind, isExternal: ws.isExternal)
                if let plan = ws.planType {
                    Text(plan)
                        .font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Sweech.Color.core.opacity(0.12))
                        .clipShape(Capsule())
                        .foregroundStyle(Sweech.Color.core)
                }
                Spacer(minLength: 0)
            }

            // Usage bars (always rendered if we have live data)
            if ws.live != nil {
                usageBar(label: "5h", pct: ws.utilization5h)
                usageBar(label: "7d", pct: ws.utilization7d)
            } else if ws.isExternal {
                Text("API key · no quota info")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted)
            } else {
                Text("no live data")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted)
            }

            // Footer: account row
            HStack(spacing: 4) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted)
                if busy {
                    ProgressView().controlSize(.small)
                } else if isVault {
                    accountMenu(for: ws, compatible: compatible, activeId: activeId)
                } else {
                    Text(ws.providerLabel)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Sweech.Color.warm)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sweech.Color.surface.opacity(0.8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func usageBar(label: String, pct: Double) -> some View {
        let clamped = max(0, min(pct, 1))
        let color: Color = clamped >= 0.9 ? Sweech.Color.danger : (clamped >= 0.7 ? Sweech.Color.warning : Sweech.Color.ok)
        return HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Sweech.Color.textMuted)
                .frame(width: 16, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Sweech.Color.surfaceHigh)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(color)
                        .frame(width: geo.size.width * clamped)
                }
            }
            .frame(height: 4)
            Text("\(Int(clamped * 100))%")
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundStyle(color)
                .frame(width: 30, alignment: .trailing)
        }
    }

    // MARK: - Account picker (inline menu)

    private func accountMenu(for ws: SweechAccount, compatible: [VaultAccount], activeId: String?) -> some View {
        let active = compatible.first(where: { $0.id == activeId })
        let label = active?.displayEmail ?? "no account"

        return Menu {
            if compatible.isEmpty {
                Text("No compatible accounts in vault")
            } else {
                ForEach(compatible) { account in
                    Button {
                        workingWorkspace = ws.commandName
                        service.assignAccount(
                            workspaceCommandName: ws.commandName,
                            email: account.email
                        ) { _ in workingWorkspace = nil }
                    } label: {
                        if account.id == activeId {
                            Label(account.displayEmail, systemImage: "checkmark")
                        } else {
                            Text(account.displayEmail)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text(label)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(active == nil ? Sweech.Color.textMuted : Sweech.Color.accent)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(Sweech.Color.textMuted)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private func compatibleAccounts(for cliType: String) -> [VaultAccount] {
        let kind = cliType == "claude" ? "anthropic" : "openai"
        return service.vaultAccounts
            .filter { $0.kind == kind }
            .sorted { $0.email < $1.email }
    }

    // MARK: - Style helpers

    /// Always-filled glyph for consistency across tiles.
    private func providerGlyph(kind: String, isExternal: Bool) -> String {
        if isExternal { return "globe" }
        switch kind {
        case "anthropic": return "a.circle.fill"
        case "openai":    return "o.circle.fill"
        default:          return "circle.fill"
        }
    }

    private func providerTint(kind: String, isExternal: Bool) -> Color {
        if isExternal { return Sweech.Color.warm }
        switch kind {
        case "anthropic": return Color(hex: "#FF8C42")  // claude orange
        case "openai":    return Sweech.Color.ok        // openai green
        default:          return Sweech.Color.accent
        }
    }

    private func kindBadge(kind: String, isExternal: Bool) -> some View {
        let labels: [String: String] = [
            "anthropic": "Anthropic",
            "openai": "OpenAI",
            "kimi": "Kimi",
            "kimi-coding": "Kimi Coding",
            "glm": "GLM",
            "minimax": "MiniMax",
            "dashscope": "Alibaba",
            "openrouter": "OpenRouter",
            "deepseek": "DeepSeek",
            "qwen": "Qwen",
            "ollama": "Ollama",
            "ollama-cloud": "Ollama Cloud",
            "nvidia": "NVIDIA",
            "gemini": "Gemini",
            "groq": "Groq",
        ]
        let label = labels[kind] ?? kind.capitalized
        let color = providerTint(kind: kind, isExternal: isExternal)
        return Text(label)
            .font(.system(size: 9, weight: .bold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
            .foregroundStyle(color)
    }

    // MARK: - Error footer

    @ViewBuilder
    private var errorFooter: some View {
        if let err = service.lastAssignError {
            Text(err)
                .font(.system(size: 10))
                .foregroundStyle(Sweech.Color.danger)
                .padding(.top, 2)
        }
        if let summary = service.lastRefreshSummary {
            Text(summary)
                .font(.system(size: 10))
                .foregroundStyle(Sweech.Color.textMuted)
        }
    }
}
