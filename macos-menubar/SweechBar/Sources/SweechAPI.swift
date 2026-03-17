import Foundation
import AppKit
import UserNotifications

struct LiveBucket: Codable {
    let label: String
    let session: BucketWindow?
    let weekly: BucketWindow?

    struct BucketWindow: Codable {
        let utilization: Double
        let resetsAt: Double
    }
}

struct LiveData: Codable {
    let buckets: [LiveBucket]?
    let status: String?
    let planType: String?
    let utilization5h: Double?
    let utilization7d: Double?
    let reset5hAt: Double?
    let reset7dAt: Double?
    let representativeClaim: String?
}

struct SweechAccount: Codable, Identifiable {
    var id: String { commandName }
    let name: String
    let commandName: String
    let cliType: String?
    let meta: AccountMeta?
    let messages5h: Int?
    let messages7d: Int?
    let totalMessages: Int?
    let minutesUntilFirstCapacity: Int?
    let hoursUntilWeeklyReset: Int?
    let oldest5hMessageAt: String?
    let lastActive: String?
    let needsReauth: Bool?
    let live: LiveData?

    struct AccountMeta: Codable {
        let plan: String?
        let limits: AccountLimits?
    }

    struct AccountLimits: Codable {
        let window5h: Int?
        let window7d: Int?
    }

    var messages5hDisplay: Int { messages5h ?? 0 }
    var messages7dDisplay: Int { messages7d ?? 0 }
    var totalMessagesDisplay: Int { totalMessages ?? 0 }

    var utilization5h: Double { live?.utilization5h ?? 0 }
    var utilization7d: Double { live?.utilization7d ?? 0 }

    var liveStatus: String { live?.status ?? "unknown" }
    var planType: String? { live?.planType ?? meta?.plan }

    var buckets: [LiveBucket] { live?.buckets ?? [] }

    func resetTimeRelative(_ epoch: Double?) -> String? {
        guard let epoch else { return nil }
        let date = Date(timeIntervalSince1970: epoch)
        let interval = date.timeIntervalSince(Date())
        if interval <= 0 { return "now" }
        if interval < 3600 { return "\(Int(interval / 60))m" }
        if interval < 86400 { return "\(Int(interval / 3600))h \(Int((interval.truncatingRemainder(dividingBy: 3600)) / 60))m" }
        return "\(Int(interval / 86400))d"
    }

    var reset5hRelative: String? { resetTimeRelative(live?.reset5hAt) }
    var reset7dRelative: String? { resetTimeRelative(live?.reset7dAt) }

    /// Smart priority score: higher = use this account first.
    /// Rewards accounts with lots of weekly quota that's expiring soon.
    /// Disqualified (limit_reached / needsReauth) always sort to bottom.
    var smartScore: Double {
        if needsReauth == true { return -2 }
        if liveStatus == "limit_reached" { return -1 }
        let remaining7d = 1.0 - (live?.utilization7d ?? 0)
        guard let reset7dAt = live?.reset7dAt else {
            // No reset time = no expiry urgency; treat as if reset is in 7d (the full window)
            let rem = live != nil ? (1.0 - (live?.utilization5h ?? 0)) : remaining7d
            return rem / 7.0
        }
        let hoursUntilReset = max(0.5, Date(timeIntervalSince1970: reset7dAt).timeIntervalSince(Date()) / 3600)
        // remaining / days_until_reset — more quota + sooner expiry = higher score
        return remaining7d / (hoursUntilReset / 24.0)
    }

    var lastActiveRelative: String {
        guard let lastActive else { return "never" }
        let formatter = ISO8601DateFormatter()
        // Try standard ISO8601 first, then with fractional seconds (codex format)
        formatter.formatOptions = [.withInternetDateTime]
        var date = formatter.date(from: lastActive)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            date = formatter.date(from: lastActive)
        }
        // Fallback: try dropping sub-second precision manually
        if date == nil {
            let trimmed = lastActive.replacingOccurrences(
                of: "\\.\\d+", with: "", options: .regularExpression)
            let basic = ISO8601DateFormatter()
            basic.formatOptions = [.withInternetDateTime]
            date = basic.date(from: trimmed)
        }
        guard let date else { return "never" }
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }
}

struct UsageResponse: Codable {
    let accounts: [SweechAccount]
}

class SweechService: ObservableObject {
    @Published var accounts: [SweechAccount] = []
    @Published var isConnected = false
    @Published var isFetching = false
    @Published var lastError: String?
    @Published var lastFetched: Date?
    @Published var accountOrder: [String] = []

    private var previousStatuses: [String: String] = [:]  // commandName → liveStatus

    var worstStatus: String {
        var worst = "allowed"
        for account in accounts {
            let s = account.liveStatus
            if s == "limit_reached" { return "limit_reached" }
            if s == "warning" { worst = "warning" }
        }
        return worst
    }

    /// Accounts sorted by user-defined order, then by name for new ones
    var sortedAccounts: [SweechAccount] {
        if accountOrder.isEmpty { return accounts }
        let ordered = accountOrder.compactMap { id in accounts.first { $0.commandName == id } }
        let rest = accounts.filter { a in !accountOrder.contains(a.commandName) }
        return ordered + rest
    }

    private var timer: Timer?

    init() {
        loadOrder()
        requestNotificationPermission()
        setupTimer()
        fetch()
    }

    func applyRefreshInterval() {
        setupTimer()
        objectWillChange.send()
    }

    private func setupTimer() {
        timer?.invalidate()
        let stored = UserDefaults.standard.integer(forKey: "sweechRefreshInterval")
        let interval = stored > 0 ? Double(stored) : 30.0
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.fetch()
        }
    }

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func fireStatusChangeNotifications(newAccounts: [SweechAccount]) {
        let notificationsEnabled = UserDefaults.standard.object(forKey: "sweechNotifications") as? Bool ?? true
        for account in newAccounts {
            let old = previousStatuses[account.commandName]
            let new = account.liveStatus
            guard old != nil, old != new else { continue }

            guard notificationsEnabled else { continue }

            let content = UNMutableNotificationContent()
            content.sound = .default

            if new == "limit_reached" {
                content.title = "Rate limit reached — \(account.name)"
                content.body = "Switch to another account with: sweech u"
            } else if old == "limit_reached" && new == "allowed" {
                content.title = "\(account.name) is available again"
                content.body = "Rate limit window has reset."
            } else {
                continue
            }

            let req = UNNotificationRequest(
                identifier: "\(account.commandName)-\(new)",
                content: content, trigger: nil
            )
            UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
        }
        previousStatuses = Dictionary(newAccounts.map { ($0.commandName, $0.liveStatus) }, uniquingKeysWith: { $1 })
    }

    func fetch() {
        guard !isFetching else { return }
        isFetching = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Self.runSweech(["usage", "--json"])
            DispatchQueue.main.async {
                guard let self else { return }
                self.isFetching = false
                switch result {
                case .success(let data):
                    do {
                        let response = try JSONDecoder().decode(UsageResponse.self, from: data)
                        self.fireStatusChangeNotifications(newAccounts: response.accounts)
                        self.accounts = response.accounts
                        self.isConnected = true
                        self.lastError = nil
                        self.lastFetched = Date()
                        if self.accountOrder.isEmpty {
                            self.accountOrder = response.accounts.map { $0.commandName }
                            self.saveOrder()
                        }
                    } catch {
                        NSLog("SweechBar parse error: %@", error.localizedDescription)
                        self.lastError = "Parse: \(error.localizedDescription)"
                    }
                case .failure(let error):
                    NSLog("SweechBar fetch error: %@", error.localizedDescription)
                    self.isConnected = false
                    self.lastError = error.localizedDescription
                }
            }
        }
    }

    func moveAccount(from source: IndexSet, to destination: Int) {
        accountOrder.move(fromOffsets: source, toOffset: destination)
        saveOrder()
    }

    func restartDaemon() {
        DispatchQueue.global(qos: .userInitiated).async {
            _ = Self.runSweech(["serve", "--uninstall"])
            _ = Self.runSweech(["serve", "--install"])
        }
    }

    // MARK: - Launch at Login

    private static let plistPath = NSString(
        "~/Library/LaunchAgents/ai.sweech.bar.plist"
    ).expandingTildeInPath

    var launchAtLogin: Bool {
        get { FileManager.default.fileExists(atPath: Self.plistPath) }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        if enabled {
            guard let binaryPath = Bundle.main.executablePath ?? Self.findBinary() else { return }
            let plist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.sweech.bar</string>
    <key>ProgramArguments</key>
    <array>
        <string>\(binaryPath)</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>\(NSString("~/Library/Logs/sweech-bar.log").expandingTildeInPath)</string>
    <key>StandardErrorPath</key>
    <string>\(NSString("~/Library/Logs/sweech-bar.log").expandingTildeInPath)</string>
</dict>
</plist>
"""
            try? plist.write(toFile: Self.plistPath, atomically: true, encoding: .utf8)
            try? FileManager.default.setAttributes([.posixPermissions: 0o644],
                ofItemAtPath: Self.plistPath)
        } else {
            try? FileManager.default.removeItem(atPath: Self.plistPath)
        }
        objectWillChange.send()
    }

    private static func findBinary() -> String? {
        // Walk up from __FILE__ to find the built binary
        let candidates = [
            NSString("~/dev/sweech/macos-menubar/SweechBar/.build/debug/SweechBar").expandingTildeInPath,
            NSString("~/dev/sweech/macos-menubar/SweechBar/.build/release/SweechBar").expandingTildeInPath,
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func loadOrder() {
        let defaults = UserDefaults.standard
        accountOrder = defaults.stringArray(forKey: "sweechAccountOrder") ?? []
    }

    private func saveOrder() {
        UserDefaults.standard.set(accountOrder, forKey: "sweechAccountOrder")
    }

    private static func runSweech(_ args: [String]) -> Result<Data, Error> {
        let nodeCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        guard let nodePath = nodeCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return .failure(NSError(domain: "SweechBar", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "node not found"]))
        }

        let sweechScript = NSString("~/dev/sweech/dist/cli.js").expandingTildeInPath

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [sweechScript] + args
        var env = ProcessInfo.processInfo.environment
        let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", NSString("~/bin").expandingTildeInPath]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = (extraPaths + [currentPath]).joined(separator: ":")
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if proc.terminationStatus != 0 {
                return .failure(NSError(domain: "SweechBar", code: Int(proc.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: "sweech exited with code \(proc.terminationStatus)"]))
            }
            return .success(data)
        } catch {
            return .failure(error)
        }
    }
}
