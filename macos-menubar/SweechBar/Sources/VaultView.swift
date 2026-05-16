import SwiftUI

/// SweechBar root view — two tabs (Accounts / Workspaces) with provider
/// grouping and a guided assign sheet for moving an account onto a
/// workspace.
struct VaultView: View {
    @ObservedObject var service: SweechService
    @AppStorage("sweechBarTab") private var tab: String = "accounts"

    /// When non-nil, the assignment sheet is showing for this account.
    @State private var assigningAccount: VaultAccount?

    var body: some View {
        ZStack {
            Sweech.Gradient.backgroundRadial

            VStack(spacing: 0) {
                header

                Picker("", selection: $tab) {
                    Text("Accounts (\(service.vaultAccounts.count))").tag("accounts")
                    Text("Workspaces (\(service.accounts.count))").tag("workspaces")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, 12)
                .padding(.bottom, 8)

                ScrollView(.vertical, showsIndicators: true) {
                    VStack(alignment: .leading, spacing: 12) {
                        if tab == "accounts" {
                            AccountsTab(service: service, onAssign: { assigningAccount = $0 })
                        } else {
                            WorkspacesTab(service: service)
                        }
                        errorFooter
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(width: 540, height: 720)
        .sheet(item: $assigningAccount) { account in
            AssignSheet(service: service, account: account)
                .frame(width: 480, height: 420)
        }
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
            .help("Reload")

            Button(action: { service.refreshVaultTokens() }) {
                Image(systemName: "key.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Sweech.Color.warm)
            }
            .buttonStyle(.plain)
            .help("Refresh expiring OAuth tokens")
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 8)
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

// MARK: - Accounts tab — grouped tile grid

private struct AccountsTab: View {
    @ObservedObject var service: SweechService
    let onAssign: (VaultAccount) -> Void

    private let columns: [GridItem] = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(grouped(), id: \.0) { providerKey, accounts in
                providerSection(key: providerKey, accounts: accounts)
            }
        }
    }

    /// Returns ordered (providerKey, displayedAccounts) pairs.
    /// Anthropic + OpenAI vault accounts first; then synthetic "API key"
    /// tiles for each external provider that has at least one workspace.
    private func grouped() -> [(String, [VaultAccount])] {
        var groups: [(String, [VaultAccount])] = []

        let anthropic = service.vaultAccounts.filter { $0.kind == "anthropic" }
            .sorted { $0.email < $1.email }
        if !anthropic.isEmpty { groups.append(("anthropic", anthropic)) }

        let openai = service.vaultAccounts.filter { $0.kind == "openai" }
            .sorted { $0.email < $1.email }
        if !openai.isEmpty { groups.append(("openai", openai)) }

        // External providers — synthetic VaultAccounts so we can render
        // them with the same tile component. id is `ext:<provider>`, status
        // and expiry are nil (API-key based, no OAuth expiry).
        var seen = Set<String>()
        for ws in service.accounts where ws.isExternal {
            guard let p = ws.provider, !seen.contains(p) else { continue }
            seen.insert(p)
            let synthetic = VaultAccount(
                accountId: "ext:\(p)",
                kind: p,
                email: ws.providerLabel,
                displayName: nil,
                plan: nil,
                rateLimitTier: nil,
                addedAt: "",
                lastRefreshedAt: nil,
                expiresAt: nil,
                status: nil
            )
            groups.append((p, [synthetic]))
        }
        return groups
    }

    @ViewBuilder
    private func providerSection(key: String, accounts: [VaultAccount]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: TileStyle.glyph(kind: key))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(TileStyle.tint(kind: key))
                Text(TileStyle.label(kind: key))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Sweech.Color.textPrimary)
                Text("(\(accounts.count))")
                    .font(.system(size: 10))
                    .foregroundStyle(Sweech.Color.textMuted)
                Spacer()
            }
            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                ForEach(accounts) { account in
                    AccountTile(
                        account: account,
                        workspaceCount: workspaceCount(for: account),
                        onAssign: { onAssign(account) }
                    )
                }
            }
        }
    }

    private func workspaceCount(for account: VaultAccount) -> Int {
        if account.accountId.hasPrefix("ext:") {
            return service.accounts.filter { $0.provider == account.kind }.count
        }
        return service.accounts.filter { $0.activeAccount?.id == account.id }.count
    }
}

// MARK: - Account tile

private struct AccountTile: View {
    let account: VaultAccount
    let workspaceCount: Int
    let onAssign: () -> Void

    private var isExternal: Bool { account.accountId.hasPrefix("ext:") }
    private var tint: Color { TileStyle.tint(kind: account.kind) }
    private var glyph: String { TileStyle.glyph(kind: account.kind) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Row 1: glyph + identity
            HStack(spacing: 6) {
                Image(systemName: glyph)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                Text(isExternal ? account.email : account.displayEmail)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Sweech.Color.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }

            // Row 2: plan + auth-type badge
            HStack(spacing: 4) {
                if let plan = account.plan {
                    Text(plan)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Sweech.Color.core.opacity(0.15))
                        .clipShape(Capsule())
                        .foregroundStyle(Sweech.Color.core)
                }
                Text(isExternal ? "API key" : "OAuth")
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(tint.opacity(0.15))
                    .clipShape(Capsule())
                    .foregroundStyle(tint)
                Spacer(minLength: 0)
            }

            // Row 3: expiry + mounted-in count
            HStack(spacing: 4) {
                if let exp = account.expiryLabel {
                    HStack(spacing: 2) {
                        Image(systemName: "key.fill").font(.system(size: 8))
                        Text(exp).font(.system(size: 9))
                    }
                    .foregroundStyle(exp == "expired" ? Sweech.Color.danger : Sweech.Color.textMuted)
                }
                if let status = account.status, status != "ok", status != "expired" {
                    Text(status)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Sweech.Color.danger)
                }
                Spacer(minLength: 0)
                if workspaceCount > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "rectangle.stack.fill").font(.system(size: 8))
                        Text("\(workspaceCount)")
                            .font(.system(size: 9, weight: .medium, design: .monospaced))
                    }
                    .foregroundStyle(Sweech.Color.textMuted)
                    .help("Mounted in \(workspaceCount) workspace(s)")
                }
            }

            // Action — only for vault-backed (OAuth) accounts. External
            // entries are read-only (managed via `sweech profile`).
            if !isExternal {
                Button(action: onAssign) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.right.circle.fill")
                            .font(.system(size: 10))
                        Text("Assign to workspace…")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(tint)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                    .background(tint.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sweech.Color.surface.opacity(0.85))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Workspaces tab — grouped tile grid

private struct WorkspacesTab: View {
    @ObservedObject var service: SweechService
    @State private var workingWorkspace: String?

    private let columns: [GridItem] = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(grouped(), id: \.0) { key, list in
                providerSection(key: key, workspaces: list)
            }
        }
    }

    private func grouped() -> [(String, [SweechAccount])] {
        var map: [String: [SweechAccount]] = [:]
        for ws in service.accounts {
            map[ws.displayGroup, default: []].append(ws)
        }
        // claude, codex first then external providers alphabetically
        var ordered: [(String, [SweechAccount])] = []
        for key in ["claude", "codex"] {
            if let list = map.removeValue(forKey: key) {
                ordered.append((key, list))
            }
        }
        for key in map.keys.sorted() {
            ordered.append((key, map[key]!))
        }
        return ordered
    }

    @ViewBuilder
    private func providerSection(key: String, workspaces: [SweechAccount]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: TileStyle.glyph(kind: key))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(TileStyle.tint(kind: key))
                Text(TileStyle.label(kind: key))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Sweech.Color.textPrimary)
                Text("(\(workspaces.count))")
                    .font(.system(size: 10))
                    .foregroundStyle(Sweech.Color.textMuted)
                Spacer()
            }
            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                ForEach(workspaces, id: \.commandName) { ws in
                    WorkspaceTile(
                        ws: ws,
                        compatibleAccounts: compatibleAccounts(for: ws),
                        busy: workingWorkspace == ws.commandName,
                        onPick: { email in
                            workingWorkspace = ws.commandName
                            service.assignAccount(
                                workspaceCommandName: ws.commandName,
                                email: email
                            ) { _ in workingWorkspace = nil }
                        }
                    )
                }
            }
        }
    }

    private func compatibleAccounts(for ws: SweechAccount) -> [VaultAccount] {
        let kind = ws.cliType == "claude" ? "anthropic" : "openai"
        return service.vaultAccounts
            .filter { $0.kind == kind }
            .sorted { $0.email < $1.email }
    }
}

// MARK: - Workspace tile

private struct WorkspaceTile: View {
    let ws: SweechAccount
    let compatibleAccounts: [VaultAccount]
    let busy: Bool
    let onPick: (String) -> Void

    private var cliType: String { ws.cliType ?? "?" }
    private var kind: String { ws.isExternal ? (ws.provider ?? "") : (cliType == "claude" ? "anthropic" : "openai") }
    private var tint: Color { TileStyle.tint(kind: kind) }
    private var glyph: String { TileStyle.glyph(kind: kind) }
    private var activeId: String? { ws.activeAccount?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Top: glyph + name + warning
            HStack(spacing: 6) {
                Image(systemName: glyph)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint)
                Text(ws.commandName)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Sweech.Color.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if ws.needsReauth == true {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(Sweech.Color.warning)
                        .help("Re-auth needed")
                }
            }

            // Badges
            HStack(spacing: 4) {
                Text(TileStyle.label(kind: kind))
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(tint.opacity(0.15))
                    .clipShape(Capsule())
                    .foregroundStyle(tint)
                if let plan = ws.planType {
                    Text(plan)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Sweech.Color.core.opacity(0.15))
                        .clipShape(Capsule())
                        .foregroundStyle(Sweech.Color.core)
                }
                Spacer(minLength: 0)
            }

            // Usage bars / external label
            if ws.live != nil {
                UsageBar(label: "5h", pct: ws.utilization5h)
                UsageBar(label: "7d", pct: ws.utilization7d)
            } else if ws.isExternal {
                Text("API key · no quota info")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted)
            } else {
                Text("no live data")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted)
            }

            // Footer: active account / picker
            HStack(spacing: 4) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted)
                if busy {
                    ProgressView().controlSize(.small)
                } else if ws.isExternal {
                    Text(ws.providerLabel)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Sweech.Color.warm)
                } else {
                    accountMenu
                }
                Spacer(minLength: 0)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sweech.Color.surface.opacity(0.85))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var accountMenu: some View {
        let active = compatibleAccounts.first(where: { $0.id == activeId })
        let label = active?.displayEmail ?? "no account"

        return Menu {
            if compatibleAccounts.isEmpty {
                Text("No compatible accounts in vault")
            } else {
                ForEach(compatibleAccounts) { account in
                    Button {
                        onPick(account.email)
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
}

// MARK: - Assign sheet (journey)

private struct AssignSheet: View {
    @ObservedObject var service: SweechService
    let account: VaultAccount
    @Environment(\.dismiss) private var dismiss
    @State private var workingWorkspace: String?
    @State private var doneMessage: String?

    private var tint: Color { TileStyle.tint(kind: account.kind) }
    private var glyph: String { TileStyle.glyph(kind: account.kind) }

    private var compatibleWorkspaces: [SweechAccount] {
        service.accounts.filter { ws in
            let k = ws.cliType == "claude" ? "anthropic" : ws.cliType == "codex" ? "openai" : ""
            return k == account.kind && !ws.isExternal
        }
    }

    var body: some View {
        ZStack {
            Sweech.Gradient.backgroundRadial

            VStack(alignment: .leading, spacing: 12) {
                // Sheet header
                HStack(spacing: 8) {
                    Image(systemName: glyph)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(tint)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Assign account")
                            .font(.system(size: 11))
                            .foregroundStyle(Sweech.Color.textMuted)
                        Text(account.displayEmail)
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Sweech.Color.textPrimary)
                    }
                    Spacer()
                    Button(action: { dismiss() }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(Sweech.Color.textMuted)
                    }
                    .buttonStyle(.plain)
                }

                Text("Pick a compatible workspace to mount this account into. The chosen workspace's credentials are rewritten so the next CLI launch picks them up.")
                    .font(.system(size: 10))
                    .foregroundStyle(Sweech.Color.textMuted)

                ScrollView {
                    VStack(spacing: 6) {
                        if compatibleWorkspaces.isEmpty {
                            Text("No compatible \(account.kind == "anthropic" ? "claude" : "codex") workspaces found.")
                                .font(.system(size: 11))
                                .foregroundStyle(Sweech.Color.textMuted)
                                .padding(.vertical, 12)
                        } else {
                            ForEach(compatibleWorkspaces, id: \.commandName) { ws in
                                assignRow(ws)
                            }
                        }
                    }
                }

                if let msg = doneMessage {
                    Text(msg)
                        .font(.system(size: 10))
                        .foregroundStyle(Sweech.Color.ok)
                }
            }
            .padding(16)
        }
    }

    private func assignRow(_ ws: SweechAccount) -> some View {
        let isCurrentMount = ws.activeAccount?.id == account.id
        let busy = workingWorkspace == ws.commandName

        return Button(action: {
            workingWorkspace = ws.commandName
            service.assignAccount(workspaceCommandName: ws.commandName, email: account.email) { ok in
                workingWorkspace = nil
                if ok {
                    doneMessage = "✓ Mounted into \(ws.commandName)"
                    // Auto-dismiss after a short beat
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                        dismiss()
                    }
                }
            }
        }) {
            HStack(spacing: 8) {
                Image(systemName: TileStyle.glyph(kind: ws.cliType == "claude" ? "anthropic" : "openai"))
                    .font(.system(size: 14))
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(ws.commandName)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Sweech.Color.textPrimary)
                    if let active = ws.activeAccount {
                        Text("currently: \(active.email.hasSuffix("@unknown.local") ? "(no email)" : active.email)")
                            .font(.system(size: 9))
                            .foregroundStyle(isCurrentMount ? Sweech.Color.ok : Sweech.Color.textMuted)
                    } else {
                        Text("currently: no account mounted")
                            .font(.system(size: 9))
                            .foregroundStyle(Sweech.Color.textMuted)
                    }
                }
                Spacer()
                if busy {
                    ProgressView().controlSize(.small)
                } else if isCurrentMount {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Sweech.Color.ok)
                } else {
                    Image(systemName: "arrow.right.circle")
                        .foregroundStyle(tint)
                }
            }
            .padding(10)
            .background(Sweech.Color.surface.opacity(0.85))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(tint.opacity(0.2)))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(isCurrentMount || busy)
    }
}

// MARK: - Usage bar

private struct UsageBar: View {
    let label: String
    let pct: Double

    var body: some View {
        let clamped = max(0, min(pct, 1))
        let color: Color = clamped >= 0.9 ? Sweech.Color.danger : (clamped >= 0.7 ? Sweech.Color.warning : Sweech.Color.ok)
        return HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Sweech.Color.textMuted)
                .frame(width: 16, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2).fill(Sweech.Color.surfaceHigh)
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
}

// MARK: - Provider style centralisation

private enum TileStyle {
    static func glyph(kind: String) -> String {
        switch kind {
        case "anthropic", "claude": return "a.circle.fill"
        case "openai", "codex":     return "o.circle.fill"
        case "kimi", "kimi-coding": return "k.circle.fill"
        case "glm":                 return "g.circle.fill"
        case "minimax":             return "m.circle.fill"
        case "dashscope":           return "q.circle.fill"
        case "ollama", "ollama-cloud": return "cube.fill"
        case "openrouter":          return "globe"
        case "gemini":              return "sparkle"
        case "groq":                return "bolt.fill"
        case "nvidia":              return "n.circle.fill"
        case "deepseek":            return "d.circle.fill"
        case "qwen":                return "q.circle.fill"
        default:                    return "circle.fill"
        }
    }

    static func tint(kind: String) -> Color {
        switch kind {
        case "anthropic", "claude": return Color(hex: "#FF8C42")
        case "openai", "codex":     return Sweech.Color.ok
        case "kimi", "kimi-coding": return Color(hex: "#7DD3FC")
        case "glm":                 return Color(hex: "#A78BFA")
        case "minimax":             return Color(hex: "#F472B6")
        case "dashscope":           return Color(hex: "#FB923C")
        case "ollama", "ollama-cloud": return Color(hex: "#94A3B8")
        case "openrouter":          return Sweech.Color.accent
        case "gemini":              return Color(hex: "#60A5FA")
        case "groq":                return Color(hex: "#F87171")
        case "nvidia":              return Color(hex: "#76FF03")
        case "deepseek":            return Color(hex: "#22D3EE")
        case "qwen":                return Color(hex: "#FBBF24")
        default:                    return Sweech.Color.warm
        }
    }

    static func label(kind: String) -> String {
        switch kind {
        case "anthropic", "claude": return "Anthropic"
        case "openai", "codex":     return "OpenAI"
        case "kimi":                return "Kimi"
        case "kimi-coding":         return "Kimi Coding"
        case "glm":                 return "GLM"
        case "minimax":             return "MiniMax"
        case "dashscope":           return "Alibaba"
        case "openrouter":          return "OpenRouter"
        case "deepseek":            return "DeepSeek"
        case "qwen":                return "Qwen"
        case "ollama":              return "Ollama"
        case "ollama-cloud":        return "Ollama Cloud"
        case "nvidia":              return "NVIDIA"
        case "gemini":              return "Gemini"
        case "groq":                return "Groq"
        default:                    return kind.capitalized
        }
    }
}
