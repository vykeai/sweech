import SwiftUI

@main
struct SweechBarApp: App {
    @StateObject private var service = SweechService()

    init() {
        // Single instance: terminate older copies
        let myPID = ProcessInfo.processInfo.processIdentifier
        NSWorkspace.shared.runningApplications
            .filter { $0.localizedName == "SweechBar" && $0.processIdentifier != myPID }
            .forEach { $0.terminate() }

        DispatchQueue.main.async {
            NSApp.setActivationPolicy(.accessory)
        }
    }

    private var menuBarLabel: String {
        // Show best available account's 5h free % so you can decide at a glance
        let best = service.accounts
            .filter { $0.liveStatus != "limit_reached" && $0.needsReauth != true }
            .sorted { $0.smartScore > $1.smartScore }
            .first
        let freeStr = best.map { " \(max(0, 100 - Int($0.utilization5h * 100)))%" } ?? ""
        switch service.worstStatus {
        case "limit_reached": return "\u{1F36D}\u{1F534}\(freeStr)"
        case "warning":       return "\u{1F36D}\u{26A0}\u{FE0F}\(freeStr)"
        default:              return "\u{1F36D}\(freeStr)"
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
