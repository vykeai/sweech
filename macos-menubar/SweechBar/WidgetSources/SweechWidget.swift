import WidgetKit
import SwiftUI

// MARK: - Timeline Entry

struct SweechEntry: TimelineEntry {
    let date: Date
    let accounts: [WidgetAccount]
    let topAccount: WidgetAccount?
}

struct WidgetAccount: Identifiable {
    let id: String
    let name: String
    let utilization5h: Double
    let utilization7d: Double
    let status: String  // "ok", "limit", "warn"
    let isTopPick: Bool
}

// MARK: - Timeline Provider

struct SweechProvider: TimelineProvider {
    func placeholder(in context: Context) -> SweechEntry {
        SweechEntry(date: .now, accounts: sampleAccounts, topAccount: sampleAccounts.first)
    }

    func getSnapshot(in context: Context, completion: @escaping (SweechEntry) -> Void) {
        let entry = loadEntry()
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SweechEntry>) -> Void) {
        let entry = loadEntry()
        // Refresh every 5 minutes
        let next = Calendar.current.date(byAdding: .minute, value: 5, to: .now)!
        let timeline = Timeline(entries: [entry], policy: .after(next))
        completion(timeline)
    }

    private func loadEntry() -> SweechEntry {
        // Read from sweech usage --json via shared cache file
        let cachePath = NSString("~/.sweech/widget-cache.json").expandingTildeInPath
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: cachePath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accountsArr = json["accounts"] as? [[String: Any]] else {
            return SweechEntry(date: .now, accounts: [], topAccount: nil)
        }

        let accounts: [WidgetAccount] = accountsArr.compactMap { dict in
            guard let name = dict["name"] as? String,
                  let commandName = dict["commandName"] as? String else { return nil }
            let live = dict["live"] as? [String: Any]
            let u5h = live?["utilization5h"] as? Double ?? 0
            let u7d = live?["utilization7d"] as? Double ?? 0
            let status = live?["status"] as? String ?? "unknown"
            let statusLabel = status == "limit_reached" ? "limit" : status == "warning" ? "warn" : "ok"
            return WidgetAccount(id: commandName, name: name, utilization5h: u5h, utilization7d: u7d, status: statusLabel, isTopPick: false)
        }

        // Sort by smart score (remaining / days_left)
        let sorted = accounts.sorted { a, b in
            let scoreA = (1.0 - a.utilization7d)
            let scoreB = (1.0 - b.utilization7d)
            return scoreA > scoreB
        }

        let top = sorted.first.map {
            WidgetAccount(id: $0.id, name: $0.name, utilization5h: $0.utilization5h, utilization7d: $0.utilization7d, status: $0.status, isTopPick: true)
        }

        return SweechEntry(date: .now, accounts: Array(sorted.prefix(3)), topAccount: top)
    }

    private var sampleAccounts: [WidgetAccount] {
        [
            WidgetAccount(id: "claude-pole", name: "claude-pole", utilization5h: 0.3, utilization7d: 0.15, status: "ok", isTopPick: true),
            WidgetAccount(id: "claude-ted", name: "claude-ted", utilization5h: 0.0, utilization7d: 0.45, status: "ok", isTopPick: false),
            WidgetAccount(id: "codex-pole", name: "codex-pole", utilization5h: 0.0, utilization7d: 0.0, status: "ok", isTopPick: false),
        ]
    }
}

// MARK: - Widget Views

struct SmallWidgetView: View {
    let entry: SweechEntry

    var body: some View {
        if let top = entry.topAccount {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("🍭")
                    Text("sweech")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(.secondary)
                }

                Text(top.name)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .lineLimit(1)

                UsageBar(label: "week", utilization: top.utilization7d)
                UsageBar(label: "5h", utilization: top.utilization5h)

                Spacer()
            }
            .padding(12)
        } else {
            VStack {
                Text("🍭")
                    .font(.title)
                Text("No accounts")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct MediumWidgetView: View {
    let entry: SweechEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("🍭")
                Text("sweech")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(entry.accounts.count) accounts")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }

            if entry.accounts.isEmpty {
                Text("No accounts configured")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ForEach(entry.accounts.prefix(3)) { account in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(statusColor(account.status))
                            .frame(width: 6, height: 6)

                        Text(account.name)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .lineLimit(1)
                            .frame(width: 100, alignment: .leading)

                        UsageBar(label: "wk", utilization: account.utilization7d)

                        Text("\(Int((1.0 - account.utilization7d) * 100))%")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(remainingColor(account.utilization7d))
                            .monospacedDigit()
                    }
                }
            }

            Spacer()
        }
        .padding(12)
    }

    func statusColor(_ status: String) -> Color {
        switch status {
        case "ok": return .green
        case "limit": return .red
        case "warn": return .orange
        default: return .gray
        }
    }

    func remainingColor(_ utilization: Double) -> Color {
        let remaining = 1.0 - utilization
        if remaining <= 0.1 { return .red }
        if remaining <= 0.3 { return .orange }
        return .green
    }
}

struct UsageBar: View {
    let label: String
    let utilization: Double

    var body: some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 22, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(.quaternary)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(barColor)
                        .frame(width: max(0, geo.size.width * min(utilization, 1.0)))
                }
            }
            .frame(height: 4)
        }
    }

    var barColor: Color {
        if utilization >= 0.9 { return .red }
        if utilization >= 0.7 { return .orange }
        if utilization >= 0.4 { return .yellow }
        return .green
    }
}

// MARK: - Widget Declaration

@main
struct SweechWidgetBundle: WidgetBundle {
    var body: some Widget {
        SweechWidget()
    }
}

struct SweechWidget: Widget {
    let kind = "ai.sweech.bar.widget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SweechProvider()) { entry in
            if #available(macOS 14.0, *) {
                Group {
                    SmallWidgetView(entry: entry)
                }
                .containerBackground(.fill.tertiary, for: .widget)
            } else {
                SmallWidgetView(entry: entry)
                    .padding()
                    .background()
            }
        }
        .configurationDisplayName("Sweech Usage")
        .description("AI account usage at a glance")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
