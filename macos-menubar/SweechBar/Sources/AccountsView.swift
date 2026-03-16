import SwiftUI

struct AccountsView: View {
    @ObservedObject var service: SweechService

    private var claudeAccounts: [SweechAccount] {
        service.sortedAccounts.filter { ($0.cliType ?? "claude") == "claude" }
    }

    private var codexAccounts: [SweechAccount] {
        service.sortedAccounts.filter { $0.cliType == "codex" }
    }

    private var hasBothTypes: Bool {
        !claudeAccounts.isEmpty && !codexAccounts.isEmpty
    }

    var body: some View {
        ZStack {
            Sweech.Gradient.backgroundRadial.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Divider().overlay(Sweech.Color.core.opacity(0.2))

                if service.accounts.isEmpty && !service.isConnected {
                    disconnectedView
                } else if hasBothTypes {
                    VStack(spacing: 10) {
                        summaryHeader
                        HStack(alignment: .top, spacing: 10) {
                            // Claude column
                            VStack(spacing: 8) {
                                columnHeader(title: "claude", count: claudeAccounts.count)
                                ForEach(claudeAccounts) { account in
                                    AccountCard(account: account)
                                }
                            }
                            .frame(maxWidth: .infinity)

                            // Codex column
                            VStack(spacing: 8) {
                                columnHeader(title: "codex", count: codexAccounts.count)
                                ForEach(codexAccounts) { account in
                                    AccountCard(account: account)
                                }
                            }
                            .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(12)
                } else {
                    List {
                        ForEach(service.sortedAccounts) { account in
                            AccountCard(account: account)
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                        }
                        .onMove { service.moveAccount(from: $0, to: $1) }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }

                Divider().overlay(Sweech.Color.core.opacity(0.1))
                footer
            }
            .onAppear { service.fetch() }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: hasBothTypes ? 680 : 360)
    }

    private func columnHeader(title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(Sweech.Color.accent)
            Text("\(count)")
                .font(.system(size: 9, weight: .bold))
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
    }

    private var summaryHeader: some View {
        let total = service.accounts.count
        let available = service.accounts.filter { $0.liveStatus != "limit_reached" }.count
        return Text("\(available) of \(total) accounts available")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Sweech.Color.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("🍭")
                .font(.system(size: 18))
            Text("sweech")
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundStyle(Sweech.Color.textPrimary)

            Spacer()

            Circle()
                .fill(service.isConnected ? Sweech.Color.ok : Sweech.Color.danger)
                .frame(width: 7, height: 7)

            Button(action: { service.fetch() }) {
                if service.isFetching {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .scaleEffect(0.6)
                        .frame(width: 16, height: 16)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12))
                        .foregroundStyle(Sweech.Color.textMuted.opacity(0.6))
                }
            }
            .buttonStyle(.plain)
            .disabled(service.isFetching)
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
                .foregroundStyle(Sweech.Color.textMuted.opacity(0.4))

            if !lastFetchedText.isEmpty {
                Text("·")
                    .font(.system(size: 9))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.3))
                Text(lastFetchedText)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.4))
            }

            Spacer()

            // Actions menu
            Menu {
                Button {
                    service.fetch()
                } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                .disabled(service.isFetching)

                Divider()

                Button {
                    service.setLaunchAtLogin(!service.launchAtLogin)
                } label: {
                    Label(
                        service.launchAtLogin ? "Remove from Login Items" : "Launch at Login",
                        systemImage: service.launchAtLogin ? "checkmark.circle.fill" : "circle"
                    )
                }

                Button {
                    service.restartDaemon()
                } label: {
                    Label("Restart Daemon", systemImage: "arrow.counterclockwise.circle")
                }

                Divider()

                Button(role: .destructive) {
                    NSApp.terminate(nil)
                } label: {
                    Label("Quit SweechBar", systemImage: "xmark.circle")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(Sweech.Color.textMuted.opacity(0.5))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

// MARK: - Account Card

struct AccountCard: View {
    let account: SweechAccount

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: name + type + status
            HStack(alignment: .firstTextBaseline) {
                Text(account.name)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Sweech.Color.textPrimary)

                if let cliType = account.cliType {
                    Text(cliType)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Sweech.Color.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Sweech.Color.accent.opacity(0.1))
                        .clipShape(Capsule())
                }

                if let plan = account.planType {
                    Text(plan)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Sweech.Color.core)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Sweech.Color.core.opacity(0.1))
                        .clipShape(Capsule())
                }

                Spacer()

                StatusPill(account: account)
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
            }

            // Usage: per-bucket for multi-model (codex), overall for single (claude)
            if account.buckets.count > 1 {
                ForEach(Array(account.buckets.enumerated()), id: \.offset) { _, bucket in
                    BucketCard(bucket: bucket)
                }
            } else {
                UsageRow(
                    label: "5h",
                    messages: account.messages5hDisplay,
                    utilization: account.utilization5h,
                    resetIn: account.reset5hRelative,
                    capacityNote: account.minutesUntilFirstCapacity.map { $0 > 0 ? "capacity in \($0)m" : nil } ?? nil
                )

                UsageRow(
                    label: "7d",
                    messages: account.messages7dDisplay,
                    utilization: account.utilization7d,
                    resetIn: account.reset7dRelative,
                    capacityNote: nil
                )
            }

            // Footer: last active + total messages
            HStack(spacing: 12) {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.system(size: 9))
                    Text(account.lastActiveRelative)
                        .font(.system(size: 10))
                }

                HStack(spacing: 4) {
                    Image(systemName: "text.bubble")
                        .font(.system(size: 9))
                    Text("\(account.totalMessagesDisplay) total")
                        .font(.system(size: 10))
                }

                Spacer()
            }
            .foregroundStyle(Sweech.Color.textMuted.opacity(0.45))
        }
        .padding(12)
        .background(Sweech.Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Sweech.Color.core.opacity(0.1), lineWidth: 0.5)
        )
    }
}

// MARK: - Status Pill

struct StatusPill: View {
    let account: SweechAccount

    var body: some View {
        let status = account.liveStatus
        let (text, color): (String, Color) = {
            switch status {
            case "allowed": return ("ok", Sweech.Color.ok)
            case "limit_reached": return ("limit", Sweech.Color.danger)
            case "warning": return ("warn", Sweech.Color.warning)
            default: return ("—", Sweech.Color.textMuted)
            }
        }()

        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

// MARK: - Usage Row

struct UsageRow: View {
    let label: String
    let messages: Int
    let utilization: Double
    let resetIn: String?
    let capacityNote: String?

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

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Single inline row: label · used% · [bar] · free% · reset
            HStack(spacing: 6) {
                // Window label
                Text(label)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Sweech.Color.textMuted)
                    .frame(width: 20, alignment: .leading)

                // Used %
                Text("\(used)%")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(barColor)
                    .monospacedDigit()
                    .frame(width: 32, alignment: .trailing)

                // Progress bar — fills available space
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Sweech.Color.surfaceHigh)
                            .frame(height: 5)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(
                                LinearGradient(
                                    colors: [barColor, barColor.opacity(0.6)],
                                    startPoint: .leading, endPoint: .trailing
                                )
                            )
                            .frame(width: max(0, geo.size.width * min(utilization, 1.0)), height: 5)
                            .shadow(color: barColor.opacity(0.4), radius: 3, x: 0, y: 0)
                    }
                }
                .frame(height: 5)

                // Free %
                Text("\(remaining)%")
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundStyle(remainingColor)
                    .monospacedDigit()
                    .frame(width: 32, alignment: .leading)

                // Reset time
                if let resetIn {
                    HStack(spacing: 2) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 8, weight: .medium))
                        Text(resetIn)
                            .font(.system(size: 10, weight: .medium, design: .rounded))
                            .monospacedDigit()
                    }
                    .foregroundStyle(Sweech.Color.accent)
                }
            }
            .frame(height: 14)

            // Sub-row: messages + capacity note
            if messages > 0 || capacityNote != nil {
                HStack(spacing: 8) {
                    if messages > 0 {
                        Text("\(messages) msgs")
                            .font(.system(size: 9))
                            .foregroundStyle(Sweech.Color.textMuted.opacity(0.4))
                    }
                    if let note = capacityNote {
                        Text(note)
                            .font(.system(size: 9))
                            .foregroundStyle(Sweech.Color.accent.opacity(0.5))
                    }
                }
                .padding(.leading, 26)
            }
        }
    }
}

// MARK: - Bucket Card (per-model, used for multi-bucket accounts)

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
                .foregroundStyle(Sweech.Color.glow)

            if let session = bucket.session {
                UsageRow(
                    label: "5h",
                    messages: 0,
                    utilization: session.utilization,
                    resetIn: resetRelative(session.resetsAt),
                    capacityNote: nil
                )
            }

            if let weekly = bucket.weekly {
                UsageRow(
                    label: "7d",
                    messages: 0,
                    utilization: weekly.utilization,
                    resetIn: resetRelative(weekly.resetsAt),
                    capacityNote: nil
                )
            }
        }
        .padding(8)
        .background(Sweech.Color.background.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
