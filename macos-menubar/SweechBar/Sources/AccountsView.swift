import SwiftUI
import AppKit

// MARK: - Card Tier

enum CardTier {
    case useFirst(urgent: Bool) // rank 0 — urgent=true if expiry <72h with ≥5% remaining
    case useNext                // rank 1
    case normal                 // rank 2+
    case limitReached
    case needsReauth

    var borderColor: Color {
        switch self {
        case .useFirst(let urgent): return urgent ? Sweech.Color.warning : Sweech.Color.ok
        case .useNext:              return Sweech.Color.accent
        case .normal:               return Sweech.Color.core.opacity(0.12)
        case .limitReached:         return Sweech.Color.danger.opacity(0.4)
        case .needsReauth:          return Sweech.Color.warm.opacity(0.5)
        }
    }

    var borderWidth: CGFloat {
        switch self {
        case .useFirst:                        return 1.5
        case .useNext:                         return 1.0
        case .normal, .limitReached, .needsReauth: return 0.5
        }
    }

    var glowColor: Color {
        switch self {
        case .useFirst(let urgent): return (urgent ? Sweech.Color.warning : Sweech.Color.ok).opacity(0.15)
        case .useNext:              return Sweech.Color.accent.opacity(0.08)
        default:                    return .clear
        }
    }

    var glowRadius: CGFloat {
        switch self {
        case .useFirst: return 10
        case .useNext:  return 6
        default:        return 0
        }
    }

    var badgeLabel: String? {
        switch self {
        case .useFirst: return "use first"
        case .useNext:  return "use next"
        default:        return nil
        }
    }

    var badgeIcon: String {
        switch self {
        case .useFirst: return "bolt.fill"
        case .useNext:  return "arrow.right"
        default:        return ""
        }
    }

    var badgeColor: Color {
        switch self {
        case .useFirst(let urgent): return urgent ? Sweech.Color.warning : Sweech.Color.ok
        case .useNext:              return Sweech.Color.accent
        default:                    return .clear
        }
    }

    var badgeHelp: String {
        switch self {
        case .useFirst(let urgent):
            return urgent
                ? "Use this account NOW — it has ≥5% weekly quota remaining but resets in under 72h. Unused quota will be wasted."
                : "Top-ranked account by smart sort — best ratio of remaining quota to time until reset."
        case .useNext:
            return "Second-best choice — use after the 'use first' account is exhausted or at its limit."
        default:
            return ""
        }
    }
}

// MARK: - Accounts View

struct AccountsView: View {
    @ObservedObject var service: SweechService

    @AppStorage("sweechSortMode")   private var sortMode: String = "smart"
    @AppStorage("sweechGrouped")    private var grouped: Bool = true
    @AppStorage("sweechCompact")    private var compact: Bool = false
    @AppStorage("sweechMiniMode")   private var miniMode: Bool = false
    @AppStorage("sweechAppearance") private var appearance: String = "system"  // "system", "light", "dark"
    @State private var showGuide    = false
    @State private var showSettings = false
    @State private var showProfileManager = false
    @State private var quickManageAccount: SweechAccount?
    @State private var quickManageMode: ProfileQuickManageMode = .manage
    @State private var removalCandidate: SweechAccount?
    @State private var miniExpanded = false

    // Raw account groups — by display group (claude / codex / external providers)
    private var rawClaude: [SweechAccount] {
        service.sortedAccounts.filter { $0.displayGroup == "claude" }
    }
    private var rawCodex: [SweechAccount] {
        service.sortedAccounts.filter { $0.displayGroup == "codex" }
    }
    private var rawExternal: [SweechAccount] {
        service.sortedAccounts.filter { $0.isExternal }
    }

    /// Distinct group names among external providers (e.g. ["Alibaba Cloud", "MiniMax"])
    private var externalGroupNames: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for a in rawExternal {
            let g = a.displayGroup
            if seen.insert(g).inserted { result.append(g) }
        }
        return result
    }

    private var hasMultipleGroups: Bool {
        let groupCount = (rawClaude.isEmpty ? 0 : 1) + (rawCodex.isEmpty ? 0 : 1) + externalGroupNames.count
        return groupCount > 1
    }

    // Sorting
    private func apply(sort: String, to accounts: [SweechAccount]) -> [SweechAccount] {
        switch sort {
        case "smart":
            // Use precomputed sortRank from CLI when available (single source of truth)
            if accounts.allSatisfy({ $0.sortRank != nil }) {
                return accounts.sorted { ($0.sortRank ?? 999) < ($1.sortRank ?? 999) }
            }
            return accounts.sorted { $0.smartScore > $1.smartScore }
        case "status": return accounts.sorted { statusRank($0) < statusRank($1) }
        default:       return accounts
        }
    }

    private func statusRank(_ a: SweechAccount) -> Int {
        if a.needsReauth == true            { return 4 }
        if a.liveStatus == "limit_reached"  { return 3 }
        if a.liveStatus == "warning"        { return 2 }
        if a.liveStatus == "allowed"        { return 0 }
        return 1
    }

    private var sortedClaude: [SweechAccount] { apply(sort: sortMode, to: rawClaude) }
    private var sortedCodex:  [SweechAccount] { apply(sort: sortMode, to: rawCodex) }
    private var sortedExternal: [SweechAccount] { apply(sort: sortMode, to: rawExternal) }
    private func sortedForGroup(_ name: String) -> [SweechAccount] {
        apply(sort: sortMode, to: rawExternal.filter { $0.displayGroup == name })
    }
    private var sortedAll:    [SweechAccount] { apply(sort: sortMode, to: service.sortedAccounts) }

    /// Mini mode is active when the toggle is on and the user hasn't tapped "Show all"
    private var activeMiniMode: Bool { miniMode && !miniExpanded }

    // Tier
    private func hasExpiryUrgency(_ a: SweechAccount) -> Bool {
        guard let epoch = a.live?.reset7dAt else { return false }
        let hoursLeft = Date(timeIntervalSince1970: epoch).timeIntervalSince(Date()) / 3600
        return (1.0 - a.utilization7d) > 0 && hoursLeft > 0 && hoursLeft < 72
    }

    private func tier(for account: SweechAccount, rank: Int) -> CardTier {
        if account.needsReauth == true           { return .needsReauth }
        if account.liveStatus == "limit_reached" { return .limitReached }
        guard sortMode == "smart" else { return .normal }

        // Use precomputed tier from CLI when available (single source of truth)
        if let t = account.tier {
            switch t {
            case "use_first": return .useFirst(urgent: account.tierUrgent ?? false)
            case "use_next":  return .useNext
            default:          return .normal
            }
        }

        // Fallback for older CLI versions
        guard account.live != nil else { return .normal }
        switch rank {
        case 0:  return .useFirst(urgent: hasExpiryUrgency(account))
        case 1:  return .useNext
        default: return .normal
        }
    }

    var body: some View {
        ZStack {
            Sweech.Gradient.backgroundRadial.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Divider().overlay(Sweech.Color.core.opacity(0.2))

                if service.accounts.isEmpty && !service.isConnected {
                    disconnectedView
                } else if activeMiniMode {
                    miniLayout
                } else if hasMultipleGroups && grouped {
                    groupedLayout
                } else {
                    singleColumnLayout
                }

                Divider().overlay(Sweech.Color.core.opacity(0.1))
                footer
            }
            .onAppear {
                service.fetch()
                miniExpanded = false  // Reset mini expansion on each popover open
                if ProcessInfo.processInfo.environment["SWEECHBAR_OPEN_PROFILE_MANAGER"] == "1" {
                    showProfileManager = true
                }
            }

            if let removalCandidate {
                ProfileDeleteConfirmationOverlay(
                    commandName: removalCandidate.commandName,
                    message: "This removes the Sweech-managed profile from your current setup.",
                    onCancel: { self.removalCandidate = nil },
                    onDelete: {
                        let commandName = removalCandidate.commandName
                        self.removalCandidate = nil
                        service.removeProfile(commandName: commandName, forceDependents: true)
                    }
                )
                .zIndex(10)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: popoverWidth)
        .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
        .background(KeyboardShortcuts(
            onRefresh: { service.fetch() },
            onCycleSort: {
                let modes = ["smart", "status", "manual"]
                let idx = modes.firstIndex(of: sortMode) ?? 0
                sortMode = modes[(idx + 1) % modes.count]
            },
            onToggleGroup: { grouped.toggle() },
            onToggleGuide: { showGuide.toggle() },
            onToggleSettings: { showSettings.toggle() }
        ))
        .sheet(isPresented: $showProfileManager) {
            ProfileManagerView(service: service)
                .onAppear { service.loadProfileManagementOptions() }
        }
        .sheet(item: $quickManageAccount) { account in
            ProfileQuickManageView(
                service: service,
                account: account,
                initialMode: quickManageMode,
                onOpenFullManager: {
                    quickManageAccount = nil
                    showProfileManager = true
                }
            )
        }
    }

    // MARK: Layouts

    private var cardTransition: AnyTransition {
        .asymmetric(
            insertion: .opacity.combined(with: .move(edge: .top)),
            removal: .opacity
        )
    }

    private var groupedColumns: [[(title: String, accounts: [SweechAccount])]] {
        GroupedColumnLayout.buildColumns(
            claude: sortedClaude,
            codex: sortedCodex,
            externalGroups: externalGroupNames.map { name in
                GroupedColumnSection(title: name, items: sortedForGroup(name))
            }
        )
        .map { column in
            column.map { (title: $0.title, accounts: $0.items) }
        }
    }

    private var groupedColumnCount: Int {
        groupedColumns.count
    }

    /// Popover width scales with column count so columns never get clipped.
    /// Each card column needs ~280pt + 10pt spacing; plus 32pt for outer padding and scroll gutter.
    private var popoverWidth: CGFloat {
        if activeMiniMode { return 360 }
        if !hasMultipleGroups || !grouped { return 360 }
        let n = max(1, groupedColumnCount)
        let computed = CGFloat(n) * 290 + CGFloat(max(0, n - 1)) * 10 + 32
        return min(max(computed, 680), 1280)
    }

    private var groupedLayout: some View {
        ScrollView {
            VStack(spacing: 10) {
                summaryHeader

                let cols = groupedColumns
                HStack(alignment: .top, spacing: 10) {
                    ForEach(Array(cols.enumerated()), id: \.offset) { _, column in
                        if !column.isEmpty {
                            VStack(spacing: 12) {
                                ForEach(Array(column.enumerated()), id: \.offset) { _, group in
                                    VStack(spacing: 8) {
                                        columnHeader(title: group.0, count: group.1.count)
                                            .help("\(group.1.count) \(group.0) account(s) — sorted by \(sortMode) mode")
                                        ForEach(Array(group.1.enumerated()), id: \.element.id) { i, account in
                                            accountCard(account, rank: i)
                                                .transition(cardTransition)
                                        }
                                    }
                                }
                            }
                            .frame(minWidth: 260, maxWidth: .infinity)
                            .animation(Sweech.Animation.medium, value: sortMode)
                        }
                    }
                }
                .padding(.horizontal, 4)
            }
            .padding(12)
        }
        .frame(maxHeight: 800)
    }

    private var singleColumnLayout: some View {
        ScrollView {
            VStack(spacing: 8) {
                summaryHeader
                ForEach(Array(sortedAll.enumerated()), id: \.element.id) { i, account in
                    accountCard(
                        account,
                        rank: i,
                        onMoveUp: sortMode == "manual" && i > 0
                            ? { service.moveAccount(from: IndexSet(integer: i), to: i - 1) } : nil,
                        onMoveDown: sortMode == "manual" && i < sortedAll.count - 1
                            ? { service.moveAccount(from: IndexSet(integer: i), to: i + 2) } : nil
                    )
                    .transition(cardTransition)
                }
            }
            .padding(12)
            .animation(Sweech.Animation.medium, value: sortMode)
        }
    }

    private func accountCard(
        _ account: SweechAccount,
        rank: Int,
        onMoveUp: (() -> Void)? = nil,
        onMoveDown: (() -> Void)? = nil
    ) -> some View {
        AccountCard(
            account: account,
            tier: tier(for: account, rank: rank),
            onManage: {
                quickManageMode = .manage
                quickManageAccount = account
            },
            onRenameProfile: account.isDefaultAccount ? nil : {
                quickManageMode = .rename
                quickManageAccount = account
            },
            onRemoveProfile: account.isDefaultAccount ? nil : {
                removalCandidate = account
            },
            onMoveUp: onMoveUp,
            onMoveDown: onMoveDown
        )
    }

    // MARK: Mini Layout (T-024)

    private var miniLayout: some View {
        VStack(spacing: 8) {
            // Show only the top 2 recommended accounts
            let topAccounts = Array(sortedAll.prefix(2))
            ForEach(Array(topAccounts.enumerated()), id: \.element.id) { i, account in
                MiniAccountCard(account: account, tier: tier(for: account, rank: i))
                    .transition(cardTransition)
            }
            .animation(Sweech.Animation.medium, value: sortMode)

            // "Show all" button
            Button {
                withAnimation(Sweech.Animation.medium) {
                    miniExpanded = true
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                    Text("Show all \(service.accounts.count) accounts")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(Sweech.Color.accent)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(Sweech.Color.accent.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .help("Expand to show all accounts")
        }
        .padding(12)
    }

    // MARK: Sub-views

    private func columnHeader(title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundStyle(Sweech.Color.accent)
            Text("\(count)")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Sweech.Color.textMuted)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Sweech.Color.surfaceHigh)
                .clipShape(Capsule())
            Spacer()
        }
    }

    private var disconnectedView: some View {
        VStack(spacing: 8) {
            Image(systemName: "network.slash")
                .font(.system(size: 24))
                .foregroundStyle(Sweech.Color.textMuted)
            Text("Not connected")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Sweech.Color.textPrimary)
            if let err = service.lastError {
                Text(err)
                    .font(.system(size: 10))
                    .foregroundStyle(Sweech.Color.textMuted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            }
        }
        .padding(30)
        .help("SweechBar cannot reach the sweech daemon. Try: ⋯ → Restart Daemon, or run `sweech serve` in your terminal.")
    }

    private var summaryHeader: some View {
        let total = service.accounts.count
        let available = service.accounts.filter { $0.liveStatus != "limit_reached" }.count
        return HStack(spacing: 8) {
            Text("\(available) of \(total) accounts available")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Sweech.Color.textPrimary)
                .help("\(total - available) account(s) are currently at their rate limit. The remaining \(available) can accept requests.")

            Spacer()

            // Sort indicator
            HStack(spacing: 4) {
                Image(systemName: sortMode == "smart" ? "bolt.fill" : sortMode == "status" ? "circle.fill" : "hand.draw")
                    .font(.system(size: 9))
                Text(sortMode)
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
            .help(sortMode == "smart"
                ? "Smart sort: accounts ranked by weekly quota remaining ÷ days until reset. Use the top card first."
                : sortMode == "status"
                ? "Status sort: available accounts first, then warning, then limit reached."
                : "Manual sort: drag cards in the list to reorder.")

            // Guide button
            Button {
                showGuide.toggle()
            } label: {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 13))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
            }
            .buttonStyle(.plain)
            .help("Open guide — explains card colors, smart sort, and usage windows")
            .popover(isPresented: $showGuide, arrowEdge: .bottom) {
                GuideView()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("🍭")
                .font(.system(size: 18))
            Text("sweech")
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundStyle(Sweech.Color.textPrimary)

            if service.updateAvailable, let latest = service.latestVersion {
                Text("v\(latest)")
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Sweech.Color.accent)
                    .clipShape(Capsule())
                    .help("Update available: \(service.currentVersion ?? "?") → \(latest). Run `sweech update` to install.")
            }

            Spacer()

            Circle()
                .fill(service.isConnected ? Sweech.Color.ok : Sweech.Color.danger)
                .frame(width: 7, height: 7)
                .help(service.isConnected
                    ? "Connected to sweech daemon — data is live"
                    : "Cannot reach sweech daemon — check that it's running with `sweech serve`")
                .accessibilityLabel(service.isConnected ? "Connected" : "Disconnected")

            Button(action: { service.fetch() }) {
                Group {
                    if service.isFetching {
                        ProgressView()
                            .progressViewStyle(.circular)
                            .scaleEffect(0.6)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12))
                            .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                    }
                }
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(service.isFetching)
            .help("Reload usage data from all accounts (auto-refreshes every 30s)")
            .accessibilityLabel(service.isFetching ? "Refreshing data" : "Refresh data")

            Button {
                showSettings.toggle()
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 12))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Preferences")
            .popover(isPresented: $showSettings, arrowEdge: .top) {
                SettingsView(service: service)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var lastFetchedText: String {
        guard let date = service.lastFetched else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "Updated just now" }
        return "Updated \(seconds / 60)m ago"
    }

    private var footer: some View {
        HStack {
            Text("v0.2.0")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                .help("SweechBar v0.2.0")

            if !lastFetchedText.isEmpty {
                Text("·")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.5))
                Text(lastFetchedText)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                    .help("Data auto-refreshes every 30 seconds")
            }

            Spacer()

            Menu {
                Button { service.fetch() } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                .disabled(service.isFetching)

                Divider()

                Button { sortMode = "smart" } label: {
                    Label(sortMode == "smart" ? "✓ Smart (expiry-first)" : "Smart (expiry-first)", systemImage: "bolt.fill")
                }
                Button { sortMode = "status" } label: {
                    Label(sortMode == "status" ? "✓ By status" : "By status", systemImage: "circle.fill")
                }
                Button { sortMode = "manual" } label: {
                    Label(sortMode == "manual" ? "✓ Manual" : "Manual", systemImage: "hand.draw")
                }

                Divider()

                if hasMultipleGroups {
                    Button { grouped.toggle() } label: {
                        Label(grouped ? "Ungroup providers" : "Group by provider",
                              systemImage: grouped ? "rectangle.split.2x1" : "square.grid.2x2")
                    }
                    Divider()
                }

                Button { showProfileManager = true } label: {
                    Label("Manage Profiles", systemImage: "person.crop.circle.badge.plus")
                }

                Divider()

                Menu {
                    Button { appearance = "system" } label: {
                        Label(appearance == "system" ? "✓ System" : "System", systemImage: "circle.lefthalf.filled")
                    }
                    Button { appearance = "light" } label: {
                        Label(appearance == "light" ? "✓ Light" : "Light", systemImage: "sun.max")
                    }
                    Button { appearance = "dark" } label: {
                        Label(appearance == "dark" ? "✓ Dark" : "Dark", systemImage: "moon")
                    }
                } label: {
                    Label("Appearance", systemImage: "paintbrush")
                }

                Divider()

                Button { service.setLaunchAtLogin(!service.launchAtLogin) } label: {
                    Label(service.launchAtLogin ? "Remove from Login Items" : "Launch at Login",
                          systemImage: service.launchAtLogin ? "checkmark.circle.fill" : "circle")
                }

                Button { service.restartDaemon() } label: {
                    Label("Restart Daemon", systemImage: "arrow.counterclockwise.circle")
                }

                Divider()

                Button(role: .destructive) { NSApp.terminate(nil) } label: {
                    Label("Quit SweechBar", systemImage: "xmark.circle")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.5))
                    .padding(8)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Sort, profile, and app settings")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

// MARK: - Guide View

struct GuideView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("SweechBar Guide")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(Sweech.Color.textPrimary)
                    .padding(.bottom, 2)

                guideSection(
                    icon: "square.stack", iconColor: Sweech.Color.core,
                    title: "Card Border Colors"
                ) {
                    tierRow(color: Sweech.Color.ok, width: 1.5,
                            label: "use first", desc: "Best account — top smart score, no urgent expiry")
                    tierRow(color: Sweech.Color.warning, width: 1.5,
                            label: "use first ⚡", desc: "≥5% weekly quota expiring in <72h — use it or lose it")
                    tierRow(color: Sweech.Color.accent, width: 1.0,
                            label: "use next", desc: "Second-best choice by smart sort")
                    tierRow(color: Sweech.Color.core.opacity(0.3), width: 0.5,
                            label: "available", desc: "Normal — no urgency signal")
                    tierRow(color: Sweech.Color.danger.opacity(0.5), width: 0.5,
                            label: "limit reached", desc: "5h window full — blocked until reset")
                    tierRow(color: Sweech.Color.warm.opacity(0.6), width: 0.5,
                            label: "needs re-auth", desc: "Run: sweech auth <name>")
                }

                guideSection(
                    icon: "bolt.fill", iconColor: Sweech.Color.warning,
                    title: "Smart Sort Algorithm"
                ) {
                    Text("Ranks accounts by how urgent it is to use their expiring weekly quota:")
                        .font(.system(size: 12))
                        .foregroundStyle(Sweech.Color.textPrimary.opacity(0.85))
                    Text("score = weekly_remaining ÷ days_until_reset")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Sweech.Color.glow)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(Sweech.Color.background.opacity(0.6))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    Text("60% remaining with 1 day left scores 3× higher than 60% with 3 days left. Limit-reached and needs-reauth accounts always sort to the bottom.")
                        .font(.system(size: 12))
                        .foregroundStyle(Sweech.Color.textMuted)
                }

                guideSection(
                    icon: "clock.arrow.2.circlepath", iconColor: Sweech.Color.accent,
                    title: "5h vs Week Windows"
                ) {
                    windowRow(label: "5h", color: Sweech.Color.accent,
                              desc: "5-hour rolling window. Anthropic's primary rate limit. Resets from your oldest message — not at a fixed time.")
                    windowRow(label: "week", color: Sweech.Color.core,
                              desc: "7-day rolling window. Resets once per week from your subscription start date. Unused quota expires — it does not carry over.")
                    Text("You can be blocked on the 5h window but still have weekly quota. The 5h block lifts automatically once the oldest message rolls out of the window.")
                        .font(.system(size: 11))
                        .foregroundStyle(Sweech.Color.textMuted)
                        .padding(.top, 2)
                }

                guideSection(
                    icon: "chart.bar.fill", iconColor: Sweech.Color.ok,
                    title: "Usage Bar Colors"
                ) {
                    barRow(color: Sweech.Color.ok,      range: "0–40%",   label: "Comfortable")
                    barRow(color: Sweech.Color.warm,    range: "40–70%",  label: "Moderate")
                    barRow(color: Sweech.Color.warning, range: "70–90%",  label: "High — 🔥 icon shown")
                    barRow(color: Sweech.Color.danger,  range: "90–100%", label: "Critical — ⚠ icon shown")
                }

                guideSection(
                    icon: "keyboard", iconColor: Sweech.Color.accent,
                    title: "Keyboard Shortcuts"
                ) {
                    cliRow(cmd: "r", desc: "Refresh usage data")
                    cliRow(cmd: "s", desc: "Cycle sort mode")
                    cliRow(cmd: "g", desc: "Toggle grouped/flat layout")
                    cliRow(cmd: "?", desc: "Toggle this guide")
                    cliRow(cmd: ",", desc: "Toggle settings")
                }

                guideSection(
                    icon: "terminal", iconColor: Sweech.Color.textMuted,
                    title: "CLI Quick Reference"
                ) {
                    cliRow(cmd: "sweech",             desc: "Interactive launcher")
                    cliRow(cmd: "sweech usage",       desc: "View usage in terminal")
                    cliRow(cmd: "sweech usage -m",    desc: "Show per-model breakdown")
                    cliRow(cmd: "sweech auth <name>", desc: "Re-authenticate expired token")
                    cliRow(cmd: "sweech ls",          desc: "List all configured accounts")
                    cliRow(cmd: "sweech doctor",      desc: "Health check")
                }
            }
            .padding(16)
        }
        .frame(width: 340)
        .background(Sweech.Color.surface)
    }

    // Guide section card
    private func guideSection<Content: View>(
        icon: String, iconColor: Color, title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(iconColor)
                Text(title)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Sweech.Color.textPrimary)
            }
            VStack(alignment: .leading, spacing: 7) {
                content()
            }
        }
        .padding(12)
        .background(Sweech.Color.surfaceHigh)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func tierRow(color: Color, width: CGFloat, label: String, desc: String) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 3)
                .stroke(color, lineWidth: width)
                .frame(width: 28, height: 18)
                .overlay(RoundedRectangle(cornerRadius: 3).fill(color.opacity(0.08)))
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(color)
                Text(desc)
                    .font(.system(size: 10))
                    .foregroundStyle(Sweech.Color.textMuted)
            }
        }
    }

    private func windowRow(label: String, color: Color, desc: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(color)
                .frame(width: 34, alignment: .leading)
            Text(desc)
                .font(.system(size: 11))
                .foregroundStyle(Sweech.Color.textPrimary.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func barRow(color: Color, range: String, label: String) -> some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 3)
                .fill(color)
                .frame(width: 40, height: 6)
            Text(range)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(Sweech.Color.textMuted)
                .frame(width: 50, alignment: .leading)
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Sweech.Color.textPrimary.opacity(0.8))
        }
    }

    private func cliRow(cmd: String, desc: String) -> some View {
        HStack(spacing: 0) {
            Text(cmd)
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundStyle(Sweech.Color.glow)
                .frame(width: 170, alignment: .leading)
            Text(desc)
                .font(.system(size: 10))
                .foregroundStyle(Sweech.Color.textMuted)
        }
    }
}

// MARK: - Account Card

struct AccountCard: View {
    let account: SweechAccount
    var tier: CardTier = .normal
    var onManage: (() -> Void)? = nil
    var onRenameProfile: (() -> Void)? = nil
    var onRemoveProfile: (() -> Void)? = nil
    var onMoveUp:   (() -> Void)? = nil
    var onMoveDown: (() -> Void)? = nil

    @State private var copied = false
    @State private var isHovered = false
    @AppStorage("sweechShowExtraBuckets") private var showExtraBuckets: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                // Account name — tap to copy launch command
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("sweech use \(account.commandName)", forType: .string)
                    withAnimation { copied = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        withAnimation { copied = false }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(account.name)
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Sweech.Color.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1)
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 9))
                            .foregroundStyle(copied ? Sweech.Color.ok : Sweech.Color.textMuted.opacity(0.3))
                    }
                }
                .buttonStyle(.plain)
                .help("Tap to copy: sweech use \(account.commandName)")

                if account.isExternal {
                    Text(account.providerLabel)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Sweech.Color.warm)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Sweech.Color.warm.opacity(0.1))
                        .clipShape(Capsule())
                        .help("\(account.providerLabel) — via Claude Code CLI")
                } else if let cliType = account.cliType {
                    Text(cliType)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Sweech.Color.accent)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Sweech.Color.accent.opacity(0.1))
                        .clipShape(Capsule())
                        .help(cliType == "claude" ? "Claude Code CLI profile" : "OpenAI Codex CLI profile")
                }

                if let plan = account.planType {
                    Text(plan)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Sweech.Color.core)
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Sweech.Color.core.opacity(0.1))
                        .clipShape(Capsule())
                        .help("Subscription plan: \(plan)")
                }

                if let promo = account.live?.promotion {
                    HStack(spacing: 3) {
                        Image(systemName: "sparkles").font(.system(size: 8))
                        Text(promo.label)
                            .font(.system(size: 9, weight: .bold))
                            .lineLimit(1)
                    }
                    .fixedSize()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(
                        LinearGradient(colors: [Sweech.Color.accent, Sweech.Color.core], startPoint: .leading, endPoint: .trailing)
                    )
                    .clipShape(Capsule())
                    .help(promo.expiresAt.map { "Promotion active — expires \(Date(timeIntervalSince1970: $0 / 1000).formatted())" } ?? "Promotion active")
                }

                if let label = tier.badgeLabel {
                    HStack(spacing: 3) {
                        Image(systemName: tier.badgeIcon).font(.system(size: 8))
                        Text(label)
                            .font(.system(size: 9, weight: .bold))
                            .lineLimit(1)
                    }
                    .fixedSize()
                    .foregroundStyle(tier.badgeColor)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(tier.badgeColor.opacity(0.12))
                    .clipShape(Capsule())
                    .help(tier.badgeHelp)
                }

                Spacer()
                StatusPill(account: account)

                if onManage != nil || onRenameProfile != nil || onRemoveProfile != nil {
                    Menu {
                        if let onManage {
                            Button(action: onManage) {
                                Label("Manage Profile", systemImage: "ellipsis.circle")
                            }
                        }

                        if let onRenameProfile {
                            Button(action: onRenameProfile) {
                                Label("Rename Profile", systemImage: "pencil")
                            }
                        }

                        Button {
                            SweechService.launchInTerminal(commandName: "sweech auth \(account.commandName)")
                        } label: {
                            Label("Re-authenticate", systemImage: "key")
                        }

                        if let onRemoveProfile {
                            Divider()
                            Button(role: .destructive, action: onRemoveProfile) {
                                Label("Delete Profile", systemImage: "trash")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 13))
                            .foregroundStyle(Sweech.Color.textMuted.opacity(0.65))
                            .frame(width: 20, height: 20)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Profile actions for \(account.commandName)")
                }
            }

            // Reauth warning
            if account.needsReauth == true {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Sweech.Color.warning)
                    Text("Needs re-authentication")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Sweech.Color.warning)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Sweech.Color.warning.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Sweech.Color.warning.opacity(0.2), lineWidth: 0.5))
                .help("OAuth token expired. Run: sweech auth \(account.commandName)")
            }

            // Token refresh indicator
            if account.wasRecentlyRefreshed {
                HStack(spacing: 6) {
                    Image(systemName: "key.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(Sweech.Color.ok)
                    Text("Token refreshed")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Sweech.Color.ok)
                    if let expiry = account.tokenExpiryRelative {
                        Text("· expires in \(expiry)")
                            .font(.system(size: 10))
                            .foregroundStyle(Sweech.Color.textMuted)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
                .help("OAuth token was just refreshed successfully")
            } else if account.tokenStatus == "valid", let expiry = account.tokenExpiryRelative,
                      let expiresAt = account.tokenExpiresAt,
                      (expiresAt / 1000 - Date().timeIntervalSince1970) < 86400 {
                HStack(spacing: 6) {
                    Image(systemName: "key.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(Sweech.Color.textMuted.opacity(0.5))
                    Text("Token expires in \(expiry)")
                        .font(.system(size: 10))
                        .foregroundStyle(Sweech.Color.textMuted.opacity(0.7))
                }
                .help("OAuth token is valid but expires soon")
            }

            // Usage rows — hide for external providers (no real usage data)
            if !account.isExternal {
                if account.buckets.count > 1 {
                    let sorted = account.buckets.sorted { a, _ in a.label == "All models" }
                    let visible = showExtraBuckets ? sorted : sorted.filter { $0.label == "All models" }
                    ForEach(Array(visible.enumerated()), id: \.offset) { _, bucket in
                        BucketCard(bucket: bucket)
                    }
                } else {
                    Text("All models")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Sweech.Color.textPrimary.opacity(0.7))

                    // Column labels — USED / LEFT — aligned above the % columns
                    HStack(spacing: 6) {
                        Color.clear.frame(width: 34, height: 1)
                        Text("USED")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                            .frame(width: 46, alignment: .trailing)
                        Color.clear.frame(height: 1) // flexible bar spacer
                        Text("LEFT")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                            .frame(width: 46, alignment: .leading)
                        Color.clear.frame(width: 76, height: 1)
                    }
                    UsageRow(
                        label: "week",
                        messages: account.messages7dDisplay,
                        utilization: account.utilization7d,
                        resetIn: account.reset7dRelative,
                        resetsAt: account.live?.reset7dAt,
                        capacityNote: nil
                    )
                    .fontWeight(.medium)
                    UsageRow(
                        label: "5h",
                        messages: account.messages5hDisplay,
                        utilization: account.utilization5h,
                        resetIn: account.reset5hRelative,
                        resetsAt: account.live?.reset5hAt,
                        capacityNote: account.minutesUntilFirstCapacity.map { $0 > 0 ? "capacity in \($0)m" : nil } ?? nil
                    )
                    .opacity(0.85)

                    if account.live?.isStale == true {
                        HStack(spacing: 3) {
                            Image(systemName: "clock.badge.exclamationmark")
                                .font(.system(size: 9))
                            Text("stale data · tap ↻ to retry")
                                .font(.system(size: 9))
                        }
                        .foregroundStyle(Sweech.Color.warning.opacity(0.7))
                        .padding(.top, 2)
                    }
                }
            }

            // Footer
            HStack(spacing: 12) {
                if onMoveUp != nil || onMoveDown != nil {
                    HStack(spacing: 0) {
                        Button { onMoveUp?() } label: {
                            Image(systemName: "chevron.up")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(onMoveUp != nil ? Sweech.Color.textMuted.opacity(0.6) : Sweech.Color.textMuted.opacity(0.2))
                        }
                        .buttonStyle(.plain)
                        .disabled(onMoveUp == nil)
                        Button { onMoveDown?() } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(onMoveDown != nil ? Sweech.Color.textMuted.opacity(0.6) : Sweech.Color.textMuted.opacity(0.2))
                        }
                        .buttonStyle(.plain)
                        .disabled(onMoveDown == nil)
                    }
                }

                if !account.isExternal {
                    HStack(spacing: 4) {
                        Image(systemName: "clock").font(.system(size: 11))
                        Text(account.lastActiveRelative).font(.system(size: 12))
                    }
                    .help("Last time a request was made through this account")

                    HStack(spacing: 4) {
                        Image(systemName: "text.bubble").font(.system(size: 11))
                        Text("\(account.totalMessagesDisplay) total").font(.system(size: 12))
                    }
                    .help("Total messages ever sent through this account")
                }

                Spacer()

                Menu {
                    Button {
                        SweechService.launchInTerminal(commandName: account.commandName)
                    } label: {
                        Label("Fresh session", systemImage: "plus.circle")
                    }
                    Button {
                        SweechService.launchInTerminal(commandName: "\(account.commandName) --continue")
                    } label: {
                        Label("Continue last", systemImage: "arrow.uturn.forward")
                    }
                    Button {
                        let yoloFlag = (account.cliType ?? "claude") == "claude"
                            ? "--dangerously-skip-permissions" : "--yolo"
                        SweechService.launchInTerminal(commandName: "\(account.commandName) \(yoloFlag)")
                    } label: {
                        Label("Yolo mode", systemImage: "bolt.fill")
                    }
                    Divider()
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(account.commandName, forType: .string)
                    } label: {
                        Label("Copy command", systemImage: "doc.on.doc")
                    }
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "terminal")
                            .font(.system(size: 9))
                        Text("launch")
                            .font(.system(size: 9, weight: .semibold))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 7))
                    }
                    .foregroundStyle(Sweech.Color.accent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Sweech.Color.accent.opacity(0.1))
                    .clipShape(Capsule())
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("Launch \(account.commandName) — click for options")
            }
            .foregroundStyle(Sweech.Color.textMuted.opacity(0.65))
        }
        .padding(12)
        .background(Sweech.Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(
                    tier.borderColor.opacity(isHovered ? 1.0 : 0.85),
                    lineWidth: tier.borderWidth
                )
        )
        .shadow(color: tier.glowColor, radius: isHovered ? tier.glowRadius + 2 : tier.glowRadius, x: 0, y: 0)
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(.easeInOut(duration: 0.15), value: isHovered)
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityDescription)
    }

    private var accessibilityDescription: String {
        let status = account.liveStatus == "limit_reached" ? "rate limited"
            : account.needsReauth == true ? "needs re-authentication"
            : "available"
        let weekly = "\(Int(account.utilization7d * 100))% weekly used"
        let session = "\(Int(account.utilization5h * 100))% session used"
        let tierLabel = tier.badgeLabel.map { ", \($0)" } ?? ""
        return "\(account.name), \(status)\(tierLabel), \(weekly), \(session)"
    }
}

enum ProfileQuickManageMode {
    case manage
    case rename
}

struct ProfileQuickManageView: View {
    @ObservedObject var service: SweechService
    let account: SweechAccount
    let initialMode: ProfileQuickManageMode
    let onOpenFullManager: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var renameDraft = ""
    @State private var showDeleteConfirm = false

    private var canRename: Bool {
        !account.isDefaultAccount &&
        !service.isMutatingProfiles &&
        !renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        renameDraft.trimmingCharacters(in: .whitespacesAndNewlines) != account.commandName
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Manage \(account.commandName)")
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .foregroundStyle(Sweech.Color.textPrimary)
                        Text("Profile actions are available directly from this card.")
                            .font(.system(size: 11))
                            .foregroundStyle(Sweech.Color.textMuted)
                    }

                    Spacer()

                    Button("Cancel") { dismiss() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Sweech.Color.textMuted)
                }
                .padding(16)

                Divider().overlay(Sweech.Color.core.opacity(0.1))

                VStack(alignment: .leading, spacing: 16) {
                    if let error = service.profileMutationError, !error.isEmpty {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(Sweech.Color.warning)
                            Text(error)
                                .font(.system(size: 11))
                                .foregroundStyle(Sweech.Color.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(12)
                        .background(Sweech.Color.warning.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    managerSection(title: "PROFILE") {
                        VStack(alignment: .leading, spacing: 8) {
                            quickRow(label: "Name", value: account.commandName)
                            quickRow(label: "CLI", value: account.cliType ?? "claude")
                            quickRow(label: "Provider", value: account.providerLabel)
                            if let sharedWith = account.sharedWith {
                                quickRow(label: "Sharing", value: sharedWith)
                            }
                            if account.isDefaultAccount {
                                Text("Default profiles are protected from rename and delete.")
                                    .font(.system(size: 10))
                                    .foregroundStyle(Sweech.Color.textMuted)
                            }
                        }
                    }

                    managerSection(title: "ACTIONS") {
                        VStack(alignment: .leading, spacing: 12) {
                            if !account.isDefaultAccount {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Rename")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(Sweech.Color.textPrimary)
                                    HStack(spacing: 8) {
                                        TextField("New profile name", text: Binding(
                                            get: { renameDraft },
                                            set: { renameDraft = $0.lowercased() }
                                        ))
                                        .textFieldStyle(.roundedBorder)

                                        Button("Rename") {
                                            service.renameProfile(
                                                oldName: account.commandName,
                                                newName: renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                                            )
                                        }
                                        .buttonStyle(.borderedProminent)
                                        .controlSize(.small)
                                        .disabled(!canRename)
                                    }
                                }
                            }

                            HStack(spacing: 8) {
                                Button {
                                    SweechService.launchInTerminal(commandName: "sweech auth \(account.commandName)")
                                } label: {
                                    Label("Re-authenticate", systemImage: "key")
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)

                                Button {
                                    dismiss()
                                    onOpenFullManager()
                                } label: {
                                    Label("Open Full Manager", systemImage: "slider.horizontal.3")
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }

                            if !account.isDefaultAccount {
                                Button(role: .destructive) {
                                    showDeleteConfirm = true
                                } label: {
                                    Label("Delete Profile", systemImage: "trash")
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }

                    HStack {
                        Spacer()
                        Button("Done") { dismiss() }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                }
                .padding(16)
            }

            if showDeleteConfirm {
                ProfileDeleteConfirmationOverlay(
                    commandName: account.commandName,
                    message: "This removes the Sweech-managed profile from your current setup.",
                    onCancel: { showDeleteConfirm = false },
                    onDelete: {
                        showDeleteConfirm = false
                        service.removeProfile(commandName: account.commandName, forceDependents: true)
                        dismiss()
                    }
                )
                .zIndex(10)
            }
        }
        .frame(width: 420)
        .background(Sweech.Color.surface)
        .onAppear {
            renameDraft = account.commandName
            if initialMode == .rename {
                renameDraft = account.commandName
            }
        }
    }

    private func quickRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Sweech.Color.textMuted)
                .frame(width: 60, alignment: .leading)
            Text(value)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(Sweech.Color.textPrimary)
        }
    }

    private func managerSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Sweech.Color.textMuted.opacity(0.7))
                .kerning(0.8)
            content()
        }
        .padding(12)
        .background(Sweech.Color.surfaceHigh)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct ProfileDeleteConfirmationOverlay: View {
    let commandName: String
    let message: String
    let onCancel: () -> Void
    let onDelete: () -> Void

    var body: some View {
        ZStack {
            Rectangle()
                .fill(Color.black.opacity(0.45))
                .ignoresSafeArea()
                .onTapGesture(perform: onCancel)

            VStack(alignment: .leading, spacing: 14) {
                Text("Delete \(commandName)?")
                    .font(.system(size: 16, weight: .bold, design: .rounded))
                    .foregroundStyle(Sweech.Color.textPrimary)

                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(Sweech.Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 10) {
                    Button("Cancel", action: onCancel)
                        .buttonStyle(.plain)
                        .foregroundStyle(Sweech.Color.textPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Sweech.Color.surfaceHigh)
                        .clipShape(Capsule())

                    Button("Delete", action: onDelete)
                        .buttonStyle(.plain)
                        .foregroundStyle(Sweech.Color.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Sweech.Color.danger.opacity(0.18))
                        .clipShape(Capsule())
                }
            }
            .padding(18)
            .frame(width: 340)
            .background(Sweech.Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay(
                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(Sweech.Color.textMuted.opacity(0.18), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.25), radius: 24, x: 0, y: 16)
        }
    }
}

// MARK: - Profile Manager

struct ProfileManagerView: View {
    @ObservedObject var service: SweechService
    @Environment(\.dismiss) private var dismiss

    @State private var selectedCLI = "claude"
    @State private var selectedProvider = ""
    @State private var commandName = ""
    @State private var authMethod = "oauth"
    @State private var apiKey = ""
    @State private var sharedEnabled = false
    @State private var sharedWith = ""
    @State private var renameDrafts: [String: String] = [:]
    @State private var removalCandidate: SweechAccount?
    @State private var lastSuggestedName = ""

    private var filteredProviders: [ManageableProvider] {
        service.manageableProviders.filter { $0.cliType == selectedCLI }
    }

    private var selectedProviderInfo: ManageableProvider? {
        filteredProviders.first { $0.name == selectedProvider } ?? filteredProviders.first
    }

    private var shareTargets: [SweechAccount] {
        service.accounts
            .filter { ($0.cliType ?? "claude") == selectedCLI }
            .sorted {
                if $0.isDefaultAccount != $1.isDefaultAccount {
                    return $0.isDefaultAccount && !$1.isDefaultAccount
                }
                return $0.commandName < $1.commandName
            }
    }

    private var managedAccounts: [SweechAccount] {
        service.sortedAccounts
            .sorted {
                if $0.isDefaultAccount != $1.isDefaultAccount {
                    return $0.isDefaultAccount && !$1.isDefaultAccount
                }
                return $0.commandName < $1.commandName
            }
    }

    private var canCreate: Bool {
        guard let provider = selectedProviderInfo else { return false }
        if service.isMutatingProfiles { return false }
        if commandName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if !provider.supportsOAuth && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return false
        }
        if authMethod == "api-key" && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return false
        }
        return true
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Profile Management")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundStyle(Sweech.Color.textPrimary)
                    Text("Create, rename, and remove Sweech profiles without leaving the menu bar.")
                        .font(.system(size: 11))
                        .foregroundStyle(Sweech.Color.textMuted)
                }

                Spacer()

                Button {
                    dismiss()
                } label: {
                    Text("Cancel")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Sweech.Color.textMuted)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Sweech.Color.surfaceHigh)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(16)

            Divider().overlay(Sweech.Color.core.opacity(0.1))

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let error = service.profileMutationError, !error.isEmpty {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(Sweech.Color.warning)
                            Text(error)
                                .font(.system(size: 11))
                                .foregroundStyle(Sweech.Color.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(12)
                        .background(Sweech.Color.warning.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    managerSection(title: "ADD PROFILE") {
                        VStack(alignment: .leading, spacing: 12) {
                            Picker("CLI", selection: $selectedCLI) {
                                Text("Claude").tag("claude")
                                Text("Codex").tag("codex")
                            }
                            .pickerStyle(.segmented)

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Provider")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Sweech.Color.textPrimary)

                                Picker("Provider", selection: $selectedProvider) {
                                    ForEach(filteredProviders) { provider in
                                        Text(provider.displayName).tag(provider.name)
                                    }
                                }
                                .pickerStyle(.menu)
                                .labelsHidden()

                                if let provider = selectedProviderInfo {
                                    Text(provider.description)
                                        .font(.system(size: 10))
                                        .foregroundStyle(Sweech.Color.textMuted)
                                }
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("Command Name")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Sweech.Color.textPrimary)
                                TextField("claude-work", text: Binding(
                                    get: { commandName },
                                    set: { commandName = $0.lowercased() }
                                ))
                                .textFieldStyle(.roundedBorder)
                                if let provider = selectedProviderInfo {
                                    Button("Use suggested: \(provider.defaultCommandName)") {
                                        commandName = provider.defaultCommandName
                                        lastSuggestedName = provider.defaultCommandName
                                    }
                                    .buttonStyle(.plain)
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(Sweech.Color.accent)
                                }
                            }

                            if let provider = selectedProviderInfo, provider.supportsOAuth {
                                Picker("Authentication", selection: $authMethod) {
                                    Text("OAuth").tag("oauth")
                                    Text("API Key").tag("api-key")
                                }
                                .pickerStyle(.segmented)
                            }

                            if authMethod == "api-key" || selectedProviderInfo?.supportsOAuth == false {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("API Key")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(Sweech.Color.textPrimary)
                                    SecureField("Paste provider API key", text: $apiKey)
                                        .textFieldStyle(.roundedBorder)
                                }
                            }

                            Toggle(isOn: $sharedEnabled) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Share memory and data")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(Sweech.Color.textPrimary)
                                    Text("Symlink plans, tasks, commands, and transcripts to another profile. Auth stays separate.")
                                        .font(.system(size: 10))
                                        .foregroundStyle(Sweech.Color.textMuted)
                                }
                            }
                            .toggleStyle(.switch)
                            .tint(Sweech.Color.core)

                            if sharedEnabled && !shareTargets.isEmpty {
                                Picker("Share With", selection: $sharedWith) {
                                    ForEach(shareTargets) { account in
                                        Text(shareTargetLabel(account)).tag(account.commandName)
                                    }
                                }
                                .pickerStyle(.menu)
                            }

                            if authMethod == "oauth", selectedProviderInfo?.supportsOAuth == true {
                                Text("OAuth profiles are created now and finish sign-in the first time you launch them.")
                                    .font(.system(size: 10))
                                    .foregroundStyle(Sweech.Color.textMuted)
                            }

                            HStack(spacing: 8) {
                                Button {
                                    dismiss()
                                } label: {
                                    Text("Cancel")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(Sweech.Color.textPrimary)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .background(Sweech.Color.surfaceHigh)
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)

                                Spacer()

                                Button {
                                    service.createProfile(
                                        cliType: selectedCLI,
                                        provider: selectedProvider,
                                        commandName: commandName.trimmingCharacters(in: .whitespacesAndNewlines),
                                        authMethod: authMethod,
                                        apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
                                        sharedWith: sharedEnabled ? sharedWith : nil
                                    )
                                    apiKey = ""
                                } label: {
                                    HStack(spacing: 6) {
                                        if service.isMutatingProfiles {
                                            ProgressView()
                                                .progressViewStyle(.circular)
                                                .scaleEffect(0.7)
                                        } else {
                                            Image(systemName: "plus.circle.fill")
                                                .font(.system(size: 11))
                                        }
                                        Text("Create Profile")
                                            .font(.system(size: 11, weight: .semibold))
                                    }
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 7)
                                    .background(canCreate ? Sweech.Color.core : Sweech.Color.textMuted.opacity(0.3))
                                    .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                                .disabled(!canCreate)
                            }
                        }
                    }

                    managerSection(title: "EXISTING PROFILES") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(managedAccounts) { account in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(spacing: 6) {
                                        Text(account.commandName)
                                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                            .foregroundStyle(Sweech.Color.textPrimary)

                                        if account.isDefaultAccount {
                                            managerBadge("default", color: Sweech.Color.textMuted)
                                        } else if let cliType = account.cliType {
                                            managerBadge(cliType, color: Sweech.Color.accent)
                                        }

                                        if account.provider != nil {
                                            managerBadge(account.providerLabel, color: Sweech.Color.core)
                                        }

                                        Spacer()

                                        if !account.isDefaultAccount {
                                            Button(role: .destructive) {
                                                removalCandidate = account
                                            } label: {
                                                Image(systemName: "trash")
                                                    .font(.system(size: 11, weight: .semibold))
                                                    .foregroundStyle(Sweech.Color.danger)
                                            }
                                            .buttonStyle(.plain)
                                            .disabled(service.isMutatingProfiles)
                                        }
                                    }

                                    if let sharedWith = account.sharedWith {
                                        Text("Shares data with \(sharedWith)")
                                            .font(.system(size: 10))
                                            .foregroundStyle(Sweech.Color.textMuted)
                                    }

                                    if !account.isDefaultAccount {
                                        HStack(spacing: 8) {
                                            TextField("New name", text: renameBinding(for: account))
                                                .textFieldStyle(.roundedBorder)

                                            Button("Rename") {
                                                service.renameProfile(
                                                    oldName: account.commandName,
                                                    newName: renameDrafts[account.commandName, default: account.commandName]
                                                        .trimmingCharacters(in: .whitespacesAndNewlines)
                                                )
                                            }
                                            .buttonStyle(.borderedProminent)
                                            .controlSize(.small)
                                            .disabled(service.isMutatingProfiles || renameDrafts[account.commandName, default: account.commandName]
                                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                                .isEmpty || renameDrafts[account.commandName, default: account.commandName]
                                                .trimmingCharacters(in: .whitespacesAndNewlines) == account.commandName)
                                        }
                                    }
                                }
                                .padding(10)
                                .background(Sweech.Color.background.opacity(0.45))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                        }
                    }
                }
                .padding(16)
            }
        }
        .frame(width: 520, height: 680)
        .background(Sweech.Color.surface)
        .onAppear { syncFormState(resetName: true) }
        .onChange(of: service.manageableProviders.count) { _ in
            syncFormState(resetName: true)
        }
        .onChange(of: selectedCLI) { _ in
            authMethod = "oauth"
            apiKey = ""
            syncFormState(resetName: true)
        }
        .onChange(of: selectedProvider) { _ in
            syncFormState(resetName: commandName.isEmpty || commandName == lastSuggestedName)
        }
        .onChange(of: sharedEnabled) { enabled in
            if enabled, sharedWith.isEmpty {
                sharedWith = shareTargets.first?.commandName ?? ""
            }
        }
        .alert(item: $removalCandidate) { account in
            Alert(
                title: Text("Remove \(account.commandName)?"),
                message: Text("This deletes the Sweech-managed profile. Any profiles sharing this profile will need to be relinked manually."),
                primaryButton: .destructive(Text("Remove")) {
                    service.removeProfile(commandName: account.commandName, forceDependents: true)
                },
                secondaryButton: .cancel()
            )
        }
    }

    private func renameBinding(for account: SweechAccount) -> Binding<String> {
        Binding(
            get: { renameDrafts[account.commandName, default: account.commandName] },
            set: { renameDrafts[account.commandName] = $0.lowercased() }
        )
    }

    private func syncFormState(resetName: Bool) {
        guard !filteredProviders.isEmpty else { return }

        if !filteredProviders.contains(where: { $0.name == selectedProvider }) {
            selectedProvider = filteredProviders[0].name
        }

        guard let provider = selectedProviderInfo else { return }

        if !provider.supportsOAuth {
            authMethod = "api-key"
        } else if authMethod != "api-key" {
            authMethod = "oauth"
        }

        if resetName || commandName.isEmpty {
            commandName = provider.defaultCommandName
        }
        lastSuggestedName = provider.defaultCommandName

        if sharedWith.isEmpty || !shareTargets.contains(where: { $0.commandName == sharedWith }) {
            sharedWith = shareTargets.first?.commandName ?? ""
        }
    }

    private func shareTargetLabel(_ account: SweechAccount) -> String {
        if account.isDefaultAccount {
            return "\(account.commandName) (default)"
        }
        return account.commandName
    }

    private func managerSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Sweech.Color.textMuted.opacity(0.7))
                .kerning(0.8)
            content()
        }
        .padding(12)
        .background(Sweech.Color.surfaceHigh)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func managerBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

// MARK: - Mini Account Card (T-024)

/// Compact card for mini mode — shows name, status pill, and week bar only.
/// Approximately 40% the height of a full AccountCard.
struct MiniAccountCard: View {
    let account: SweechAccount
    var tier: CardTier = .normal

    @State private var isHovered = false

    private var weekBarColor: Color {
        let u = account.utilization7d
        if u >= 0.9 { return Sweech.Color.danger }
        if u >= 0.7 { return Sweech.Color.warning }
        if u >= 0.4 { return Sweech.Color.warm }
        return Sweech.Color.ok
    }

    var body: some View {
        HStack(spacing: 8) {
            // Name
            Text(account.name)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(Sweech.Color.textPrimary)
                .lineLimit(1)

            // Tier badge (if any)
            if let label = tier.badgeLabel {
                HStack(spacing: 2) {
                    Image(systemName: tier.badgeIcon).font(.system(size: 7))
                    Text(label).font(.system(size: 8, weight: .bold))
                }
                .foregroundStyle(tier.badgeColor)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(tier.badgeColor.opacity(0.12))
                .clipShape(Capsule())
            }

            Spacer()

            // Week usage bar (inline mini bar)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Sweech.Color.surfaceHigh)
                        .frame(height: 4)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(weekBarColor)
                        .frame(width: max(0, geo.size.width * min(account.utilization7d, 1.0)), height: 4)
                }
            }
            .frame(width: 60, height: 4)
            .help("\(Int(account.utilization7d * 100))% weekly used")

            // Status pill
            StatusPill(account: account)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Sweech.Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(
                    tier.borderColor.opacity(isHovered ? 1.0 : 0.85),
                    lineWidth: tier.borderWidth
                )
        )
        .shadow(color: tier.glowColor, radius: isHovered ? tier.glowRadius + 2 : tier.glowRadius, x: 0, y: 0)
        .scaleEffect(isHovered ? 1.01 : 1.0)
        .animation(Sweech.Animation.fast, value: isHovered)
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(account.name), \(account.liveStatus), \(Int(account.utilization7d * 100))% weekly used")
    }
}

// MARK: - Status Pill

struct StatusPill: View {
    let account: SweechAccount

    var body: some View {
        let status = account.liveStatus
        let (text, color): (String, Color) = {
            switch status {
            case "allowed":       return ("ok",    Sweech.Color.ok)
            case "limit_reached": return limitText
            case "warning":       return ("warn",  Sweech.Color.warning)
            default:              return ("?",     Sweech.Color.textMuted)
            }
        }()

        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
            .accessibilityLabel(text == "?" ? "Status unknown" : text)
            .help(statusHelp(status))
    }

    /// When limit reached, include the reset countdown inline
    private var limitText: (String, Color) {
        if let reset = account.reset5hRelative {
            return ("limit · \(reset)", Sweech.Color.danger)
        }
        return ("limit", Sweech.Color.danger)
    }

    private func statusHelp(_ status: String) -> String {
        switch status {
        case "allowed":       return "Account is active and accepting requests"
        case "limit_reached": return "5h rate limit reached — blocked until the window resets. The countdown shows time until recovery."
        case "warning":       return "Approaching the rate limit — usage is elevated"
        default:              return "Status unknown — try reloading"
        }
    }
}

// MARK: - Usage Row

struct UsageRow: View {
    let label: String
    let messages: Int
    let utilization: Double
    let resetIn: String?
    let resetsAt: Double?
    let capacityNote: String?

    @AppStorage("sweechCompact") private var compact: Bool = false
    @State private var expiryPulse = false

    private var used: Int { Int(utilization * 100) }
    private var remaining: Int { max(0, 100 - used) }

    private var barColor: Color {
        if utilization >= 0.9 { return Sweech.Color.danger }
        if utilization >= 0.7 { return Sweech.Color.warning }
        if utilization >= 0.4 { return Sweech.Color.warm }
        return Sweech.Color.ok
    }

    private var remainingColor: Color {
        if remaining <= 10 { return Sweech.Color.danger }
        if remaining <= 30 { return Sweech.Color.warning }
        return Sweech.Color.ok
    }

    private var resetUrgencyColor: Color {
        guard let epoch = resetsAt else { return Sweech.Color.accent }
        let interval = Date(timeIntervalSince1970: epoch).timeIntervalSince(Date())
        if interval < 1800 { return Sweech.Color.danger }
        if interval < 7200 { return Sweech.Color.warning }
        return Sweech.Color.accent
    }

    private var weeklyExpiryNote: String? {
        guard label == "week", let epoch = resetsAt else { return nil }
        let secsLeft = Date(timeIntervalSince1970: epoch).timeIntervalSince(Date())
        guard secsLeft > 0 else { return nil }
        let hoursLeft = secsLeft / 3600
        let rem = 1.0 - utilization
        guard rem > 0 && hoursLeft < 72 else { return nil }
        let pct = Int(rem * 100)
        return hoursLeft < 24
            ? "⚡ \(pct)% expiring in \(Int(hoursLeft))h"
            : "⚡ \(pct)% expiring in \(Int(hoursLeft / 24))d"
    }

    private var windowHelp: String {
        label == "5h"
            ? "5-hour rolling session window. Resets from your oldest message — not at a fixed clock time."
            : "7-day rolling weekly window. Unused quota expires on reset and does not carry over."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Sweech.Color.textMuted)
                    .frame(width: 34, alignment: .leading)
                    .help(windowHelp)

                HStack(spacing: 2) {
                    if utilization >= 0.9 {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(Sweech.Color.danger)
                    } else if utilization >= 0.7 {
                        Image(systemName: "flame.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(Sweech.Color.warning)
                    }
                    Text("\(used)%")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(barColor)
                        .monospacedDigit()
                }
                .frame(width: 46, alignment: .trailing)
                .help("\(used)% of this window's quota used — \(messages) message(s). Bar color: green ≤40%, pink 40–70%, amber 70–90%, red ≥90%.")

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Sweech.Color.surfaceHigh)
                            .frame(height: 5)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(LinearGradient(
                                colors: [barColor, barColor.opacity(0.6)],
                                startPoint: .leading, endPoint: .trailing
                            ))
                            .frame(width: max(0, geo.size.width * min(utilization, 1.0)), height: 5)
                            .shadow(color: barColor.opacity(0.4), radius: 3, x: 0, y: 0)
                    }
                }
                .frame(height: 5)
                .help("Usage bar — fills left to right as quota is consumed")

                Text("\(remaining)%")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(remainingColor)
                    .monospacedDigit()
                    .frame(width: 46, alignment: .leading)
                    .help("\(remaining)% of quota still available in this \(label) window")

                HStack(spacing: 3) {
                    if let resetIn {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 10, weight: .bold))
                        Text(resetIn)
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .monospacedDigit()
                    }
                }
                .foregroundStyle(resetUrgencyColor)
                .frame(width: 76, alignment: .leading)
                .help(resetIn.map {
                    "\(label) window resets in \($0). Red = <30 min, amber = <2h, blue = more time."
                } ?? "Reset time unknown")
            }
            .frame(height: 18)

            if !compact && (messages > 0 || capacityNote != nil || weeklyExpiryNote != nil) {
                HStack(spacing: 8) {
                    if messages > 0 {
                        Text("\(messages) msgs")
                            .font(.system(size: 11))
                            .foregroundStyle(Sweech.Color.textMuted.opacity(0.65))
                            .help("Messages sent in this \(label) window")
                    }
                    if let note = capacityNote {
                        Text(note)
                            .font(.system(size: 11))
                            .foregroundStyle(Sweech.Color.accent.opacity(0.65))
                            .help("Estimated time until the next capacity slot opens in this 5h window")
                    }
                    if let expiry = weeklyExpiryNote {
                        Text(expiry)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Sweech.Color.expiry)
                            .opacity(expiryPulse ? 0.45 : 1.0)
                            .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: expiryPulse)
                            .onAppear { expiryPulse = true }
                            .help("Quota will expire unused before the weekly reset — switch to this account to use it")
                    }
                }
                .padding(.leading, 26)
            }
        }
    }
}

// MARK: - Bucket Card

struct BucketCard: View {
    let bucket: LiveBucket

    private func resetRelative(_ epoch: Double?) -> String? {
        guard let epoch else { return nil }
        let interval = Date(timeIntervalSince1970: epoch).timeIntervalSince(Date())
        if interval <= 0 { return "now" }
        if interval < 3600 { return "\(Int(interval / 60))m" }
        if interval < 86400 { return "\(Int(interval / 3600))h \(Int((interval.truncatingRemainder(dividingBy: 3600)) / 60))m" }
        return "\(Int(interval / 86400))d"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(bucket.label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Sweech.Color.textPrimary.opacity(0.7))
                .help("Usage bucket: \(bucket.label) — separate rate limit pool for this model tier")

            if let weekly = bucket.weekly {
                UsageRow(label: "week", messages: 0, utilization: weekly.utilization,
                         resetIn: resetRelative(weekly.resetsAt), resetsAt: weekly.resetsAt, capacityNote: nil)
                    .fontWeight(.medium)
            }
            if let session = bucket.session {
                UsageRow(label: "5h", messages: 0, utilization: session.utilization,
                         resetIn: resetRelative(session.resetsAt), resetsAt: session.resetsAt, capacityNote: nil)
                    .opacity(0.85)
            }
        }
        .padding(8)
        .background(Sweech.Color.background.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Settings View

struct SettingsView: View {
    @ObservedObject var service: SweechService

    @AppStorage("sweechBarLabelMode")    private var labelMode: String = "capacity"
    @AppStorage("sweechSortMode")        private var sortMode: String  = "smart"
    @AppStorage("sweechGrouped")         private var grouped: Bool     = true
    @AppStorage("sweechMiniMode")        private var miniMode: Bool    = false
    @AppStorage("sweechRefreshInterval") private var refreshInterval: Int  = 30
    @AppStorage("sweechNotifications")   private var notificationsEnabled: Bool = true
    @AppStorage("sweechCompact")         private var compact: Bool     = false
    @AppStorage("sweechShowExtraBuckets") private var showExtraBuckets: Bool = false
    @AppStorage("sweechHotkeyEnabled")   private var hotkeyEnabled: Bool = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Preferences")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundStyle(Sweech.Color.textPrimary)

                // Menu bar label
                settingsSection(title: "MENU BAR SHOWS") {
                    labelOption(
                        mode: "expiry",
                        icon: "exclamationmark.arrow.circlepath",
                        iconColor: Sweech.Color.expiry,
                        label: "Expiring quota",
                        desc: "Shows ⚡72% when you have weekly quota that will expire unused. Nothing shown when all is fine."
                    )
                    labelOption(
                        mode: "capacity",
                        icon: "gauge.with.dots.needle.67percent",
                        iconColor: Sweech.Color.ok,
                        label: "5h capacity",
                        desc: "Free % remaining in the best account's 5-hour rolling window. Useful when actively switching accounts."
                    )
                    labelOption(
                        mode: "count",
                        icon: "person.2",
                        iconColor: Sweech.Color.accent,
                        label: "Account count",
                        desc: "Available / total accounts, e.g. 5/6. Good at a glance when you have many accounts."
                    )
                    labelOption(
                        mode: "icon",
                        icon: "eye.slash",
                        iconColor: Sweech.Color.textMuted,
                        label: "Icon only",
                        desc: "Just 🍭 — minimal. Status color (🔴 / ⚠️) still shows when an account hits its limit."
                    )
                }

                // Default sort
                settingsSection(title: "DEFAULT SORT") {
                    sortOption(mode: "smart",  icon: "bolt.fill",  iconColor: Sweech.Color.warning,
                               label: "Smart (expiry-first)",
                               desc: "Ranks by weekly quota ÷ days until reset — puts the account you should use most urgently first.")
                    sortOption(mode: "status", icon: "circle.fill", iconColor: Sweech.Color.ok,
                               label: "By status",
                               desc: "Available accounts first, then warning, then limit reached.")
                    sortOption(mode: "manual", icon: "hand.draw",   iconColor: Sweech.Color.textMuted,
                               label: "Manual",
                               desc: "Drag cards to reorder. Order is saved between sessions.")
                }

                // Grouping
                settingsSection(title: "LAYOUT") {
                    Toggle(isOn: $grouped) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Group by provider")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Sweech.Color.textPrimary)
                            Text("Show Claude and Codex accounts in separate columns.")
                                .font(.system(size: 10))
                                .foregroundStyle(Sweech.Color.textMuted)
                        }
                    }
                    .toggleStyle(.switch)
                    .tint(Sweech.Color.core)

                    Toggle(isOn: $miniMode) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Mini mode")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Sweech.Color.textPrimary)
                            Text("Show only the top 2 recommended accounts with minimal detail. Tap \"Show all\" to expand.")
                                .font(.system(size: 10))
                                .foregroundStyle(Sweech.Color.textMuted)
                        }
                    }
                    .toggleStyle(.switch)
                    .tint(Sweech.Color.core)
                }

                // Usage detail
                settingsSection(title: "USAGE") {
                    Toggle(isOn: $showExtraBuckets) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Show additional model usage")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Sweech.Color.textPrimary)
                            Text("Show per-model rate limits (e.g. Codex Spark) in addition to the aggregate 'All models' bucket.")
                                .font(.system(size: 10))
                                .foregroundStyle(Sweech.Color.textMuted)
                        }
                    }
                    .toggleStyle(.switch)
                    .tint(Sweech.Color.core)
                }

                // Notifications section
                settingsSection(title: "NOTIFICATIONS") {
                    Toggle(isOn: $notificationsEnabled) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Status change alerts")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Sweech.Color.textPrimary)
                            Text("Notify when an account hits its rate limit or recovers.")
                                .font(.system(size: 10))
                                .foregroundStyle(Sweech.Color.textMuted)
                        }
                    }
                    .toggleStyle(.switch)
                    .tint(Sweech.Color.core)
                }

                // Refresh interval section
                settingsSection(title: "AUTO-REFRESH") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Refresh every")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Sweech.Color.textPrimary)
                        HStack(spacing: 6) {
                            ForEach([(15, "15s"), (30, "30s"), (60, "1m"), (300, "5m")], id: \.0) { secs, label in
                                Button { refreshInterval = secs; service.applyRefreshInterval() } label: {
                                    Text(label)
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(refreshInterval == secs ? Sweech.Color.background : Sweech.Color.textMuted)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 4)
                                        .background(refreshInterval == secs ? Sweech.Color.core : Sweech.Color.surfaceHigh)
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }

                // Display section
                settingsSection(title: "DISPLAY") {
                    Toggle(isOn: $compact) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Compact mode")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Sweech.Color.textPrimary)
                            Text("Hide message counts and sub-row detail in usage bars.")
                                .font(.system(size: 10))
                                .foregroundStyle(Sweech.Color.textMuted)
                        }
                    }
                    .toggleStyle(.switch)
                    .tint(Sweech.Color.core)
                }

                // Global hotkey
                settingsSection(title: "GLOBAL HOTKEY") {
                    Toggle(isOn: $hotkeyEnabled) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("⌘⇧S to toggle SweechBar")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Sweech.Color.textPrimary)
                            Text("Press Cmd+Shift+S from any app to open or close the popover.")
                                .font(.system(size: 10))
                                .foregroundStyle(Sweech.Color.textMuted)
                        }
                    }
                    .toggleStyle(.switch)
                    .tint(Sweech.Color.core)
                    .onChange(of: hotkeyEnabled) { enabled in
                        if enabled {
                            HotkeyManager.shared.register()
                        } else {
                            HotkeyManager.shared.unregister()
                        }
                    }
                }
            }
            .padding(16)
        }
        .frame(width: 320)
        .background(Sweech.Color.surface)
    }

    private func settingsSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Sweech.Color.textMuted.opacity(0.7))
                .kerning(0.8)
            VStack(alignment: .leading, spacing: 6) {
                content()
            }
        }
        .padding(12)
        .background(Sweech.Color.surfaceHigh)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func labelOption(mode: String, icon: String, iconColor: Color, label: String, desc: String) -> some View {
        Button { labelMode = mode } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: labelMode == mode ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(labelMode == mode ? Sweech.Color.core : Sweech.Color.textMuted.opacity(0.4))
                    .frame(width: 16)
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(iconColor)
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Sweech.Color.textPrimary)
                    Text(desc)
                        .font(.system(size: 10))
                        .foregroundStyle(Sweech.Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func sortOption(mode: String, icon: String, iconColor: Color, label: String, desc: String) -> some View {
        Button { sortMode = mode } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: sortMode == mode ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(sortMode == mode ? Sweech.Color.core : Sweech.Color.textMuted.opacity(0.4))
                    .frame(width: 16)
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(iconColor)
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Sweech.Color.textPrimary)
                    Text(desc)
                        .font(.system(size: 10))
                        .foregroundStyle(Sweech.Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Keyboard Shortcuts

/// Invisible NSView-backed responder that captures key events for the popover.
struct KeyboardShortcuts: NSViewRepresentable {
    var onRefresh: () -> Void
    var onCycleSort: () -> Void
    var onToggleGroup: () -> Void
    var onToggleGuide: () -> Void
    var onToggleSettings: () -> Void

    func makeNSView(context: Context) -> KeyCatcherView {
        let view = KeyCatcherView()
        view.handler = context.coordinator
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ nsView: KeyCatcherView, context: Context) {
        nsView.handler = context.coordinator
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    class Coordinator {
        let parent: KeyboardShortcuts
        init(_ parent: KeyboardShortcuts) { self.parent = parent }
    }

    class KeyCatcherView: NSView {
        var handler: Coordinator?
        override var acceptsFirstResponder: Bool { true }
        override func keyDown(with event: NSEvent) {
            guard let handler else { super.keyDown(with: event); return }
            switch event.charactersIgnoringModifiers {
            case "r": handler.parent.onRefresh()
            case "s": handler.parent.onCycleSort()
            case "g": handler.parent.onToggleGroup()
            case "?": handler.parent.onToggleGuide()
            case ",": handler.parent.onToggleSettings()
            default: super.keyDown(with: event)
            }
        }
    }
}
