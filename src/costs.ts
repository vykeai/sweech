/**
 * Single source of truth for model pricing.
 *
 * Pricing is stored as USD per million tokens (per provider's public
 * rate cards as of Jan 2026). Callers (`sweech cost`, the
 * `route_within_budget` API, downstream pre-plan cost forecasts in
 * vykean/codeuctor) hit this module to estimate per-call cost in USD.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Source attribution (read before bumping numbers):
 *   Anthropic  — anthropic.com/pricing                  (last checked 2026-01)
 *   OpenAI     — openai.com/api/pricing                 (last checked 2026-01)
 *   Moonshot   — platform.moonshot.ai/pricing            (last checked 2026-01)
 *   Alibaba    — alibabacloud.com/help/en/model-studio   (last checked 2026-01)
 *   DeepSeek   — api-docs.deepseek.com/quick_start/pricing (last checked 2026-01)
 *   Zhipu/GLM  — docs.z.ai/pricing                       (last checked 2026-01)
 *   xAI Grok   — x.ai/api                                (last checked 2026-01)
 *   OpenRouter — openrouter.ai/models                    (last checked 2026-01)
 *
 * Where exact rate cards weren't published at audit time we use
 * representative values consistent with the provider's tier; bumping
 * those should preserve relative ordering between tiers. The user can
 * override any entry locally via ~/.sweech/pricing.json without
 * patching the binary.
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  input_usd_per_million: number;
  /** USD per 1,000,000 output tokens. */
  output_usd_per_million: number;
  /** Optional: cache-read price (Anthropic/OpenAI prompt caching). */
  cache_read_usd_per_million?: number;
  /** Optional: cache-write price (Anthropic prompt caching). */
  cache_write_usd_per_million?: number;
}

// ── Baked-in pricing table ───────────────────────────────────────────

/**
 * Pricing table keyed by canonical model id. Aliases (e.g. dated
 * variants of a model) resolve via `getModelPricing` which strips
 * known suffixes before the lookup. Keep keys lowercase.
 */
const BAKED_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic ────────────────────────────────────────────────────
  // Claude 3.5 Sonnet — legacy reference rate.
  'claude-3.5-sonnet': {
    input_usd_per_million: 3.00,
    output_usd_per_million: 15.00,
    cache_read_usd_per_million: 0.30,
    cache_write_usd_per_million: 3.75,
  },
  'claude-3.7-sonnet': {
    input_usd_per_million: 3.00,
    output_usd_per_million: 15.00,
    cache_read_usd_per_million: 0.30,
    cache_write_usd_per_million: 3.75,
  },
  // Claude Sonnet 4.x (4, 4.5, 4.6) share the same published rate.
  'claude-sonnet-4': {
    input_usd_per_million: 3.00,
    output_usd_per_million: 15.00,
    cache_read_usd_per_million: 0.30,
    cache_write_usd_per_million: 3.75,
  },
  'claude-sonnet-4-5': {
    input_usd_per_million: 3.00,
    output_usd_per_million: 15.00,
    cache_read_usd_per_million: 0.30,
    cache_write_usd_per_million: 3.75,
  },
  'claude-sonnet-4-6': {
    input_usd_per_million: 3.00,
    output_usd_per_million: 15.00,
    cache_read_usd_per_million: 0.30,
    cache_write_usd_per_million: 3.75,
  },
  // Claude Opus 4.x.
  'claude-opus-4': {
    input_usd_per_million: 15.00,
    output_usd_per_million: 75.00,
    cache_read_usd_per_million: 1.50,
    cache_write_usd_per_million: 18.75,
  },
  'claude-opus-4-5': {
    input_usd_per_million: 15.00,
    output_usd_per_million: 75.00,
    cache_read_usd_per_million: 1.50,
    cache_write_usd_per_million: 18.75,
  },
  'claude-opus-4-7': {
    input_usd_per_million: 15.00,
    output_usd_per_million: 75.00,
    cache_read_usd_per_million: 1.50,
    cache_write_usd_per_million: 18.75,
  },
  // Claude Haiku 4.5.
  'claude-haiku-4-5': {
    input_usd_per_million: 1.00,
    output_usd_per_million: 5.00,
    cache_read_usd_per_million: 0.10,
    cache_write_usd_per_million: 1.25,
  },
  'claude-3.5-haiku': {
    input_usd_per_million: 0.80,
    output_usd_per_million: 4.00,
    cache_read_usd_per_million: 0.08,
    cache_write_usd_per_million: 1.00,
  },

  // ── OpenAI ───────────────────────────────────────────────────────
  // GPT-5 family (representative; OpenAI splits tiers per family).
  'gpt-5': {
    input_usd_per_million: 5.00,
    output_usd_per_million: 15.00,
    cache_read_usd_per_million: 0.50,
  },
  'gpt-5.4': {
    input_usd_per_million: 5.00,
    output_usd_per_million: 15.00,
    cache_read_usd_per_million: 0.50,
  },
  'gpt-5-mini': {
    input_usd_per_million: 0.30,
    output_usd_per_million: 1.20,
    cache_read_usd_per_million: 0.03,
  },
  // GPT-4o family — still current at audit time.
  'gpt-4o': {
    input_usd_per_million: 2.50,
    output_usd_per_million: 10.00,
    cache_read_usd_per_million: 1.25,
  },
  'gpt-4o-mini': {
    input_usd_per_million: 0.15,
    output_usd_per_million: 0.60,
    cache_read_usd_per_million: 0.075,
  },

  // ── Moonshot Kimi ────────────────────────────────────────────────
  // Kimi K2 / K2.6 — public rate card.
  'kimi-k2': {
    input_usd_per_million: 0.60,
    output_usd_per_million: 2.50,
  },
  'kimi-k2.6': {
    input_usd_per_million: 0.60,
    output_usd_per_million: 2.50,
  },
  'kimi-k2.6-thinking': {
    input_usd_per_million: 1.00,
    output_usd_per_million: 3.50,
  },
  'kimi-k2-turbo-preview': {
    input_usd_per_million: 0.60,
    output_usd_per_million: 2.50,
  },
  'kimi-k2-thinking': {
    input_usd_per_million: 1.00,
    output_usd_per_million: 3.50,
  },

  // ── Alibaba Qwen ────────────────────────────────────────────────
  // Qwen coder family — DashScope international pricing.
  'qwen-coder-plus': {
    input_usd_per_million: 0.40,
    output_usd_per_million: 1.60,
  },
  'qwen3-coder-plus': {
    input_usd_per_million: 0.40,
    output_usd_per_million: 1.60,
  },
  'qwen3-coder-next': {
    input_usd_per_million: 0.30,
    output_usd_per_million: 1.20,
  },
  'qwen3-coder-flash': {
    input_usd_per_million: 0.14,
    output_usd_per_million: 0.56,
  },
  'qwen-plus': {
    input_usd_per_million: 0.40,
    output_usd_per_million: 1.20,
  },
  'qwen-flash': {
    input_usd_per_million: 0.14,
    output_usd_per_million: 0.56,
  },
  'qwen3-max-2026-01-23': {
    input_usd_per_million: 2.49,
    output_usd_per_million: 9.96,
  },

  // ── DeepSeek ────────────────────────────────────────────────────
  'deepseek-chat': {
    input_usd_per_million: 0.28,
    output_usd_per_million: 0.42,
    cache_read_usd_per_million: 0.028,
  },
  'deepseek-reasoner': {
    input_usd_per_million: 0.55,
    output_usd_per_million: 2.19,
    cache_read_usd_per_million: 0.055,
  },

  // ── Zhipu GLM ───────────────────────────────────────────────────
  'glm-4.6': {
    input_usd_per_million: 0.60,
    output_usd_per_million: 2.20,
  },
  'glm-5': {
    input_usd_per_million: 0.60,
    output_usd_per_million: 2.20,
  },
  'glm-5.1': {
    input_usd_per_million: 0.60,
    output_usd_per_million: 2.20,
  },
  'glm-5v-turbo': {
    input_usd_per_million: 0.60,
    output_usd_per_million: 2.20,
  },

  // ── MiniMax ─────────────────────────────────────────────────────
  'minimax-m2.7': {
    input_usd_per_million: 0.30,
    output_usd_per_million: 1.20,
  },
  'minimax-m2.5': {
    input_usd_per_million: 0.30,
    output_usd_per_million: 1.20,
  },
  'minimax-m2.1': {
    input_usd_per_million: 0.30,
    output_usd_per_million: 1.20,
  },

  // ── xAI Grok ────────────────────────────────────────────────────
  'grok-4.20-0309-reasoning': {
    input_usd_per_million: 3.00,
    output_usd_per_million: 15.00,
  },
  'grok-4.20-0309-non-reasoning': {
    input_usd_per_million: 3.00,
    output_usd_per_million: 15.00,
  },
  'grok-4-1-fast-reasoning': {
    input_usd_per_million: 0.20,
    output_usd_per_million: 0.50,
  },
  'grok-4-1-fast-non-reasoning': {
    input_usd_per_million: 0.20,
    output_usd_per_million: 0.50,
  },
  'grok-code-fast-1': {
    input_usd_per_million: 0.20,
    output_usd_per_million: 0.50,
  },
};

// ── Override file ────────────────────────────────────────────────────

const OVERRIDE_FILE = path.join(os.homedir(), '.sweech', 'pricing.json');

/**
 * Load and validate the user pricing override file. Returns an empty
 * object when the file is missing OR malformed — pricing data is not
 * credential material, so a bad override falls back silently to the
 * baked-in table after logging the failure to stderr.
 */
function loadOverride(filePath: string = OVERRIDE_FILE): Record<string, ModelPricing> {
  if (!fs.existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    process.stderr.write(`[sweech] pricing override unreadable: ${err instanceof Error ? err.message : String(err)}\n`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[sweech] pricing override malformed JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`[sweech] pricing override must be a JSON object\n`);
    return {};
  }
  const out: Record<string, ModelPricing> = {};
  for (const [modelId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const input = entry.input_usd_per_million;
    const output = entry.output_usd_per_million;
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) continue;
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) continue;
    const pricing: ModelPricing = {
      input_usd_per_million: input,
      output_usd_per_million: output,
    };
    if (typeof entry.cache_read_usd_per_million === 'number' && Number.isFinite(entry.cache_read_usd_per_million) && entry.cache_read_usd_per_million >= 0) {
      pricing.cache_read_usd_per_million = entry.cache_read_usd_per_million;
    }
    if (typeof entry.cache_write_usd_per_million === 'number' && Number.isFinite(entry.cache_write_usd_per_million) && entry.cache_write_usd_per_million >= 0) {
      pricing.cache_write_usd_per_million = entry.cache_write_usd_per_million;
    }
    out[modelId.toLowerCase()] = pricing;
  }
  return out;
}

/**
 * Effective pricing table = baked-in ∪ override (override wins).
 *
 * Recomputed on every call so a freshly-written override is visible
 * without a restart. The table is small (a few dozen entries) so the
 * cost of recomputing is negligible compared to disk IO from the
 * override read.
 */
export function getPricingTable(filePath: string = OVERRIDE_FILE): Record<string, ModelPricing> {
  const override = loadOverride(filePath);
  return { ...BAKED_PRICING, ...override };
}

/**
 * Exported reference to the baked-in table for tests and tooling.
 * Treat as read-only; mutating it has no effect on `getPricingTable`
 * results (the spread above copies entries).
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = BAKED_PRICING;

// ── Lookup helpers ───────────────────────────────────────────────────

/**
 * Normalise a model id for table lookup. Strips common suffixes
 * (date stamps, provider prefixes) so callers don't have to know the
 * canonical name. e.g.:
 *   "anthropic/claude-sonnet-4.5"  → "claude-sonnet-4-5"
 *   "Claude-3.5-Sonnet-20241022"   → "claude-3.5-sonnet"
 *   "openai/gpt-5.4"               → "gpt-5.4"
 *   "MiniMax-M2.7-highspeed"       → "minimax-m2.7"
 */
function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  // Strip provider prefix ("anthropic/", "openai/", "x-ai/", "google/", "moonshotai/")
  id = id.replace(/^[a-z0-9_-]+\//, '');
  // Strip trailing date stamp (8 digits, optionally with -)
  id = id.replace(/-?\d{8}$/, '');
  // Anthropic dotted variants — "claude-sonnet-4.5" → "claude-sonnet-4-5"
  id = id.replace(/^claude-([a-z]+)-(\d+)\.(\d+)$/, 'claude-$1-$2-$3');
  // Strip "-highspeed" / "-turbo" qualifiers that share base pricing
  id = id.replace(/-highspeed$/, '');
  return id;
}

/**
 * Resolve pricing for a model id, returning null when the model is
 * unknown to the table. Tries the normalised key first; on miss,
 * tries a few common variants to cover provider naming drift.
 */
export function getModelPricing(modelId: string, table: Record<string, ModelPricing> = getPricingTable()): ModelPricing | null {
  if (!modelId) return null;
  const normalized = normalizeModelId(modelId);
  if (table[normalized]) return table[normalized];

  // Provider rebrands — try mapping "claude-sonnet-4-5-20241022" →
  // "claude-sonnet-4-5" by stripping more aggressively.
  const stripped = normalized.replace(/-preview$/, '').replace(/-thinking$/, '').replace(/-turbo$/, '');
  if (table[stripped]) return table[stripped];

  // Last shot: look for any key the normalised id starts with.
  for (const key of Object.keys(table)) {
    if (normalized.startsWith(key) || key.startsWith(normalized)) {
      // Only accept a prefix match if it's reasonably specific — i.e.
      // the match length is at least 70% of the longer string. This
      // keeps "gpt-5" from accidentally matching "gpt-5.4-mini-foo".
      const ratio = Math.min(key.length, normalized.length) / Math.max(key.length, normalized.length);
      if (ratio >= 0.7) return table[key];
    }
  }
  return null;
}

/**
 * Cost estimate in USD for a single call.
 *
 * Returns 0 when the model is unknown (caller can detect "unknown
 * model" via `getModelPricing` first if they need to gate on it). The
 * 0-on-unknown contract means budget filters degrade safely — an
 * unpriced candidate is treated as "free" and surfaces in --budget
 * results, but the caller can pair this with `getModelPricing` to
 * filter unknowns explicitly when desired.
 *
 * `cachedInputTokens` lets callers attribute the cache-read tier when
 * prompt caching is in play; the value defaults to 0 (no caching).
 */
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  table: Record<string, ModelPricing> = getPricingTable(),
): number {
  const pricing = getModelPricing(modelId, table);
  if (!pricing) return 0;
  const safeIn = Math.max(0, Math.floor(inputTokens));
  const safeOut = Math.max(0, Math.floor(outputTokens));
  const safeCached = Math.max(0, Math.min(Math.floor(cachedInputTokens), safeIn));
  const freshIn = safeIn - safeCached;
  const inputCost = (freshIn / 1_000_000) * pricing.input_usd_per_million;
  const cachedCost = pricing.cache_read_usd_per_million !== undefined
    ? (safeCached / 1_000_000) * pricing.cache_read_usd_per_million
    : (safeCached / 1_000_000) * pricing.input_usd_per_million;
  const outputCost = (safeOut / 1_000_000) * pricing.output_usd_per_million;
  return inputCost + cachedCost + outputCost;
}

/**
 * Round a USD amount to 4 decimal places for display. Pure helper —
 * stays here next to the cost math so every surface that prints a
 * dollar amount produces identical wording.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return `$${amount.toFixed(4)}`;
}

/**
 * Same as `formatUsd` but elides trailing zeroes for very small
 * amounts where 4 decimals would be misleading. Used in tables.
 */
export function formatUsdCompact(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  if (amount === 0) return '$0.0000';
  if (Math.abs(amount) >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4)}`;
}
