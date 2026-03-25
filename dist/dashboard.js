"use strict";
/**
 * Usage analytics dashboard — serves a self-contained local HTML page.
 *
 * `sweech dashboard` starts an HTTP server on a random available port,
 * serves a single HTML page with inline CSS/JS (no external deps), and
 * opens the browser.
 *
 * Data sources:
 *   - ~/.sweech/history.json  (usageHistory.ts — hourly utilization snapshots)
 *   - ~/.sweech/usage.json    (usage.ts — launch records per profile)
 *   - getAccountInfo()        (subscriptions.ts — live account status)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDashboard = startDashboard;
exports._generateHTML = generateHTML;
exports._collectDashboardData = collectDashboardData;
const http = __importStar(require("http"));
const child_process_1 = require("child_process");
const usageHistory_1 = require("./usageHistory");
const usage_1 = require("./usage");
const config_1 = require("./config");
const subscriptions_1 = require("./subscriptions");
const platform_1 = require("./platform");
async function collectDashboardData() {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const tracker = new usage_1.UsageTracker();
    const stats = tracker.getStats();
    const accountRefs = (0, subscriptions_1.getKnownAccounts)(profiles);
    let accounts = [];
    try {
        accounts = await (0, subscriptions_1.getAccountInfo)(accountRefs);
    }
    catch { /* proceed without live data */ }
    const history = (0, usageHistory_1.getHistory)(168); // 7 days
    return {
        generatedAt: new Date().toISOString(),
        history,
        launchStats: stats.map(s => ({
            commandName: s.commandName,
            totalUses: s.totalUses,
            lastUsed: s.lastUsed,
        })),
        accounts,
    };
}
// ── HTML generation ──────────────────────────────────────────────────────────
function generateHTML(data) {
    const jsonData = JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sweech dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --bar-bg: #21262d;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    max-width: 1200px;
    margin: 0 auto;
  }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-bottom: 12px; color: var(--accent); }
  .subtitle { color: var(--text-dim); font-size: 14px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .card-full { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 8px 12px; color: var(--text-dim); border-bottom: 1px solid var(--border); font-weight: 500; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .bar-container {
    width: 100%;
    height: 20px;
    background: var(--bar-bg);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }
  .bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;
  }
  .bar-label {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    color: var(--text);
    font-weight: 500;
  }
  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .status-green { background: var(--green); }
  .status-yellow { background: var(--yellow); }
  .status-red { background: var(--red); }
  .status-gray { background: var(--text-dim); }
  .chart-container { position: relative; }
  .chart-svg { width: 100%; height: 200px; }
  .chart-svg .line { fill: none; stroke: var(--accent); stroke-width: 2; }
  .chart-svg .area { fill: var(--accent); opacity: 0.1; }
  .chart-svg .grid-line { stroke: var(--border); stroke-width: 1; stroke-dasharray: 4 2; }
  .chart-svg .axis-label { fill: var(--text-dim); font-size: 11px; }
  .chart-legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--text-dim); }
  .chart-legend .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .empty { color: var(--text-dim); font-style: italic; padding: 24px; text-align: center; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
  }
  .badge-ok { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .badge-warn { background: rgba(210, 153, 34, 0.15); color: var(--yellow); }
  .badge-err { background: rgba(248, 81, 73, 0.15); color: var(--red); }
  .badge-dim { background: rgba(139, 148, 158, 0.15); color: var(--text-dim); }
  footer { text-align: center; color: var(--text-dim); font-size: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<h1>sweech dashboard</h1>
<p class="subtitle" id="generated-at"></p>

<div class="grid">
  <!-- Usage over last 7 days chart -->
  <div class="card card-full">
    <h2>Usage over last 7 days</h2>
    <div class="chart-container" id="history-chart"></div>
  </div>

  <!-- Top profiles by launch count -->
  <div class="card">
    <h2>Top profiles by launches</h2>
    <div id="launch-stats"></div>
  </div>

  <!-- Account status -->
  <div class="card">
    <h2>Account status</h2>
    <div id="account-status"></div>
  </div>

  <!-- Detailed account table -->
  <div class="card card-full">
    <h2>Account details</h2>
    <div id="account-details"></div>
  </div>
</div>

<footer>sweech usage analytics &middot; data from ~/.sweech/</footer>

<script>
const DATA = ${jsonData};

// ── Helpers ──
function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

function barColor(ratio) {
  if (ratio <= 0.5) return 'var(--green)';
  if (ratio <= 0.8) return 'var(--yellow)';
  return 'var(--red)';
}

function statusClass(status, needsReauth) {
  if (needsReauth) return 'status-red';
  if (!status) return 'status-gray';
  if (status === 'allowed') return 'status-green';
  if (status === 'allowed_warning' || status === 'warning') return 'status-yellow';
  if (status === 'rejected' || status === 'limit_reached') return 'status-red';
  return 'status-gray';
}

function badgeClass(status, needsReauth) {
  if (needsReauth) return 'badge-err';
  if (!status) return 'badge-dim';
  if (status === 'allowed') return 'badge-ok';
  if (status === 'allowed_warning' || status === 'warning') return 'badge-warn';
  return 'badge-err';
}

function badgeLabel(status, needsReauth) {
  if (needsReauth) return 'reauth';
  if (!status) return 'unknown';
  return status.replace(/_/g, ' ');
}

// ── Generated-at ──
document.getElementById('generated-at').textContent =
  'Generated ' + new Date(DATA.generatedAt).toLocaleString();

// ── History chart (SVG) ──
(function renderHistoryChart() {
  const container = document.getElementById('history-chart');
  if (!DATA.history || DATA.history.length === 0) {
    container.innerHTML = '<div class="empty">No history data yet. Usage snapshots are recorded hourly.</div>';
    return;
  }

  // Collect all account names
  const accountNames = new Set();
  DATA.history.forEach(function(e) { Object.keys(e.accounts).forEach(function(n) { accountNames.add(n); }); });
  const names = Array.from(accountNames);

  // Colors for up to 8 accounts
  var colors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#f778ba', '#79c0ff', '#ffa657'];

  var W = 800, H = 200, PAD_L = 40, PAD_R = 20, PAD_T = 10, PAD_B = 30;
  var chartW = W - PAD_L - PAD_R;
  var chartH = H - PAD_T - PAD_B;

  var minT = DATA.history[0].timestamp;
  var maxT = DATA.history[DATA.history.length - 1].timestamp;
  var range = maxT - minT || 1;

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg">';

  // Grid lines
  for (var g = 0; g <= 4; g++) {
    var gy = PAD_T + (g / 4) * chartH;
    var pct = Math.round((1 - g / 4) * 100);
    svg += '<line class="grid-line" x1="' + PAD_L + '" y1="' + gy + '" x2="' + (W - PAD_R) + '" y2="' + gy + '"/>';
    svg += '<text class="axis-label" x="' + (PAD_L - 4) + '" y="' + (gy + 4) + '" text-anchor="end">' + pct + '%</text>';
  }

  // X-axis labels (day labels)
  var dayMs = 86400000;
  var startDay = new Date(minT); startDay.setHours(0,0,0,0);
  for (var d = startDay.getTime(); d <= maxT; d += dayMs) {
    var dx = PAD_L + ((d - minT) / range) * chartW;
    if (dx >= PAD_L && dx <= W - PAD_R) {
      var dayLabel = new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      svg += '<text class="axis-label" x="' + dx + '" y="' + (H - 4) + '" text-anchor="middle">' + dayLabel + '</text>';
    }
  }

  // Lines per account
  names.forEach(function(name, idx) {
    var color = colors[idx % colors.length];
    var points = [];
    DATA.history.forEach(function(e) {
      var val = e.accounts[name];
      if (!val) return;
      var x = PAD_L + ((e.timestamp - minT) / range) * chartW;
      var y = PAD_T + (1 - val.u7d) * chartH;
      points.push(x + ',' + y);
    });
    if (points.length > 1) {
      // Area
      var first = points[0].split(',');
      var last = points[points.length - 1].split(',');
      var areaPath = 'M' + points.join(' L') + ' L' + last[0] + ',' + (PAD_T + chartH) + ' L' + first[0] + ',' + (PAD_T + chartH) + ' Z';
      svg += '<path d="' + areaPath + '" fill="' + color + '" opacity="0.08"/>';
      svg += '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2"/>';
    }
  });

  svg += '</svg>';

  // Legend
  var legend = '<div class="chart-legend">';
  names.forEach(function(name, idx) {
    var color = colors[idx % colors.length];
    legend += '<span><span class="swatch" style="background:' + color + '"></span>' + name + '</span>';
  });
  legend += '</div>';

  container.innerHTML = svg + legend;
})();

// ── Launch stats ──
(function renderLaunchStats() {
  var el = document.getElementById('launch-stats');
  var stats = (DATA.launchStats || []).slice().sort(function(a, b) { return b.totalUses - a.totalUses; });
  if (stats.length === 0) {
    el.innerHTML = '<div class="empty">No launch data yet.</div>';
    return;
  }
  var maxUses = stats[0].totalUses || 1;
  var html = '<table><thead><tr><th>Profile</th><th>Launches</th><th>Last used</th></tr></thead><tbody>';
  stats.forEach(function(s) {
    var pct = Math.round((s.totalUses / maxUses) * 100);
    html += '<tr><td><strong>' + s.commandName + '</strong></td>';
    html += '<td><div class="bar-container" style="min-width:120px"><div class="bar-fill" style="width:' + pct + '%;background:var(--accent)"></div><span class="bar-label">' + s.totalUses + '</span></div></td>';
    html += '<td style="color:var(--text-dim)">' + timeAgo(s.lastUsed) + '</td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
})();

// ── Account status ──
(function renderAccountStatus() {
  var el = document.getElementById('account-status');
  var accounts = DATA.accounts || [];
  if (accounts.length === 0) {
    el.innerHTML = '<div class="empty">No accounts found.</div>';
    return;
  }
  var html = '<table><thead><tr><th>Account</th><th>Status</th><th>Plan</th></tr></thead><tbody>';
  accounts.forEach(function(a) {
    var live = a.live || {};
    var sc = statusClass(live.status, a.needsReauth);
    var bc = badgeClass(live.status, a.needsReauth);
    var bl = badgeLabel(live.status, a.needsReauth);
    html += '<tr><td><span class="status-dot ' + sc + '"></span><strong>' + a.commandName + '</strong></td>';
    html += '<td><span class="badge ' + bc + '">' + bl + '</span></td>';
    html += '<td>' + (a.meta && a.meta.plan ? a.meta.plan : '<span style="color:var(--text-dim)">-</span>') + '</td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
})();

// ── Account details ──
(function renderAccountDetails() {
  var el = document.getElementById('account-details');
  var accounts = DATA.accounts || [];
  if (accounts.length === 0) {
    el.innerHTML = '<div class="empty">No accounts found.</div>';
    return;
  }
  var html = '<table><thead><tr><th>Account</th><th>5h usage</th><th>Weekly usage</th><th>Messages (5h/7d)</th><th>Last active</th></tr></thead><tbody>';
  accounts.forEach(function(a) {
    var live = a.live || {};
    var u5h = live.utilization5h != null ? live.utilization5h : (live.buckets && live.buckets[0] && live.buckets[0].session ? live.buckets[0].session.utilization : null);
    var u7d = live.utilization7d != null ? live.utilization7d : (live.buckets && live.buckets[0] && live.buckets[0].weekly ? live.buckets[0].weekly.utilization : null);

    html += '<tr><td><strong>' + a.commandName + '</strong></td>';

    // 5h bar
    if (u5h != null) {
      var pct5 = Math.round(u5h * 100);
      html += '<td><div class="bar-container"><div class="bar-fill" style="width:' + pct5 + '%;background:' + barColor(u5h) + '"></div><span class="bar-label">' + pct5 + '%</span></div></td>';
    } else {
      html += '<td style="color:var(--text-dim)">-</td>';
    }

    // 7d bar
    if (u7d != null) {
      var pct7 = Math.round(u7d * 100);
      html += '<td><div class="bar-container"><div class="bar-fill" style="width:' + pct7 + '%;background:' + barColor(u7d) + '"></div><span class="bar-label">' + pct7 + '%</span></div></td>';
    } else {
      html += '<td style="color:var(--text-dim)">-</td>';
    }

    html += '<td>' + a.messages5h + ' / ' + a.messages7d + '</td>';
    html += '<td style="color:var(--text-dim)">' + timeAgo(a.lastActive) + '</td></tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
})();
</script>
</body>
</html>`;
}
// ── Server ───────────────────────────────────────────────────────────────────
/**
 * Start the dashboard server on a random available port and open the browser.
 * Returns the server instance and the chosen port for test use.
 */
async function startDashboard(options) {
    const data = await collectDashboardData();
    const html = generateHTML(data);
    const requestedPort = options?.port ?? 0; // 0 = random available port
    const shouldOpen = options?.open !== false;
    return new Promise((resolve, reject) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
            });
            res.end(html);
        });
        server.listen(requestedPort, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }
            const port = addr.port;
            const url = `http://127.0.0.1:${port}`;
            if (shouldOpen) {
                openBrowser(url);
            }
            resolve({ server, port });
        });
        server.on('error', reject);
    });
}
function openBrowser(url) {
    const cmd = (0, platform_1.isMacOS)()
        ? `open "${url}"`
        : (0, platform_1.isWindows)()
            ? `start "" "${url}"`
            : `xdg-open "${url}"`; // Linux
    (0, child_process_1.exec)(cmd, () => { });
}
