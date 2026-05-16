import SwiftUI
import Combine

// MARK: - App Entry Point

@main
struct SweechBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

// MARK: - AppDelegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var barController: SweechBarController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Single instance: terminate older copies
        let myPID = ProcessInfo.processInfo.processIdentifier
        NSWorkspace.shared.runningApplications
            .filter { $0.localizedName == "SweechBar" && $0.processIdentifier != myPID }
            .forEach { $0.terminate() }

        NSApp.setActivationPolicy(.accessory)

        barController = SweechBarController()

        // Register global hotkey (Cmd+Shift+S) to toggle popover
        HotkeyManager.shared.onToggle = { [weak self] in
            DispatchQueue.main.async {
                self?.barController.togglePopover()
            }
        }
        HotkeyManager.shared.register()
    }
}

// MARK: - SweechBarController

class SweechBarController: OnlyBarController {
    let service = SweechService()
    private var cancellables = Set<AnyCancellable>()

    @AppStorage("sweechBarLabelMode") private var labelMode: String = "capacity"

    /// Fires `sweech accounts refresh` on a 10-minute cadence so vault tokens
    /// never expire while SweechBar is running. Detached process — does not
    /// block the menu bar.
    private var vaultRefreshTimer: Timer?

    init() {
        // Use NSStatusItem.variableLength for dynamic text labels.
        // Width: 480 gives a near-square popover when stacked with 20+ rows;
        // the vault view scrolls vertically inside.
        super.init(
            width: 480,
            height: nil,
            icon: "lollipop",
            statusItemLength: NSStatusItem.variableLength
        )
        setupObserver()
        startVaultRefreshTimer()
    }

    private func startVaultRefreshTimer() {
        // Kick once on launch (after a 5s grace so the menubar appears first).
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.service.refreshVaultTokens()
            self?.service.refreshProviderQuotas()
        }
        vaultRefreshTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in
            self?.service.refreshVaultTokens()
            self?.service.refreshProviderQuotas()
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Dynamic Menu Bar Label

    private var menuBarLabel: String {
        let statusPrefix: String = {
            switch service.worstStatus {
            case "limit_reached": return "\u{1F36D}\u{1F534}"   // lollipop + red circle
            case "warning":       return "\u{1F36D}\u{26A0}\u{FE0F}" // lollipop + warning
            default:              return "\u{1F36D}"
            }
        }()

        switch labelMode {
        case "expiry":
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
                return "\u{1F36D}\u{26A1}\(u.pct)%"  // lollipop + lightning + pct
            }
            return statusPrefix

        case "count":
            let total = service.accounts.count
            let available = service.accounts.filter {
                $0.liveStatus != "limit_reached" && $0.needsReauth != true
            }.count
            return "\(statusPrefix) \(available)/\(total)"

        case "icon":
            return "\u{1F36D}"

        default: // "capacity" -- best available account's 5h free %
            let best = service.accounts
                .filter { $0.liveStatus != "limit_reached" && $0.needsReauth != true }
                .sorted { $0.smartScore > $1.smartScore }
                .first
            let freeStr = best.map { " \(max(0, 100 - Int($0.utilization5h * 100)))%" } ?? ""
            return "\(statusPrefix)\(freeStr)"
        }
    }

    // MARK: - Observer

    private func setupObserver() {
        service.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.refreshMenuBarLabel()
            }
            .store(in: &cancellables)
    }

    /// Re-render the text label in the menu bar (image + length).
    /// Does NOT mutate iconName or badgeCount, avoiding infinite recursion.
    private func refreshMenuBarLabel() {
        guard let button = statusBarButton else { return }
        let image = renderIcon()
        button.image = image
        // Fit status item width to the rendered label
        if let img = image {
            setStatusItemLength(img.size.width + 6)
        }
    }

    // MARK: - OnlyBarController Overrides

    override func renderIcon() -> NSImage? {
        let text = menuBarLabel
        let font = NSFont.systemFont(ofSize: 14)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.labelColor,
        ]
        let textSize = (text as NSString).size(withAttributes: attrs)
        let padding: CGFloat = 2
        let width = ceil(textSize.width) + padding * 2
        let height = ceil(textSize.height) + padding

        let image = NSImage(size: NSSize(width: width, height: height))
        image.lockFocus()
        let drawRect = NSRect(
            x: padding,
            y: (height - textSize.height) / 2,
            width: textSize.width,
            height: textSize.height
        )
        (text as NSString).draw(in: drawRect, withAttributes: attrs)
        image.unlockFocus()
        return image
    }

    override func makeBody() -> AnyView {
        AnyView(VaultView(service: service))
    }
}
