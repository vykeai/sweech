import SwiftUI
import AppKit

/// SweechBar root view — two tabs (Accounts / Workspaces) with provider
/// grouping and a guided assign sheet for moving an account onto a
/// workspace.
struct VaultView: View {
    @ObservedObject var service: SweechService
    // Default to "workspaces" because the primary action in SweechBar
    // is launching a workspace; accounts are the supporting view. The
    // AppStorage key is versioned so users who opened the app under
    // the old account-first default get the new default once.
    @AppStorage("sweechBarTab_v2") private var tab: String = "workspaces"

    /// When non-nil, the assignment sheet is showing for this account.
    @State private var assigningAccount: VaultAccount?

    /// When both lists are empty, a brand-new user has nothing to look at —
    /// two empty grids with no guidance. Surface an onboarding view that
    /// points them at `sweech init` / `sweech accounts import` instead.
    private var isUnconfigured: Bool {
        service.vaultAccounts.isEmpty && service.accounts.isEmpty
    }

    var body: some View {
        ZStack {
            Sweech.Gradient.backgroundRadial

            VStack(spacing: 0) {
                header
                if isUnconfigured {
                    // Keep the header (reload + key-refresh) so the user can
                    // re-poll after running sweech init in Terminal without
                    // quitting the menubar app.
                    OnboardingView()
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    tabBar
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)

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

    // MARK: - Tab bar

    private var tabBar: some View {
        HStack(spacing: 0) {
            // Workspaces leads — what users are most often here to do.
            tabButton(
                id: "workspaces",
                icon: "rectangle.stack.fill",
                title: "Workspaces",
                count: service.accounts.count
            )
            tabButton(
                id: "accounts",
                icon: "person.crop.circle.fill",
                title: "Accounts",
                count: service.vaultAccounts.count
            )
        }
        .padding(3)
        .background(Sweech.Color.surface.opacity(0.6))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Sweech.Color.core.opacity(0.15), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func tabButton(id: String, icon: String, title: String, count: Int) -> some View {
        let isSelected = tab == id
        return Button(action: { withAnimation(.easeInOut(duration: 0.15)) { tab = id } }) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                Text("\(count)")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(isSelected ? Sweech.Color.textPrimary.opacity(0.75) : Sweech.Color.textMuted)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background((isSelected ? Sweech.Color.core : Sweech.Color.textMuted).opacity(0.18))
                    .clipShape(Capsule())
            }
            .foregroundStyle(isSelected ? Sweech.Color.textPrimary : Sweech.Color.textMuted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(
                ZStack {
                    if isSelected {
                        RoundedRectangle(cornerRadius: 6)
                            .fill(Sweech.Color.core.opacity(0.22))
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(Sweech.Color.core.opacity(0.4), lineWidth: 1)
                    }
                }
            )
            // Hit-test the entire padded rect, not just the text+icon
            // glyphs. Without this, clicks in the gap between the icon
            // and the count capsule fall through to the background.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

// MARK: - Onboarding empty state

/// Shown when a user opens SweechBar before running `sweech init`. Two
/// empty grids tell the user nothing — this view names the next two
/// commands and launches them in Terminal on tap.
private struct OnboardingView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer(minLength: 8)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Sweech.Color.core)
                    Text("Welcome to sweech")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(Sweech.Color.textPrimary)
                }
                Text("No workspaces or accounts configured yet. Get started by running one of these:")
                    .font(.system(size: 11))
                    .foregroundStyle(Sweech.Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                onboardingRow(
                    icon: "wand.and.stars",
                    title: "sweech init",
                    subtitle: "Interactive setup wizard — pick CLIs, mount accounts, name workspaces.",
                    command: "sweech init"
                )
                onboardingRow(
                    icon: "tray.and.arrow.down.fill",
                    title: "sweech accounts import",
                    subtitle: "Discover existing ~/.claude and ~/.codex installs already on this machine.",
                    command: "sweech accounts import"
                )
            }

            Text("After running either command, hit the reload button (⟳) in the header to refresh.")
                .font(.system(size: 10))
                .foregroundStyle(Sweech.Color.textMuted.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One row per command — title + helper text + a "Run in Terminal…"
    /// button that hands off to `SweechService.launchInTerminal`.
    private func onboardingRow(icon: String, title: String, subtitle: String, command: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Sweech.Color.core)
                .frame(width: 22, height: 22)
                .background(Sweech.Color.core.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 5))

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Sweech.Color.textPrimary)
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(Sweech.Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            Button(action: {
                SweechService.launchInTerminal(commandName: command)
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "terminal.fill").font(.system(size: 10))
                    Text("Run in Terminal…").font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(Sweech.Color.core)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Sweech.Color.core.opacity(0.18))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Sweech.Color.core.opacity(0.35), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 6))
                // Whole capsule is the hit target, not just the glyphs.
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Opens Terminal.app with `\(command)` preloaded.")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sweech.Color.surface.opacity(0.85))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Sweech.Color.core.opacity(0.25), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

#Preview("Onboarding") {
    ZStack {
        Sweech.Gradient.backgroundRadial
        OnboardingView()
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
    }
    .frame(width: 540, height: 720)
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
            // OAuth identity sections — one grid per kind.
            ForEach(oauthGroups(), id: \.0) { kind, accounts in
                providerSection(key: kind, accounts: accounts)
            }
            // All external API-key providers in a single flowing grid so
            // single-tile providers sit side-by-side instead of each
            // taking a full row.
            let external = externalTiles()
            if !external.isEmpty {
                providerSection(key: "__providers__", accounts: external, header: "Providers")
            }
        }
    }

    private func oauthGroups() -> [(String, [VaultAccount])] {
        var groups: [(String, [VaultAccount])] = []
        let anthropic = service.vaultAccounts.filter { $0.kind == "anthropic" }
            .sorted { $0.email < $1.email }
        if !anthropic.isEmpty { groups.append(("anthropic", anthropic)) }
        let openai = service.vaultAccounts.filter { $0.kind == "openai" }
            .sorted { $0.email < $1.email }
        if !openai.isEmpty { groups.append(("openai", openai)) }
        return groups
    }

    /// One synthetic tile per unique external vendor in use, keyed by
    /// realProvider (so xortron/heretic localhost-litellm workspaces show
    /// up as "Local Proxy" rather than mistakenly inflating "Anthropic").
    /// Endpoint variants (kimi vs kimi-coding) collapse via canonicalKey.
    private func externalTiles() -> [VaultAccount] {
        var seen = Set<String>()
        var tiles: [VaultAccount] = []
        for ws in service.accounts where ws.isExternal {
            let canonical = canonicalProviderKey(ws.realProvider)
            if canonical.isEmpty || seen.contains(canonical) { continue }
            seen.insert(canonical)
            tiles.append(VaultAccount(
                accountId: "ext:\(canonical)",
                kind: canonical,
                email: TileStyle.label(kind: canonical),
                displayName: nil,
                plan: nil,
                rateLimitTier: nil,
                addedAt: "",
                lastRefreshedAt: nil,
                expiresAt: nil,
                status: nil
            ))
        }
        return tiles.sorted { $0.email < $1.email }
    }

    /// Collapse vendor variants so e.g. kimi + kimi-coding both surface
    /// as one "kimi" tile (same Moonshot key, different API endpoints).
    private func canonicalProviderKey(_ p: String) -> String {
        switch p {
        case "kimi-coding": return "kimi"
        // Ollama cloud and local-ollama are intentionally NOT collapsed:
        // cloud uses an API key + ollama.com endpoints, local-ollama
        // talks to the local daemon. Different auth, different surface.
        default: return p
        }
    }

    @ViewBuilder
    private func providerSection(key: String, accounts: [VaultAccount], header: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if header == nil {
                    Image(systemName: TileStyle.glyph(kind: key))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(TileStyle.tint(kind: key))
                }
                Text(header ?? TileStyle.label(kind: key))
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
                        mountedWorkspaces: mountedWorkspaces(for: account),
                        providerQuota: quotaFor(account),
                        onAssign: { onAssign(account) },
                        onReauth: { reauth(account) }
                    )
                }
            }
        }
    }

    /// Quota cache is keyed by exact effective-provider (e.g. "kimi-coding",
    /// "glm"); synthetic tiles use a canonical key (e.g. "kimi"). Look up
    /// the canonical first, then any non-canonical variant that maps to it.
    private func quotaFor(_ account: VaultAccount) -> ProviderQuota? {
        if let q = service.providerQuotas[account.kind] { return q }
        for (provKey, quota) in service.providerQuotas {
            if canonicalProviderKey(provKey) == account.kind { return quota }
        }
        return nil
    }

    private func mountedWorkspaces(for account: VaultAccount) -> [SweechAccount] {
        if account.accountId.hasPrefix("ext:") {
            // Match by realProvider (with the same canonicalisation used
            // for synthetic tiles) so a Kimi tile picks up both `kimi`
            // and `kimi-coding` workspaces.
            let canonicalKind = canonicalProviderKey(account.kind)
            return service.accounts.filter { canonicalProviderKey($0.realProvider) == canonicalKind }
        }
        return service.accounts.filter { $0.activeAccount?.id == account.id }
    }

    private func reauth(_ account: VaultAccount) {
        // Anthropic = re-run the PKCE flow which updates the existing
        // vault row by email. OpenAI = guide user through codex login +
        // import (sweech can't reproduce the ChatGPT-desktop OAuth app).
        switch account.kind {
        case "anthropic":
            SweechService.launchInTerminal(commandName: "sweech accounts add --kind anthropic")
        case "openai":
            SweechService.launchInTerminal(commandName: "codex login && sweech accounts import")
        default:
            break
        }
    }
}

// MARK: - Account tile

private struct AccountTile: View {
    let account: VaultAccount
    let mountedWorkspaces: [SweechAccount]
    let providerQuota: ProviderQuota?
    let onAssign: () -> Void
    let onReauth: () -> Void

    private var isExternal: Bool { account.accountId.hasPrefix("ext:") }
    private var tint: Color { TileStyle.tint(kind: account.kind) }
    private var glyph: String { TileStyle.glyph(kind: account.kind) }
    private var workspaceCount: Int { mountedWorkspaces.count }
    private var isMounted: Bool { workspaceCount > 0 }

    /// "expired" string from the vault, OR any mounted workspace flagged
    /// needsReauth, OR explicit org_disabled / unauthorized status.
    private var needsReauth: Bool {
        if account.expiryLabel == "expired" { return true }
        if let s = account.status, ["expired", "unauthorized", "org_disabled"].contains(s) { return true }
        if mountedWorkspaces.contains(where: { $0.needsReauth == true }) { return true }
        if liveProblemStatus != nil { return true }
        return false
    }

    /// Live status from any mounted workspace that supersedes the
    /// vault's cached plan ("Max 20x" can be stale if the org later
    /// disables OAuth — the live API returns 403, which liveUsage
    /// surfaces as org_disabled. Detect that here and show the right
    /// badge instead of the obsolete plan capsule).
    private var liveProblemStatus: String? {
        for ws in mountedWorkspaces {
            switch ws.live?.status {
            case "org_disabled":  return "OAuth disabled"
            case "unauthorized":  return "Re-login needed"
            case "forbidden":     return "Forbidden"
            case "limit_reached": return "Limit reached"
            default: continue
            }
        }
        return nil
    }

    /// Reauth itself is only achievable for OAuth-backed accounts.
    private var canReauth: Bool { !isExternal }

    /// First mounted workspace with live quota data, used to surface bars
    /// directly on the account tile (the OAuth identity's rate-limits are
    /// the same regardless of which workspace it's mounted in).
    private var representativeUsage: SweechAccount? {
        mountedWorkspaces.first(where: { $0.live != nil })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            identityRow
            badgesRow
            metaRow

            if let ws = representativeUsage {
                UsageBar(label: "5h", pct: ws.utilization5h, resetsIn: ws.reset5hRelative)
                UsageBar(label: "7d", pct: ws.utilization7d, resetsIn: ws.reset7dRelative)
            }

            if isExternal {
                quotaFooter
                if !mountedWorkspaces.isEmpty { workspacesRow }
            } else {
                workspacesRow
                actionRow
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sweech.Color.surface.opacity(0.85))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    needsReauth ? Sweech.Color.danger.opacity(0.45) : tint.opacity(0.25),
                    lineWidth: 1
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var identityRow: some View {
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
    }

    private var badgesRow: some View {
        HStack(spacing: 4) {
            // When a live workspace probe contradicts the vault's stored
            // plan (e.g. OAuth disabled by the org after the account was
            // imported), show the live status as a warning capsule
            // instead of the obsolete "Max 20x" / "Pro" plan.
            if let liveStatus = liveProblemStatus {
                Text(liveStatus)
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Sweech.Color.danger.opacity(0.18))
                    .clipShape(Capsule())
                    .foregroundStyle(Sweech.Color.danger)
            } else if let plan = account.plan {
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
            // Unassigned chip — a vault identity that isn't mounted in
            // any workspace is dead weight unless the user assigns it.
            // Visible chip makes the state scannable without reading
            // the "not assigned" sub-row below.
            if !isMounted && liveProblemStatus == nil {
                Text("Unassigned")
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Sweech.Color.warning.opacity(0.18))
                    .clipShape(Capsule())
                    .foregroundStyle(Sweech.Color.warning)
            }
            Spacer(minLength: 0)
        }
    }

    private var metaRow: some View {
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
        }
    }

    /// Comma-separated workspace names this account is mounted in.
    /// Empty when the account isn't assigned anywhere — the action row
    /// will say "Assign to workspace…" in that case.
    @ViewBuilder
    private var workspacesRow: some View {
        if workspaceCount > 0 {
            HStack(alignment: .top, spacing: 4) {
                Image(systemName: "rectangle.stack.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(tint)
                    .padding(.top, 1)
                Text(workspacesLabel)
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .foregroundStyle(Sweech.Color.textPrimary.opacity(0.9))
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .help(mountedWorkspaces.map { $0.commandName }.joined(separator: ", "))
                Spacer(minLength: 0)
            }
        } else {
            HStack(spacing: 4) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                Text("not assigned")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.7))
                Spacer(minLength: 0)
            }
        }
    }

    private var workspacesLabel: String {
        let names = mountedWorkspaces.map { $0.commandName }.sorted()
        if names.count <= 2 { return names.joined(separator: ", ") }
        return names.prefix(2).joined(separator: ", ") + " +\(names.count - 2)"
    }

    /// Adaptive action row:
    ///   - needsReauth → primary "Re-authenticate" (danger), secondary
    ///     "Change assignment" (tint) when already mounted.
    ///   - mounted but ok → "Change assignment"
    ///   - not mounted → "Assign to workspace…"
    @ViewBuilder
    private var actionRow: some View {
        if needsReauth && canReauth {
            HStack(spacing: 6) {
                tileButton(
                    icon: "arrow.clockwise.circle.fill",
                    title: "Re-authenticate",
                    color: Sweech.Color.danger,
                    action: onReauth
                )
                if isMounted {
                    tileButton(
                        icon: "plus.circle.fill",
                        title: "Add",
                        color: tint,
                        action: onAssign
                    )
                }
            }
        } else if isMounted {
            // Mounting is additive — one account can sit on N workspaces.
            // "Add to workspace…" reflects that the existing mount(s)
            // aren't touched; the sheet picks an additional target.
            tileButton(
                icon: "plus.circle.fill",
                title: "Add to workspace…",
                color: tint,
                action: onAssign
            )
        } else {
            tileButton(
                icon: "arrow.right.circle.fill",
                title: "Assign to workspace…",
                color: tint,
                action: onAssign
            )
        }
    }

    /// Quota footer for external API-key tiles. When the probe returned
    /// a dashboard URL hint (e.g. "check usage at z.ai/manage/usage"),
    /// the whole row becomes a button that opens the URL in the browser.
    @ViewBuilder
    private var quotaFooter: some View {
        if let q = providerQuota {
            if let summary = q.summary {
                let dashboardUrl = extractDashboardUrl(from: summary)
                if let url = dashboardUrl {
                    Button(action: { NSWorkspace.shared.open(url) }) {
                        footerRow(icon: q.balanceUsd != nil ? "dollarsign.circle.fill"
                                  : (q.rateLimit != nil ? "gauge.with.dots.needle.50percent" : "arrow.up.forward.app.fill"),
                                 summary: summary, reset: q.resetIn, underline: true)
                    }
                    .buttonStyle(.plain)
                    .help("Open \(url.absoluteString)")
                } else {
                    footerRow(icon: q.balanceUsd != nil ? "dollarsign.circle.fill"
                              : (q.rateLimit != nil ? "gauge.with.dots.needle.50percent" : "info.circle"),
                             summary: summary, reset: q.resetIn, underline: false)
                }
            }
            if let err = q.error {
                Text(err)
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.danger)
                    .lineLimit(1)
            }
        } else {
            Text("no quota probed yet")
                .font(.system(size: 9))
                .foregroundStyle(Sweech.Color.textMuted)
        }
    }

    private func footerRow(icon: String, summary: String, reset: String?, underline: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9))
                .foregroundStyle(tint)
            Text(summary)
                .font(.system(size: 9))
                .foregroundStyle(underline ? tint : Sweech.Color.textPrimary.opacity(0.9))
                .underline(underline, color: tint.opacity(0.5))
                .lineLimit(1)
            Spacer(minLength: 0)
            if let reset {
                Text("⏱ \(reset)")
                    .font(.system(size: 8))
                    .foregroundStyle(Sweech.Color.textMuted)
            }
        }
        // Whole row is the hit target, not just the text glyphs.
        .contentShape(Rectangle())
    }

    /// Promote bare hostnames embedded in dashboard hints (e.g.
    /// "check usage at z.ai/manage/usage") to a tappable URL. Returns
    /// nil for non-URL summaries (rate-limit %, balance $, …).
    private func extractDashboardUrl(from summary: String) -> URL? {
        // Hints follow the pattern: "<verb> at <host[/path]>".
        guard let atRange = summary.range(of: " at ") else { return nil }
        let tail = summary[atRange.upperBound...].trimmingCharacters(in: .whitespaces)
        if tail.isEmpty { return nil }
        // Anything starting with http(s)?: passes through; otherwise prepend https://.
        let full = tail.lowercased().hasPrefix("http") ? tail : "https://\(tail)"
        return URL(string: full)
    }

    private func tileButton(icon: String, title: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 10))
                Text(title).font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(color)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
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
        var ordered: [(String, [SweechAccount])] = []
        // Anthropic-class (claude) + OpenAI-class (codex) each get their
        // own labelled section.
        for key in ["claude", "codex"] {
            if let list = map.removeValue(forKey: key) {
                ordered.append((key, list))
            }
        }
        // Every other workspace (kimi, glm, minimax, dashscope, ollama,
        // openrouter, …) is collapsed into a single "Providers" section
        // so single-workspace providers don't each take a full row.
        let externalKeys = map.keys.sorted()
        if !externalKeys.isEmpty {
            let merged = externalKeys.flatMap { map[$0]! }
            ordered.append(("__providers__", merged))
        }
        return ordered
    }

    @ViewBuilder
    private func providerSection(key: String, workspaces: [SweechAccount]) -> some View {
        let isMerged = key == "__providers__"
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if !isMerged {
                    Image(systemName: TileStyle.glyph(kind: key))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(TileStyle.tint(kind: key))
                }
                Text(isMerged ? "Providers" : TileStyle.label(kind: key))
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
    private var kind: String {
        // Use realProvider so proxy workspaces are coloured + glyphed
        // by their actual upstream vendor (local-proxy / glm / etc),
        // not by the API format their config happens to label them.
        if ws.isExternal { return ws.realProvider }
        return cliType == "claude" ? "anthropic" : "openai"
    }
    private var tint: Color { TileStyle.tint(kind: kind) }
    private var glyph: String { TileStyle.glyph(kind: kind) }
    private var activeId: String? { ws.activeAccount?.id }

    /// Workspace status problems we want loud in the badge row.
    /// Order matters — first match wins so we don't stack three red capsules.
    private var problemBadge: (label: String, color: Color)? {
        // OAuth-style workspace with nothing in `.sweech-account`.
        if !ws.isExternal && ws.activeAccount == nil {
            return ("No account", Sweech.Color.danger)
        }
        if ws.needsReauth == true {
            return ("Re-auth", Sweech.Color.danger)
        }
        // External (API-key) workspace with no key in keychain.
        if ws.isExternal && ws.live?.status == "no_api_key" {
            return ("No API key", Sweech.Color.danger)
        }
        switch ws.live?.status {
        case "org_disabled":  return ("OAuth disabled", Sweech.Color.danger)
        case "unauthorized":  return ("Re-login",       Sweech.Color.danger)
        case "forbidden":     return ("Forbidden",      Sweech.Color.danger)
        case "limit_reached": return ("Limit reached",  Sweech.Color.danger)
        default: return nil
        }
    }

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
            }

            // Badges. A live problem (no account / re-auth / OAuth disabled
            // …) replaces the plan capsule so the warning is visually
            // dominant instead of crowded next to a stale "Max 20x".
            HStack(spacing: 4) {
                Text(TileStyle.label(kind: kind))
                    .font(.system(size: 9, weight: .bold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(tint.opacity(0.15))
                    .clipShape(Capsule())
                    .foregroundStyle(tint)
                if let problem = problemBadge {
                    Text(problem.label)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(problem.color.opacity(0.18))
                        .clipShape(Capsule())
                        .foregroundStyle(problem.color)
                } else if let plan = ws.planType {
                    Text(plan)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Sweech.Color.core.opacity(0.15))
                        .clipShape(Capsule())
                        .foregroundStyle(Sweech.Color.core)
                }
                Spacer(minLength: 0)
            }

            // Usage bars / external label. When we know *why* there's no
            // live data, say so instead of a generic "no live data".
            if ws.live != nil {
                UsageBar(label: "5h", pct: ws.utilization5h, resetsIn: ws.reset5hRelative)
                UsageBar(label: "7d", pct: ws.utilization7d, resetsIn: ws.reset7dRelative)
            } else if !ws.isExternal && ws.activeAccount == nil {
                Text("assign an account to use this workspace")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.danger.opacity(0.85))
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
                    // Tint the footer label with the provider's own
                    // colour so the bottom of the tile echoes the badge
                    // at the top — at a glance the whole card reads as
                    // belonging to that vendor.
                    Text(ws.providerLabel)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(tint)
                } else {
                    accountMenu
                }
                Spacer(minLength: 0)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Sweech.Color.surface.opacity(0.85))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    problemBadge != nil ? Sweech.Color.danger.opacity(0.45) : tint.opacity(0.25),
                    lineWidth: 1
                )
        )
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
    let resetsIn: String?

    var body: some View {
        let clamped = max(0, min(pct, 1))
        let color: Color = clamped >= 0.9 ? Sweech.Color.danger : (clamped >= 0.7 ? Sweech.Color.warning : Sweech.Color.ok)
        return VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
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
            if let resetsIn, !resetsIn.isEmpty {
                HStack(spacing: 4) {
                    Spacer().frame(width: 16)
                    Image(systemName: "clock")
                        .font(.system(size: 7))
                        .foregroundStyle(Sweech.Color.textMuted)
                    Text("resets in \(resetsIn)")
                        .font(.system(size: 8))
                        .foregroundStyle(Sweech.Color.textMuted)
                    Spacer(minLength: 0)
                }
            }
        }
    }
}

// MARK: - Provider style centralisation

private enum TileStyle {
    static func glyph(kind: String) -> String {
        switch kind {
        case "anthropic", "claude": return "a.circle.fill"
        case "openai", "codex":     return "o.circle.fill"
        case "local-proxy":         return "house.fill"
        case "kimi", "kimi-coding": return "k.circle.fill"
        case "glm":                 return "g.circle.fill"
        case "minimax":             return "m.circle.fill"
        case "dashscope":           return "q.circle.fill"
        case "ollama", "ollama-cloud", "local-ollama": return "cube.fill"
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
        case "local-proxy":         return Color(hex: "#94A3B8")
        case "kimi", "kimi-coding": return Color(hex: "#7DD3FC")
        case "glm":                 return Color(hex: "#A78BFA")
        case "minimax":             return Color(hex: "#F472B6")
        case "dashscope":           return Color(hex: "#FB923C")
        case "ollama-cloud":        return Color(hex: "#94A3B8")
        // Local ollama gets a warmer tint than ollama-cloud so the
        // two are visually distinct even before the label is read.
        case "ollama", "local-ollama": return Color(hex: "#34D399")
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
        case "local-proxy":         return "Local Proxy"
        case "kimi":                return "Kimi"
        case "kimi-coding":         return "Kimi Coding"
        case "glm":                 return "GLM"
        case "minimax":             return "MiniMax"
        case "dashscope":           return "Alibaba"
        case "openrouter":          return "OpenRouter"
        case "deepseek":            return "DeepSeek"
        case "qwen":                return "Qwen"
        case "ollama":              return "Ollama"
        case "local-ollama":        return "Ollama (Local)"
        case "ollama-cloud":        return "Ollama Cloud"
        case "nvidia":              return "NVIDIA"
        case "gemini":              return "Gemini"
        case "groq":                return "Groq"
        default:                    return kind.capitalized
        }
    }
}
