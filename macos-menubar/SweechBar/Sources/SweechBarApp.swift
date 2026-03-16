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
        switch service.worstStatus {
        case "limit_reached": return "\u{1F36D}\u{1F534}"
        case "warning": return "\u{1F36D}\u{26A0}\u{FE0F}"
        default: return "\u{1F36D}"
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
