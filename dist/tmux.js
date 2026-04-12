"use strict";
/**
 * tmux integration for sweech — wraps CLI launches in named tmux sessions
 * so they survive terminal closure and can be re-attached remotely.
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
exports.isTmuxAvailable = isTmuxAvailable;
exports.isInsideTmux = isInsideTmux;
exports.launchInTmux = launchInTmux;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
function isTmuxAvailable() {
    try {
        (0, child_process_1.execSync)('which tmux', { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
function isInsideTmux() {
    return !!process.env.TMUX;
}
function tmuxSessionExists(name) {
    try {
        (0, child_process_1.execSync)(`tmux has-session -t ${shellQuote(name)}`, { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
function shellQuote(s) {
    if (/^[a-zA-Z0-9_./:@=+-]+$/.test(s))
        return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}
/**
 * Launch a CLI inside a named tmux session.
 *
 * Behaviour:
 *  - Inside tmux: opens a new window named after the profile
 *  - Outside tmux, session exists: attaches to the existing session
 *  - Outside tmux, no session: creates a detached session, then attaches
 */
function launchInTmux(opts) {
    const { command, args, configDirEnvVar, configDir, profileName, resumeArgs = [], hasResume = false, } = opts;
    // Strip redundant command prefix from profile name (e.g. "codex" profile + "codex" command → just use dir)
    const strippedProfile = profileName.replace(new RegExp(`^${command}-?`, 'i'), '') || null;
    const safeProfile = strippedProfile
        ? strippedProfile.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)
        : null;
    const safeDir = path.basename(process.cwd()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 20);
    const sessionName = safeProfile
        ? `sweech-${command}-${safeProfile}-${safeDir}`
        : `sweech-${command}-${safeDir}`;
    // Build env prefix — only sweech-specific vars; rest comes from shell
    const envParts = [];
    if (configDirEnvVar && configDir) {
        envParts.push(`${configDirEnvVar}=${shellQuote(configDir)}`);
    }
    const cmdParts = [...envParts, command, ...args.map(shellQuote)].join(' ');
    let shellCmd;
    if (hasResume && resumeArgs.length > 0) {
        const freshArgs = args.filter(a => !resumeArgs.includes(a));
        const freshCmd = [...envParts, command, ...freshArgs.map(shellQuote)].join(' ');
        shellCmd =
            `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ` +
                `${cmdParts} || (echo 'No conversation to resume — starting fresh session'; ${freshCmd})`;
    }
    else {
        shellCmd = `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${cmdParts}`;
    }
    if (isInsideTmux()) {
        const result = (0, child_process_1.spawnSync)('tmux', ['new-window', '-n', sessionName, shellCmd], {
            stdio: 'inherit',
        });
        return result.status ?? 0;
    }
    if (tmuxSessionExists(sessionName)) {
        process.stderr.write(`sweech: attaching to existing tmux session '${sessionName}'\n`);
        const result = (0, child_process_1.spawnSync)('tmux', ['attach-session', '-t', sessionName], {
            stdio: 'inherit',
        });
        return result.status ?? 0;
    }
    // Create detached session, then attach so the terminal is connected
    (0, child_process_1.spawnSync)('tmux', ['new-session', '-d', '-s', sessionName, shellCmd], { stdio: 'pipe' });
    const result = (0, child_process_1.spawnSync)('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
    return result.status ?? 0;
}
