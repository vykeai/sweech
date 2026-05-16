import Foundation
import AppKit
import UserNotifications

struct LiveBucket: Codable {
    let label: String
    let session: BucketWindow?
    let weekly: BucketWindow?

    struct BucketWindow: Codable {
        let utilization: Double
        let resetsAt: Double?
    }
}

struct LiveData: Codable {
    let buckets: [LiveBucket]?
    let status: String?
    let planType: String?
    let representativeClaim: String?
    let isStale: Bool?
    let tokenStatus: String?
    let tokenRefreshedAt: Double?
    let tokenExpiresAt: Double?

    /// Canonical first bucket — "All models" or whatever the API marks primary.
    /// SwiftBar always renders from this; deprecated top-level mirrors are gone (T-057).
    var primaryBucket: LiveBucket? { buckets?.first }

    /// 5h session utilization from the canonical bucket. 0 when absent.
    var utilization5h: Double? { primaryBucket?.session?.utilization }
    /// 7d weekly utilization from the canonical bucket. 0 when absent.
    var utilization7d: Double? { primaryBucket?.weekly?.utilization }
    /// 5h session reset epoch (seconds) from the canonical bucket.
    var reset5hAt: Double? { primaryBucket?.session?.resetsAt }
    /// 7d weekly reset epoch (seconds) from the canonical bucket.
    var reset7dAt: Double? { primaryBucket?.weekly?.resetsAt }
}

/// Burn-rate forecast emitted by the CLI (`projection5h` / `projection7d` on
/// each account). `etaToFullMinutes` is null when the rate is flat or
/// utilization is falling — we deliberately refuse to project then.
struct QuotaProjection: Codable {
    let rateUtilPerMinute: Double
    let etaToFullMinutes: Double?
    let sampleCount: Int
}

struct SweechAccount: Codable, Identifiable {
    var id: String { commandName }
    let name: String
    let commandName: String
    let cliType: String?
    let isDefault: Bool?
    let sharedWith: String?
    let provider: String?
    /// Custom base URL from sweech config. Presence == proxy.
    let baseUrl: String?
    /// Real upstream vendor derived from (provider, baseUrl) by the CLI.
    let effectiveProvider: String?
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
    let tokenStatus: String?
    let tokenRefreshedAt: Double?
    let tokenExpiresAt: Double?

    /// Vault account currently mounted in this workspace.
    let activeAccount: ActiveAccount?

    // Precomputed by CLI — single source of truth for sorting/ranking
    let precomputedSmartScore: Double?
    let tier: String?          // "use_first", "use_next", "normal"
    let tierUrgent: Bool?
    let sortRank: Int?
    let precomputedDisplayGroup: String?

    /// Burn-rate ETA for the rolling 5h window. Null when CLI lacks ≥3 samples.
    let projection5h: QuotaProjection?
    /// Burn-rate ETA for the 7d weekly window.
    let projection7d: QuotaProjection?

    private enum CodingKeys: String, CodingKey {
        case name, commandName, cliType, isDefault, sharedWith, provider, baseUrl, effectiveProvider
        case meta, messages5h, messages7d, totalMessages
        case minutesUntilFirstCapacity, hoursUntilWeeklyReset, oldest5hMessageAt
        case lastActive, needsReauth, live, tokenStatus, tokenRefreshedAt, tokenExpiresAt
        case activeAccount
        case precomputedSmartScore = "smartScore"
        case tier, tierUrgent, sortRank, precomputedDisplayGroup = "displayGroup"
        case projection5h, projection7d
    }

    /// The shortest meaningful burn-rate ETA across the 5h/7d projections,
    /// or nil when neither has a forward-looking number. Picks the 7d window
    /// when both are available — that's the one quotas typically exhaust against.
    var bestProjectionEtaMinutes: Double? {
        if let e = projection7d?.etaToFullMinutes, e > 0 { return e }
        if let e = projection5h?.etaToFullMinutes, e > 0 { return e }
        return nil
    }

    /// Human-readable label for the active projection, e.g. "ETA 47m".
    /// Empty string when no projection is available.
    var projectionLabel: String {
        guard let mins = bestProjectionEtaMinutes else { return "" }
        if mins < 60 { return "ETA \(Int(mins.rounded()))m" }
        if mins < 60 * 24 { return "ETA \(Int((mins / 60).rounded()))h" }
        return "ETA \(Int((mins / (60 * 24)).rounded()))d"
    }

    /// The real upstream provider key (e.g. "local-proxy", "glm", "kimi-coding",
    /// "anthropic", "openai"). Falls back to the legacy `provider` field if
    /// the CLI didn't precompute it.
    var realProvider: String { effectiveProvider ?? provider ?? "" }

    struct ActiveAccount: Codable {
        let id: String
        let kind: String  // "anthropic" | "openai"
        let email: String
        let plan: String?
    }

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
    var isDefaultAccount: Bool { isDefault ?? false }

    var utilization5h: Double { live?.utilization5h ?? 0 }
    var utilization7d: Double { live?.utilization7d ?? 0 }

    var liveStatus: String { live?.status ?? "unknown" }
    /// Workspace plan label. Resolution order:
    ///   1. live.planType         — codex returns it on every probe
    ///   2. meta.plan             — user-set or CLI-derived (already
    ///                              demoted to "OAuth disabled" /
    ///                              "Re-login needed" when liveUsage
    ///                              detects a 401/403 — so this is the
    ///                              authoritative answer when present)
    ///   3. activeAccount.plan    — vault snapshot, used only when the
    ///                              workspace has no live probe yet
    ///                              AND the live status is clean
    var planType: String? {
        if let p = live?.planType { return p }
        if let p = meta?.plan { return p }
        // Don't fall back to the vault's stored plan when live data
        // indicates the OAuth identity is broken — the vault plan
        // captured at import time would be misleadingly stale.
        let badStatus: Set<String> = ["org_disabled", "unauthorized", "forbidden", "limit_reached"]
        if let s = live?.status, badStatus.contains(s) { return nil }
        return activeAccount?.plan
    }

    /// Display group for UI grouping: 'claude', 'codex', or provider display name.
    /// Uses precomputed value from CLI (single source of truth) when available.
    /// Falls back to local computation for older CLI versions without displayGroup.
    var displayGroup: String {
        if let precomputed = precomputedDisplayGroup, !precomputed.isEmpty { return precomputed }
        guard let provider else { return cliType ?? "claude" }
        switch provider {
        case "anthropic": return "claude"
        case "openai":    return "codex"
        default:          return providerLabel
        }
    }

    /// Short human-readable provider label — uses realProvider so
    /// proxy workspaces (provider=anthropic + baseUrl=127.0.0.1) surface
    /// as "Local Proxy" instead of misleadingly as "Claude".
    var providerLabel: String {
        let key = realProvider.isEmpty ? (cliType ?? "claude") : realProvider
        let labels: [String: String] = [
            "anthropic": "Claude",
            "openai": "OpenAI",
            "dashscope": "Alibaba Cloud",
            "glm": "ZAI (Zhipu)",
            "minimax": "MiniMax",
            "kimi-coding": "Kimi",
            "kimi": "Kimi",
            "deepseek": "DeepSeek",
            "qwen": "Qwen",
            "openrouter": "OpenRouter",
            "ollama": "Ollama",
            "ollama-cloud": "Ollama Cloud",
            "local-ollama": "Ollama (Local)",
            "local-proxy": "Local Proxy",
            "gemini": "Gemini",
            "groq": "Groq",
            "nvidia": "NVIDIA",
        ]
        return labels[key] ?? key
    }

    /// Whether this is an external (non-anthropic / non-openai) provider.
    /// Uses realProvider so a workspace routing through litellm shows
    /// up as external even when its API format is anthropic-compatible.
    var isExternal: Bool {
        let p = realProvider
        return !p.isEmpty && p != "anthropic" && p != "openai"
    }

    var buckets: [LiveBucket] { live?.buckets ?? [] }

    /// True if the token was refreshed within the last 60 seconds
    var wasRecentlyRefreshed: Bool {
        guard let ts = tokenRefreshedAt else { return false }
        return Date().timeIntervalSince1970 * 1000 - ts < 60_000
    }

    /// Human-readable token expiry, e.g. "2h 15m"
    var tokenExpiryRelative: String? {
        guard let epoch = tokenExpiresAt else { return nil }
        // tokenExpiresAt is in milliseconds
        let interval = epoch / 1000 - Date().timeIntervalSince1970
        if interval <= 0 { return "expired" }
        if interval < 3600 { return "\(Int(interval / 60))m" }
        let h = Int(interval / 3600)
        let m = Int((interval.truncatingRemainder(dividingBy: 3600)) / 60)
        return "\(h)h \(m)m"
    }

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

    /// Smart priority score: precomputed by CLI (single source of truth).
    /// Falls back to basic heuristic if CLI doesn't provide it (schema v1).
    var smartScore: Double {
        if let score = precomputedSmartScore { return score }
        // Fallback for older CLI versions without precomputed score
        if needsReauth == true { return -2 }
        if liveStatus == "limit_reached" { return -1 }
        guard let live else { return 0 }
        let remaining7d = 1.0 - (live.utilization7d ?? 0)
        guard let reset7dAt = live.reset7dAt else { return remaining7d / 7.0 }
        let hoursUntilReset = max(0.5, Date(timeIntervalSince1970: reset7dAt).timeIntervalSince(Date()) / 3600)
        let daysLeft = hoursUntilReset / 24.0
        let baseScore = remaining7d / daysLeft
        if hoursUntilReset < 72 && remaining7d > 0 { return 100 + baseScore }
        return baseScore
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
    let providerQuotas: [String: ProviderQuota]?
}

/// Per-vendor quota / balance info from `sweech providers quota --json`.
struct ProviderQuota: Codable, Hashable {
    let provider: String
    let capturedAt: Double
    let balanceUsd: Double?
    let credits: Double?
    let rateLimit: RateLimit?
    let note: String?
    let error: String?

    struct RateLimit: Codable, Hashable {
        let used: Double?
        let limit: Double?
        let resetsAt: Double?
        let units: String?
        let window: String?
    }

    /// One-line human summary suitable for a tile footer.
    var summary: String? {
        if let bal = balanceUsd {
            return String(format: "$%.2f left", bal)
        }
        if let r = rateLimit, let used = r.used, let limit = r.limit, limit > 0 {
            let pct = Int((used / limit) * 100)
            let unit = r.units ?? ""
            return "\(pct)% used (\(Int(used))/\(Int(limit)) \(unit))"
        }
        if let r = rateLimit, let limit = r.limit, limit > 0 {
            return "\(Int(limit)) \(r.units ?? "")"
        }
        return note
    }

    var resetIn: String? {
        guard let ms = rateLimit?.resetsAt else { return nil }
        let secs = ms / 1000 - Date().timeIntervalSince1970
        if secs <= 0 { return nil }
        if secs < 60 { return "\(Int(secs))s" }
        if secs < 3600 { return "\(Int(secs / 60))m" }
        return "\(Int(secs / 3600))h \(Int((secs.truncatingRemainder(dividingBy: 3600)) / 60))m"
    }
}

/// A row in the central credential vault (~/.sweech/accounts.json).
struct VaultAccount: Codable, Identifiable, Hashable {
    var id: String { accountId }
    let accountId: String      // 12-char vault id
    let kind: String           // "anthropic" | "openai"
    let email: String
    let displayName: String?
    let plan: String?
    let rateLimitTier: String?
    let addedAt: String
    let lastRefreshedAt: String?
    let expiresAt: Double?     // ms epoch
    let status: String?

    private enum CodingKeys: String, CodingKey {
        case accountId = "id"
        case kind, email, displayName, plan, rateLimitTier, addedAt, lastRefreshedAt, expiresAt, status
    }

    /// Hides the synthetic <name>@unknown.local placeholders used during import.
    var displayEmail: String {
        email.hasSuffix("@unknown.local") ? "(no email)" : email
    }

    /// Compatibility check: anthropic→claude only, openai→codex only.
    func isCompatible(with cliType: String) -> Bool {
        switch (kind, cliType) {
        case ("anthropic", "claude"): return true
        case ("openai", "codex"): return true
        default: return false
        }
    }

    var expiryLabel: String? {
        guard let expiresAt else { return nil }
        let secs = expiresAt / 1000.0 - Date().timeIntervalSince1970
        if secs < 0 { return "expired" }
        let hours = secs / 3600
        if hours < 24 { return String(format: "%.0fh", hours) }
        return String(format: "%.0fd", hours / 24)
    }
}

struct VaultListResponse: Codable {
    let accounts: [VaultAccount]
}

struct AssignResponse: Codable {
    let ok: Bool
    let workspaceCommandName: String?
    let accountId: String?
    let email: String?
    let reason: String?
}

struct RefreshResult: Codable {
    let email: String
    let kind: String
    let outcome: String   // refreshed | still-valid | no-refresh-token | failed | remounted
    let error: String?
    let expiresAt: Double?
}

struct RefreshResponse: Codable {
    let results: [RefreshResult]
}

struct ManageableProvider: Codable, Identifiable {
    var id: String { "\(cliType)-\(name)" }
    let name: String
    let displayName: String
    let description: String
    let cliType: String
    let supportsOAuth: Bool
    let requiresApiKey: Bool
    let defaultCommandName: String
}

struct ProviderListResponse: Codable {
    let providers: [ManageableProvider]
}

struct ManagedProfileResponse<T: Codable>: Codable {
    let ok: Bool?
    let error: String?
    let profile: T?
}

struct ManagedProfileMutation: Codable {
    let commandName: String?
    let profileDir: String?
    let cliType: String?
    let provider: String?
    let sharedWith: String?
    let oldName: String?
    let newName: String?
    let updatedDependents: [String]?
    let removedDependents: [String]?
}

struct SweechInfo: Codable {
    let version: String?
    let latestVersion: String?
    let updateAvailable: Bool?
}

class SweechService: ObservableObject {
    @Published var accounts: [SweechAccount] = []
    /// Per-vendor balance / rate-limit info from `sweech providers quota`.
    @Published var providerQuotas: [String: ProviderQuota] = [:]
    @Published var isConnected = false
    @Published var isFetching = false
    @Published var lastError: String?
    @Published var lastFetched: Date?
    @Published var accountOrder: [String] = []
    @Published var latestVersion: String?
    @Published var updateAvailable: Bool = false
    @Published var currentVersion: String?
    @Published var manageableProviders: [ManageableProvider] = []
    @Published var isMutatingProfiles = false
    @Published var profileMutationError: String?

    // Vault state
    @Published var vaultAccounts: [VaultAccount] = []
    @Published var isVaultFetching = false
    @Published var lastVaultFetched: Date?
    @Published var vaultError: String?
    @Published var lastAssignError: String?
    @Published var lastRefreshSummary: String?

    private var previousStatuses: [String: String] = [:]  // commandName → liveStatus
    private var previousUtilizations: [String: Double] = [:]  // commandName → utilization7d
    private var consecutiveFailures = 0
    private var lastInfoCheck: Date?

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
        fetchInfo()
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
            // Re-check for updates once per hour
            if let self, self.lastInfoCheck == nil || Date().timeIntervalSince(self.lastInfoCheck!) > 3600 {
                self.fetchInfo()
            }
        }
    }

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func fireStatusChangeNotifications(newAccounts: [SweechAccount]) {
        let notificationsEnabled = UserDefaults.standard.object(forKey: "sweechNotifications") as? Bool ?? true

        for account in newAccounts {
            guard notificationsEnabled else { break }

            // Status change notifications (limit_reached ↔ allowed)
            let old = previousStatuses[account.commandName]
            let new = account.liveStatus
            if let old, old != new {
                let content = UNMutableNotificationContent()
                content.sound = .default

                if new == "limit_reached" {
                    content.title = "Rate limit reached — \(account.name)"
                    content.body = "Switch to another account with: sweech u"
                } else if old == "limit_reached" && new == "allowed" {
                    content.title = "\(account.name) is available again"
                    content.body = "Rate limit window has reset."
                } else {
                    // skip non-interesting transitions
                    previousStatuses[account.commandName] = new
                    continue
                }

                let req = UNNotificationRequest(
                    identifier: "\(account.commandName)-\(new)",
                    content: content, trigger: nil
                )
                UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
            }

            // Usage threshold notifications (crossing 70% or 90%)
            let prevUtil = previousUtilizations[account.commandName] ?? 0
            let curUtil = account.utilization7d
            for threshold in [0.7, 0.9] {
                if prevUtil < threshold && curUtil >= threshold {
                    let pct = Int(curUtil * 100)
                    let remaining = max(0, 100 - pct)
                    let content = UNMutableNotificationContent()
                    content.sound = .default
                    content.title = "\(account.name) — \(pct)% weekly used"
                    content.body = "\(remaining)% of weekly quota remaining. Consider switching to another account."
                    let req = UNNotificationRequest(
                        identifier: "\(account.commandName)-threshold-\(Int(threshold * 100))",
                        content: content, trigger: nil
                    )
                    UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
                }
            }

            // Expiry warning: >20% remaining, resets in <6h
            if let reset7d = account.live?.reset7dAt {
                let hoursLeft = Date(timeIntervalSince1970: reset7d).timeIntervalSince(Date()) / 3600
                let remaining = 1.0 - curUtil
                if hoursLeft > 0 && hoursLeft < 6 && remaining > 0.2 {
                    let prevReset = previousUtilizations[account.commandName]
                    // Only fire once per session — use a different ID per hour range
                    let hourBucket = Int(hoursLeft)
                    let id = "\(account.commandName)-expiry-\(hourBucket)"
                    let content = UNMutableNotificationContent()
                    content.sound = .default
                    content.title = "\(account.name) — \(Int(remaining * 100))% expiring in \(hourBucket)h"
                    content.body = "Weekly quota resets soon. Use it now or it's wasted."
                    let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
                    if prevReset != nil {
                        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
                    }
                }
            }

            previousUtilizations[account.commandName] = curUtil
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
                        if let q = response.providerQuotas { self.providerQuotas = q }
                        self.isConnected = true
                        self.lastError = nil
                        self.lastFetched = Date()
                        self.consecutiveFailures = 0
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
                    self.consecutiveFailures += 1
                    if self.consecutiveFailures == 1 {
                        // First failure: try starting daemon, then retry once
                        NSLog("SweechBar: fetch failed, attempting to start daemon...")
                        self.ensureDaemonAndRetry()
                    } else if self.consecutiveFailures >= 4 {
                        // Persistent failure: reinstall daemon
                        NSLog("SweechBar: %d consecutive failures, reinstalling daemon...", self.consecutiveFailures)
                        self.restartDaemon()
                    }
                }
            }
        }
    }

    private func ensureDaemonAndRetry() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // Try starting the daemon
            _ = Self.runSweech(["daemon", "start"])
            // Give it a moment to initialize
            Thread.sleep(forTimeInterval: 2.0)
            // Retry fetch once
            DispatchQueue.main.async {
                guard let self, !self.isFetching else { return }
                self.isFetching = true
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    let retryResult = Self.runSweech(["usage", "--json"])
                    DispatchQueue.main.async {
                        guard let self else { return }
                        self.isFetching = false
                        switch retryResult {
                        case .success(let data):
                            do {
                                let response = try JSONDecoder().decode(UsageResponse.self, from: data)
                                self.fireStatusChangeNotifications(newAccounts: response.accounts)
                                self.accounts = response.accounts
                                self.isConnected = true
                                self.lastError = nil
                                self.lastFetched = Date()
                                self.consecutiveFailures = 0
                                if self.accountOrder.isEmpty {
                                    self.accountOrder = response.accounts.map { $0.commandName }
                                    self.saveOrder()
                                }
                                NSLog("SweechBar: daemon auto-start succeeded")
                            } catch {
                                NSLog("SweechBar: retry parse error: %@", error.localizedDescription)
                            }
                        case .failure:
                            NSLog("SweechBar: daemon auto-start retry still failing")
                        }
                    }
                }
            }
        }
    }

    // MARK: - Vault

    func fetchVault() {
        DispatchQueue.main.async { [weak self] in self?.isVaultFetching = true }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = Self.runSweech(["accounts", "list", "--json"])
            DispatchQueue.main.async {
                guard let self else { return }
                self.isVaultFetching = false
                switch result {
                case .success(let data):
                    do {
                        let resp = try JSONDecoder().decode(VaultListResponse.self, from: data)
                        self.vaultAccounts = resp.accounts
                        self.lastVaultFetched = Date()
                        self.vaultError = nil
                    } catch {
                        self.vaultError = "Vault parse error: \(error.localizedDescription)"
                    }
                case .failure(let error):
                    self.vaultError = "Vault fetch error: \(error.localizedDescription)"
                }
            }
        }
    }

    func assignAccount(workspaceCommandName: String, email: String, completion: ((Bool) -> Void)? = nil) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Self.runSweech(["assign", workspaceCommandName, email, "--json"])
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let data):
                    do {
                        let resp = try JSONDecoder().decode(AssignResponse.self, from: data)
                        if resp.ok {
                            self.lastAssignError = nil
                            self.fetch()        // refresh workspace usage view
                            completion?(true)
                        } else {
                            self.lastAssignError = resp.reason ?? "Unknown assign error"
                            completion?(false)
                        }
                    } catch {
                        self.lastAssignError = "Assign parse error: \(error.localizedDescription)"
                        completion?(false)
                    }
                case .failure(let error):
                    self.lastAssignError = error.localizedDescription
                    completion?(false)
                }
            }
        }
    }

    /// Probe every third-party provider for current balance / rate-limit
    /// and cache to ~/.sweech/provider-quotas.json. Cached results land
    /// in the next `sweech usage --json` payload via the `providerQuotas`
    /// field. Detached so it doesn't block the menu bar.
    func refreshProviderQuotas(completion: (() -> Void)? = nil) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            _ = Self.runSweech(["providers", "quota", "--refresh", "--json"])
            DispatchQueue.main.async {
                self?.fetch()        // reload usage so the new quotas land
                completion?()
            }
        }
    }

    /// Refresh any expiring tokens in the vault. Used by the 10-min timer.
    func refreshVaultTokens(completion: (() -> Void)? = nil) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = Self.runSweech(["accounts", "refresh", "--json"])
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let data):
                    if let resp = try? JSONDecoder().decode(RefreshResponse.self, from: data) {
                        let refreshed = resp.results.filter { $0.outcome == "refreshed" }.count
                        let failed = resp.results.filter { $0.outcome == "failed" }.count
                        if refreshed > 0 || failed > 0 {
                            self.lastRefreshSummary = "Vault: \(refreshed) refreshed, \(failed) failed"
                        }
                        self.fetchVault()
                    }
                case .failure(let error):
                    NSLog("SweechBar vault refresh failed: %@", error.localizedDescription)
                }
                completion?()
            }
        }
    }

    func fetchInfo() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = Self.runSweech(["info", "--json"])
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let data):
                    do {
                        let info = try JSONDecoder().decode(SweechInfo.self, from: data)
                        self.currentVersion = info.version
                        self.latestVersion = info.latestVersion
                        self.updateAvailable = info.updateAvailable ?? false
                        self.lastInfoCheck = Date()
                    } catch {
                        NSLog("SweechBar info parse error: %@", error.localizedDescription)
                    }
                case .failure(let error):
                    NSLog("SweechBar info fetch error: %@", error.localizedDescription)
                }
            }
        }
    }

    func loadProfileManagementOptions() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let claudeData = try Self.dataFromSweech(["profile", "providers", "--cli", "claude", "--json"])
                let codexData = try Self.dataFromSweech(["profile", "providers", "--cli", "codex", "--json"])
                let claudeProviders = try JSONDecoder().decode(ProviderListResponse.self, from: claudeData).providers
                let codexProviders = try JSONDecoder().decode(ProviderListResponse.self, from: codexData).providers

                DispatchQueue.main.async {
                    self?.manageableProviders = claudeProviders + codexProviders
                    self?.profileMutationError = nil
                }
            } catch {
                DispatchQueue.main.async {
                    self?.profileMutationError = error.localizedDescription
                }
            }
        }
    }

    func createProfile(
        cliType: String,
        provider: String,
        commandName: String,
        authMethod: String,
        apiKey: String?,
        sharedWith: String?
    ) {
        mutateProfiles {
            var args = [
                "profile", "create",
                "--cli", cliType,
                "--provider", provider,
                "--name", commandName,
                "--auth", authMethod,
                "--json"
            ]
            if let apiKey, !apiKey.isEmpty {
                args += ["--api-key", apiKey]
            }
            if let sharedWith, !sharedWith.isEmpty {
                args += ["--shared-with", sharedWith]
            }

            let data = try Self.dataFromSweech(args)
            let response = try JSONDecoder().decode(ManagedProfileResponse<ManagedProfileMutation>.self, from: data)
            if let error = response.error {
                throw NSError(domain: "SweechBar", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
            }
            if let name = response.profile?.commandName {
                DispatchQueue.main.async {
                    self.appendAccountOrder(name)
                }
            }
        }
    }

    func renameProfile(oldName: String, newName: String) {
        mutateProfiles {
            let data = try Self.dataFromSweech(["profile", "rename", oldName, newName, "--json"])
            let response = try JSONDecoder().decode(ManagedProfileResponse<ManagedProfileMutation>.self, from: data)
            if let error = response.error {
                throw NSError(domain: "SweechBar", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
            }
            if let renamed = response.profile?.newName {
                DispatchQueue.main.async {
                    self.replaceAccountOrder(oldName: oldName, newName: renamed)
                }
            }
        }
    }

    func removeProfile(commandName: String, forceDependents: Bool = false) {
        mutateProfiles {
            var args = ["profile", "remove", commandName, "--json"]
            if forceDependents {
                args.append("--force-dependents")
            }

            let data = try Self.dataFromSweech(args)
            let response = try JSONDecoder().decode(ManagedProfileResponse<ManagedProfileMutation>.self, from: data)
            if let error = response.error {
                throw NSError(domain: "SweechBar", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
            }

            DispatchQueue.main.async {
                self.removeFromAccountOrder(commandName)
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

    // MARK: - Launch in Terminal

    static func launchInTerminal(commandName: String) {
        let script = """
        tell application "Terminal"
            activate
            do script "\(commandName)"
        end tell
        """
        DispatchQueue.global(qos: .userInitiated).async {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            proc.arguments = ["-e", script]
            try? proc.run()
            proc.waitUntilExit()
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
        // Use the running app's own bundle path
        if let bundlePath = Bundle.main.executablePath,
           FileManager.default.isExecutableFile(atPath: bundlePath) {
            return bundlePath
        }
        return nil
    }

    private func loadOrder() {
        let defaults = UserDefaults.standard
        accountOrder = defaults.stringArray(forKey: "sweechAccountOrder") ?? []
    }

    private func appendAccountOrder(_ commandName: String) {
        if !accountOrder.contains(commandName) {
            accountOrder.append(commandName)
            saveOrder()
        }
    }

    private func replaceAccountOrder(oldName: String, newName: String) {
        accountOrder = accountOrder.map { $0 == oldName ? newName : $0 }
        if !accountOrder.contains(newName) {
            accountOrder.append(newName)
        }
        saveOrder()
    }

    private func removeFromAccountOrder(_ commandName: String) {
        accountOrder.removeAll { $0 == commandName }
        saveOrder()
    }

    private func saveOrder() {
        UserDefaults.standard.set(accountOrder, forKey: "sweechAccountOrder")
    }

    private func mutateProfiles(_ work: @escaping () throws -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            DispatchQueue.main.async {
                self?.isMutatingProfiles = true
                self?.profileMutationError = nil
            }

            do {
                try work()
                DispatchQueue.main.async {
                    self?.isMutatingProfiles = false
                    self?.fetch()
                }
            } catch {
                DispatchQueue.main.async {
                    self?.isMutatingProfiles = false
                    self?.profileMutationError = error.localizedDescription
                }
            }
        }
    }

    private static func dataFromSweech(_ args: [String]) throws -> Data {
        switch runSweech(args, captureStderr: true) {
        case .success(let data):
            return data
        case .failure(let error):
            throw error
        }
    }

    private static func runSweech(_ args: [String], captureStderr: Bool = false) -> Result<Data, Error> {
        var env = ProcessInfo.processInfo.environment
        let extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", NSString("~/bin").expandingTildeInPath]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = (extraPaths + [currentPath]).joined(separator: ":")

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["sweech"] + args
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        let stderrPipe = captureStderr ? Pipe() : nil
        proc.standardError = stderrPipe ?? FileHandle.nullDevice

        do {
            try proc.run()
            proc.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderrPipe?.fileHandleForReading.readDataToEndOfFile() ?? Data()
            if proc.terminationStatus != 0 {
                let stderrText = String(data: stderrData, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let description = (stderrText?.isEmpty == false ? stderrText! : "sweech exited with code \(proc.terminationStatus)")
                return .failure(NSError(domain: "SweechBar", code: Int(proc.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: description]))
            }
            return .success(data)
        } catch {
            return .failure(error)
        }
    }
}
