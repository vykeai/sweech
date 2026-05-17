/**
 * Codex CLI config.toml writer.
 *
 * The codex CLI (>= 0.x) reads provider configuration from
 * `$CODEX_HOME/config.toml`. Environment variables exported by the sweech
 * wrapper (OPENAI_API_KEY / OPENAI_BASE_URL / etc.) are NOT consulted by
 * codex for picking a provider; without an explicit
 * `[model_providers.<name>]` block plus a top-level `model_provider`,
 * codex falls through to the ChatGPT OAuth login flow even when the user
 * configured a custom provider.
 *
 * This module writes (and merges with any existing) a TOML block so that
 * custom providers are honoured. The official OpenAI provider is left
 * alone because codex handles it natively via ChatGPT login.
 *
 * Codex 0.x constraint: only `wire_api = "responses"` works. `wire_api =
 * "chat"` was removed. Plain llama.cpp/LM Studio servers need a Responses
 * API translator (LiteLLM, etc.) in front of them -- that's the user's
 * responsibility; we always emit `wire_api = "responses"`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from './atomicWrite';
import { ProviderConfig } from './providers';

// -- tiny TOML emitter ------------------------------------------------------

/**
 * Escape a string for safe inclusion inside a TOML double-quoted value.
 * Handles: backslash, double-quote, tab, newline, carriage return.
 */
export function tomlEscape(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Quote a string as a TOML basic string (always double-quoted).
 */
function quote(str: string): string {
  return `"${tomlEscape(str)}"`;
}

// -- provider name sanitisation --------------------------------------------

/**
 * Codex requires provider section names that are valid TOML bare keys --
 * `[a-zA-Z0-9_-]+`. Anything outside that set must be replaced. We also
 * lowercase for consistency.
 */
export function sanitizeProviderName(raw: string): string {
  const lowered = raw.toLowerCase().trim();
  const cleaned = lowered.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'custom';
}

/**
 * Build the env-var key used to surface the API key to codex. Codex reads
 * `env_key = "NAME"` and then looks up `process.env.NAME` at runtime, so
 * the wrapper must export that variable. Convention: uppercase provider
 * name + `_API_KEY`, with `-` replaced by `_`.
 */
export function providerEnvKey(providerName: string): string {
  const sanitized = sanitizeProviderName(providerName);
  return `${sanitized.replace(/-/g, '_').toUpperCase()}_API_KEY`;
}

// -- existing-file parser ---------------------------------------------------

interface ParsedToml {
  /** Top-level (pre-section) lines, verbatim except for the keys we manage. */
  topLines: string[];
  /** Section name to array of raw body lines (between header and next header). */
  sections: Map<string, string[]>;
  /** Order in which sections originally appeared, so we round-trip cleanly. */
  sectionOrder: string[];
}

/**
 * Parse a TOML file into top lines + sections. This is intentionally
 * minimal -- it only understands enough structure to round-trip the
 * `[model_providers.*]` blocks we manage and preserve everything else
 * verbatim.
 */
export function parseToml(text: string): ParsedToml {
  const topLines: string[] = [];
  const sections = new Map<string, string[]>();
  const sectionOrder: string[] = [];

  let currentSection: string | null = null;
  let currentBody: string[] = [];

  // Section header recognition. Inline tables (`{...}`) are NOT section
  // headers -- we deliberately only match `[name]` and `[name.sub]` lines
  // where the header is the only meaningful content on the line.
  const headerRe = /^\s*\[([^\[\]]+)\]\s*$/;

  for (const rawLine of text.split(/\r?\n/)) {
    const m = headerRe.exec(rawLine);
    if (m) {
      // Flush previous section
      if (currentSection !== null) {
        sections.set(currentSection, currentBody);
        sectionOrder.push(currentSection);
      }
      currentSection = m[1].trim();
      currentBody = [];
      continue;
    }
    if (currentSection === null) {
      topLines.push(rawLine);
    } else {
      currentBody.push(rawLine);
    }
  }

  if (currentSection !== null) {
    sections.set(currentSection, currentBody);
    sectionOrder.push(currentSection);
  }

  return { topLines, sections, sectionOrder };
}

/**
 * Set a top-level `key = "value"` entry, replacing any existing line for
 * that key. New entries are appended to the end of the top-level block,
 * trimming a single trailing empty line first to avoid a stack of blank
 * lines after repeated rewrites.
 */
export function setTopLevelString(topLines: string[], key: string, value: string): string[] {
  // Match `key = anything` (with or without leading whitespace, allowing
  // any value form). We replace the entire line.
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*=`);
  const newLine = `${key} = ${quote(value)}`;
  let replaced = false;
  const out = topLines.map(line => {
    if (!replaced && keyRe.test(line)) {
      replaced = true;
      return newLine;
    }
    return line;
  });
  if (!replaced) {
    // Trim a single trailing empty line so the appended block looks clean.
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    if (out.length > 0) out.push('');
    out.push(newLine);
  }
  return out;
}

// -- serializer -------------------------------------------------------------

function serializeToml(parsed: ParsedToml): string {
  const parts: string[] = [];
  if (parsed.topLines.length > 0) {
    parts.push(parsed.topLines.join('\n'));
  }
  for (const name of parsed.sectionOrder) {
    const body = parsed.sections.get(name) ?? [];
    // Ensure a blank line separates sections.
    if (parts.length > 0 && parts[parts.length - 1] !== '') parts.push('');
    parts.push(`[${name}]`);
    // Drop a trailing empty line in the body to avoid stacking.
    let trimmed = body.slice();
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
    if (trimmed.length > 0) parts.push(trimmed.join('\n'));
  }
  // Always end with a trailing newline.
  let out = parts.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

// -- high-level helpers -----------------------------------------------------

/**
 * Build the body lines for a `[model_providers.<name>]` block.
 */
export function buildProviderBlock(opts: {
  displayName: string;
  baseUrl: string;
  envKey: string;
}): string[] {
  return [
    `name = ${quote(opts.displayName)}`,
    `base_url = ${quote(opts.baseUrl)}`,
    `wire_api = "responses"`,
    `env_key = ${quote(opts.envKey)}`,
  ];
}

/**
 * Should we write a `[model_providers.*]` block for this profile?
 *
 * Codex talks to the official OpenAI service natively via the ChatGPT
 * login flow -- no provider block needed (writing one would interfere with
 * that flow). Every other provider (custom, kimi, grok, openrouter, ...)
 * needs an explicit block so codex actually routes there.
 */
export function shouldWriteCodexProviderBlock(cliName: string, providerName: string): boolean {
  if (cliName !== 'codex') return false;
  if (providerName === 'openai') return false;
  return true;
}

export interface WriteCodexProviderTomlOptions {
  /** Absolute path of `$CODEX_HOME` (== sweech profile dir for this command). */
  codexHome: string;
  /** Raw provider name from `ProviderConfig.name` (e.g. `kimi`, `custom`). */
  providerName: string;
  /** Human-readable display name for the block's `name = ...` field. */
  displayName: string;
  /** Effective base URL (already URL-validated upstream). */
  baseUrl: string;
  /** Effective default model id (e.g. `moonshot-v1-128k`). */
  model?: string;
}

/**
 * Write (or merge) the `[model_providers.<name>]` block for a codex
 * custom provider into `$CODEX_HOME/config.toml`. Creates the file if
 * missing. Preserves any existing top-level keys and other
 * `[model_providers.*]` blocks.
 *
 * No-op if the target is the official OpenAI provider (handled natively).
 */
export function writeCodexProviderToml(opts: WriteCodexProviderTomlOptions): void {
  const safeName = sanitizeProviderName(opts.providerName);
  const sectionName = `model_providers.${safeName}`;

  // Read existing file if present; otherwise start fresh.
  const configPath = path.join(opts.codexHome, 'config.toml');
  let existing = '';
  if (fs.existsSync(configPath)) {
    try {
      existing = fs.readFileSync(configPath, 'utf-8');
    } catch {
      // If we can't read it (corrupt, permission), start from empty rather
      // than crash mid profile creation. The atomic write below leaves the
      // old file in place if rename ever fails.
      existing = '';
    }
  }

  const parsed = parseToml(existing);

  // Build new provider block.
  const blockBody = buildProviderBlock({
    displayName: opts.displayName,
    baseUrl: opts.baseUrl,
    envKey: providerEnvKey(opts.providerName),
  });

  // Replace or insert the [model_providers.<name>] section.
  if (parsed.sections.has(sectionName)) {
    parsed.sections.set(sectionName, blockBody);
  } else {
    parsed.sections.set(sectionName, blockBody);
    parsed.sectionOrder.push(sectionName);
  }

  // Set top-level model_provider so codex actually uses it by default.
  parsed.topLines = setTopLevelString(parsed.topLines, 'model_provider', safeName);
  if (opts.model && opts.model.trim()) {
    parsed.topLines = setTopLevelString(parsed.topLines, 'model', opts.model.trim());
  }

  // Ensure the directory exists (createProfileConfig usually creates it,
  // but this helper is callable independently).
  if (!fs.existsSync(opts.codexHome)) {
    fs.mkdirSync(opts.codexHome, { recursive: true, mode: 0o700 });
  }

  const serialized = serializeToml(parsed);
  atomicWriteFileSync(configPath, serialized);
  // Tighten permissions; the file holds no secrets (the API key lives in
  // settings.json), but config.toml is account-specific and lives inside
  // a profile dir already restricted to 0700. We chmod to 0600 to match
  // the kimi config.toml convention.
  try { fs.chmodSync(configPath, 0o600); } catch { /* best-effort */ }
}

/**
 * Resolve the codex home for a sweech profile name. Mirrors
 * `ConfigManager.getProfileDir` so callers don't need a ConfigManager
 * handle in test/helper code.
 */
export function codexHomeFor(profileName: string): string {
  return path.join(os.homedir(), `.${profileName}`);
}

/**
 * Convenience wrapper: take a sweech profile + provider and write the
 * codex config.toml. Used by profileCreation.createProfile after the
 * settings.json is in place.
 */
export function writeCodexProviderTomlForProfile(
  profileName: string,
  provider: ProviderConfig,
  cliName: string,
  baseUrlOverride?: string,
  modelOverride?: string,
): void {
  if (!shouldWriteCodexProviderBlock(cliName, provider.name)) return;

  const baseUrl = (baseUrlOverride || provider.baseUrl || '').trim();
  if (!baseUrl) {
    // Without a base URL, codex has nothing to talk to -- there's no
    // useful block to write. Skip silently; the user will see codex
    // surface its own error on first run.
    return;
  }

  writeCodexProviderToml({
    codexHome: codexHomeFor(profileName),
    providerName: provider.name,
    displayName: provider.displayName || provider.name,
    baseUrl,
    model: modelOverride || provider.defaultModel,
  });
}
