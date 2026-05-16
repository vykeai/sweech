import SwiftUI

/// Single-column popover with two stacked sections:
///   - Accounts  (collapsible) — every identity in the vault
///   - Workspaces             — each workspace + its assigned account, as
///                              an inline Menu/Picker that lists compatible
///                              vault accounts. Picking one calls
///                              `sweech assign` and remounts the credential.
struct VaultView: View {
    @ObservedObject var service: SweechService
    @AppStorage("sweechBarAccountsExpanded") private var accountsExpanded: Bool = true
    @State private var workingWorkspace: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            accountsSection
            Divider()
            workspacesSection
            errorFooter
        }
        .padding(10)
        .onAppear {
            service.fetchVault()
            if service.accounts.isEmpty { service.fetch() }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Text("sweech")
                .font(.system(size: 12, weight: .bold))
            Spacer()
            Button(action: { service.fetchVault(); service.fetch() }) {
                Image(systemName: "arrow.clockwise").font(.system(size: 10))
            }
            .buttonStyle(.plain)
            .help("Reload vault + workspaces")

            Button(action: { service.refreshVaultTokens() }) {
                Image(systemName: "key.fill").font(.system(size: 10))
            }
            .buttonStyle(.plain)
            .help("Refresh expiring OAuth tokens")
        }
    }

    // MARK: - Accounts section (collapsible)

    private var accountsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: { accountsExpanded.toggle() }) {
                HStack(spacing: 4) {
                    Image(systemName: accountsExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text("Accounts")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text("(\(service.vaultAccounts.count))")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            if accountsExpanded {
                if service.vaultAccounts.isEmpty {
                    Text("Empty — run `sweech accounts import`")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 14)
                        .padding(.top, 2)
                } else {
                    ForEach(groupedAccounts(), id: \.0) { kind, list in
                        Text(kind == "anthropic" ? "Anthropic" : "OpenAI")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 14)
                            .padding(.top, 4)
                        ForEach(list) { account in accountRow(account) }
                    }
                }
            }
        }
    }

    private func accountRow(_ account: VaultAccount) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(account.kind == "anthropic" ? Color.orange : Color.green)
                .frame(width: 6, height: 6)
            Text(account.displayEmail)
                .font(.system(size: 11))
                .lineLimit(1)
            if let plan = account.plan {
                Text(plan)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if let exp = account.expiryLabel {
                Text(exp)
                    .font(.system(size: 9))
                    .foregroundStyle(exp == "expired" ? .red : .secondary)
            }
            if let status = account.status, status != "ok", status != "expired" {
                Text(status)
                    .font(.system(size: 9))
                    .foregroundStyle(.red)
            }
        }
        .padding(.leading, 14)
        .padding(.vertical, 1)
    }

    private func groupedAccounts() -> [(String, [VaultAccount])] {
        var map: [String: [VaultAccount]] = [:]
        for a in service.vaultAccounts {
            map[a.kind, default: []].append(a)
        }
        // anthropic first, then openai, then anything else (for future kinds)
        let order = ["anthropic", "openai"]
        let known = order.filter { map[$0] != nil }
        let extras = map.keys.filter { !order.contains($0) }.sorted()
        return (known + extras).map { ($0, map[$0]!.sorted { $0.email < $1.email }) }
    }

    // MARK: - Workspaces section

    private var workspacesSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text("Workspaces")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("(\(workspaceRows().count))")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                Spacer()
            }

            if workspaceRows().isEmpty {
                Text("No workspaces found.")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            } else {
                ForEach(workspaceRows(), id: \.commandName) { ws in
                    workspaceRow(ws)
                }
            }
        }
    }

    private func workspaceRows() -> [SweechAccount] {
        // First-party claude/codex workspaces only — external-provider routes
        // are managed via `sweech profile`, not the vault.
        service.accounts.filter { acc in
            (acc.cliType == "claude" || acc.cliType == "codex")
                && (acc.provider == nil || acc.provider == "anthropic" || acc.provider == "openai")
        }
    }

    private func workspaceRow(_ ws: SweechAccount) -> some View {
        let cliType = ws.cliType ?? "?"
        let busy = workingWorkspace == ws.commandName
        let compatible = compatibleAccounts(for: cliType)
        let activeId = ws.activeAccount?.id

        return HStack(spacing: 6) {
            Image(systemName: cliType == "claude" ? "c.circle.fill" : "circle.dotted")
                .font(.system(size: 12))
                .foregroundStyle(cliType == "claude" ? .orange : .green)

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(ws.commandName)
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                    if let plan = ws.planType {
                        Text(plan)
                            .font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.15))
                            .clipShape(Capsule())
                    }
                }
                if ws.live != nil {
                    let u5h = Int(ws.utilization5h * 100)
                    let u7d = Int(ws.utilization7d * 100)
                    HStack(spacing: 6) {
                        Text("5h \(u5h)%").font(.system(size: 9)).foregroundStyle(utilColor(u5h))
                        Text("·").font(.system(size: 9)).foregroundStyle(.tertiary)
                        Text("7d \(u7d)%").font(.system(size: 9)).foregroundStyle(utilColor(u7d))
                    }
                }
            }

            Spacer(minLength: 8)

            if busy {
                ProgressView().controlSize(.small)
            } else {
                accountMenu(for: ws, compatible: compatible, activeId: activeId)
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
    }

    /// Inline picker: tap shows compatible accounts; selecting one calls
    /// `sweech assign`. The current mount is highlighted.
    private func accountMenu(for ws: SweechAccount, compatible: [VaultAccount], activeId: String?) -> some View {
        let active = compatible.first(where: { $0.id == activeId })
        let label = active?.displayEmail ?? "no account"
        let color: Color = active == nil ? .secondary : .primary

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
                    .font(.system(size: 10))
                    .foregroundStyle(color)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 4))
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

    private func utilColor(_ pct: Int) -> Color {
        if pct >= 90 { return .red }
        if pct >= 70 { return .orange }
        return .secondary
    }

    // MARK: - Error footer

    @ViewBuilder
    private var errorFooter: some View {
        if let err = service.lastAssignError {
            Text(err)
                .font(.system(size: 10))
                .foregroundStyle(.red)
                .padding(.top, 2)
        }
        if let summary = service.lastRefreshSummary {
            Text(summary)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
    }
}
