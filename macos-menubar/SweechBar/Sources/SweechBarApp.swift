import SwiftUI

@main
struct SweechBarApp: App {
    @StateObject private var service = SweechService()
    @AppStorage("sweechBarLabelMode") private var labelMode: String = "capacity"

    init() {
        // Single instance: terminate older copies
        let myPID = ProcessInfo.processInfo.processIdentifier
        NSWorkspace.shared.runningApplications
            .filter { $0.localizedName == "SweechBar" && $0.processIdentifier != myPID }
            .forEach { $0.terminate() }

        DispatchQueue.main.async {
            NSApp.setActivationPolicy(.accessory)
        }

        // Register global hotkey (Cmd+Shift+S) to toggle popover
        HotkeyManager.shared.onToggle = {
            // Find the SweechBar status item button and click it
            DispatchQueue.main.async {
                guard let button = NSApp.windows
                    .compactMap({ $0.value(forKey: "statusItem") as? NSStatusItem })
                    .first?.button else { return }
                button.performClick(nil)
            }
        }
        HotkeyManager.shared.register()
    }

    private var menuBarLabel: String {
        let statusPrefix: String = {
            switch service.worstStatus {
            case "limit_reached": return "\u{1F36D}\u{1F534}"   // 🍭🔴
            case "warning":       return "\u{1F36D}\u{26A0}\u{FE0F}" // 🍭⚠️
            default:              return "\u{1F36D}"
            }
        }()

        switch labelMode {
        case "expiry":
            // Most urgent: highest (remaining% / days_until_reset) within 72h
            let urgent = service.accounts
                .filter { $0.needsReauth != true && $0.liveStatus != "limit_reached" }
                .compactMap { a -> (pct: Int, urgency: Double)? in
                    guard let epoch = a.live?.reset7dAt else { return nil }
                    let hoursLeft = Date(timeIntervalSince1970: epoch).timeIntervalSince(Date()) / 3600
                    let rem = 1.0 - a.utilization7d
                    guard rem > 0 && hoursLeft > 0 && hoursLeft < 72 else { return nil }
                    return (Int(rem * 100), rem / (hoursLeft / 24))
                }
                .max(by: { $0.urgency < $1.urgency })
            if let u = urgent {
                return "\u{1F36D}\u{26A1}\(u.pct)%"  // 🍭⚡72%
            }
            return statusPrefix  // nothing expiring soon — just show status

        case "count":
            let total = service.accounts.count
            let available = service.accounts.filter {
                $0.liveStatus != "limit_reached" && $0.needsReauth != true
            }.count
            return "\(statusPrefix) \(available)/\(total)"

        case "icon":
            return "\u{1F36D}"

        default: // "capacity" — best available account's 5h free %
            let best = service.accounts
                .filter { $0.liveStatus != "limit_reached" && $0.needsReauth != true }
                .sorted { $0.smartScore > $1.smartScore }
                .first
            let freeStr = best.map { " \(max(0, 100 - Int($0.utilization5h * 100)))%" } ?? ""
            return "\(statusPrefix)\(freeStr)"
        }
    }

    var body: some Scene {
        MenuBarExtra {
            AccountsView(service: service)
        } label: {
            Text(menuBarLabel)
        }
        .menuBarExtraStyle(.window)
    }
}
