import { describe, it, expect } from 'vitest';
import { parseAndValidateProviders, loadProviders, getEnabledAccounts, getAccountsForProvider, resolveApiKey } from '../providers.js';
import type { ProvidersConfig } from '../providers.js';

const VALID_YAML = `
version: 1
failoverOrder:
  - claude-sub
  - dashscope-api
  - zhipu-api
accounts:
  claude-sub:
    provider: claude
    type: subscription
    models:
      - claude-opus-4-6
      - claude-sonnet-4-6
    quota:
      period: daily
      softLimit: 200
  dashscope-api:
    provider: dashscope
    type: api-key
    apiKeyEnv: DASHSCOPE_API_KEY
    baseUrl: https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions
    models:
      - qwen3-coder-next
      - qwen3-coder-plus
    rateLimit:
      rpm: 2400
    quota:
      period: monthly
      limit: 50
  zhipu-api:
    provider: zhipu
    type: api-key
    apiKeyEnv: ZHIPU_API_KEY
    baseUrl: https://api.z.ai/api/paas/v4/chat/completions
    models:
      - glm-5
      - glm-4.7
    quota:
      period: monthly
      limit: 20
  disabled-acct:
    provider: kimi
    type: api-key
    apiKeyEnv: KIMI_API_KEY
    models:
      - kimi-for-coding
    enabled: false
`;

describe('parseAndValidateProviders', () => {
  it('parses valid providers.yaml', () => {
    const config = parseAndValidateProviders(VALID_YAML);

    expect(config.version).toBe(1);
    expect(config.failoverOrder).toEqual(['claude-sub', 'dashscope-api', 'zhipu-api']);
    expect(Object.keys(config.accounts)).toHaveLength(4);

    const claude = config.accounts['claude-sub'];
    expect(claude.provider).toBe('claude');
    expect(claude.type).toBe('subscription');
    expect(claude.models).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6']);
    expect(claude.quota).toEqual({ period: 'daily', softLimit: 200 });
    expect(claude.enabled).toBe(true);

    const ds = config.accounts['dashscope-api'];
    expect(ds.baseUrl).toBe('https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions');
    expect(ds.rateLimit).toEqual({ rpm: 2400 });
    expect(ds.quota).toEqual({ period: 'monthly', limit: 50 });

    const disabled = config.accounts['disabled-acct'];
    expect(disabled.enabled).toBe(false);
  });

  it('throws on missing version', () => {
    expect(() => parseAndValidateProviders(`
accounts: {}
failoverOrder: []
`)).toThrow('"version" must be a number');
  });

  it('throws on missing failoverOrder', () => {
    expect(() => parseAndValidateProviders(`
version: 1
accounts: {}
`)).toThrow('"failoverOrder" must be an array');
  });

  it('throws on missing accounts', () => {
    expect(() => parseAndValidateProviders(`
version: 1
failoverOrder: []
`)).toThrow('"accounts" must be an object');
  });

  it('throws on invalid account type', () => {
    expect(() => parseAndValidateProviders(`
version: 1
accounts:
  bad:
    provider: test
    type: invalid
    models: [test-model]
failoverOrder: []
`)).toThrow('invalid type "invalid"');
  });

  it('throws on missing provider', () => {
    expect(() => parseAndValidateProviders(`
version: 1
accounts:
  bad:
    type: api-key
    models: [test-model]
failoverOrder: []
`)).toThrow('missing "provider"');
  });

  it('throws on missing models', () => {
    expect(() => parseAndValidateProviders(`
version: 1
accounts:
  bad:
    provider: test
    type: api-key
failoverOrder: []
`)).toThrow('missing "models" array');
  });

  it('throws on failoverOrder referencing unknown account', () => {
    expect(() => parseAndValidateProviders(`
version: 1
accounts:
  real:
    provider: test
    type: api-key
    models: [test-model]
failoverOrder:
  - real
  - ghost
`)).toThrow('unknown account "ghost"');
  });

  it('throws on invalid quota period', () => {
    expect(() => parseAndValidateProviders(`
version: 1
accounts:
  bad:
    provider: test
    type: api-key
    models: [test-model]
    quota:
      period: yearly
failoverOrder: []
`)).toThrow('invalid period "yearly"');
  });

  it('throws on non-number rateLimit.rpm', () => {
    expect(() => parseAndValidateProviders(`
version: 1
accounts:
  bad:
    provider: test
    type: api-key
    models: [test-model]
    rateLimit:
      rpm: fast
failoverOrder: []
`)).toThrow('rateLimit.rpm must be a number');
  });
});

describe('getEnabledAccounts', () => {
  it('filters out disabled accounts', () => {
    const config = parseAndValidateProviders(VALID_YAML);
    const enabled = getEnabledAccounts(config);
    expect(enabled).toHaveLength(3);
    expect(enabled.map(([id]) => id)).not.toContain('disabled-acct');
  });
});

describe('getAccountsForProvider', () => {
  it('returns accounts matching provider', () => {
    const config = parseAndValidateProviders(VALID_YAML);
    const zhipuAccounts = getAccountsForProvider(config, 'zhipu');
    expect(zhipuAccounts).toHaveLength(1);
    expect(zhipuAccounts[0][0]).toBe('zhipu-api');
  });

  it('excludes disabled accounts', () => {
    const config = parseAndValidateProviders(VALID_YAML);
    const kimiAccounts = getAccountsForProvider(config, 'kimi');
    expect(kimiAccounts).toHaveLength(0);
  });
});

describe('resolveApiKey', () => {
  it('resolves env var with $ prefix', () => {
    process.env['TEST_KEY_123'] = 'secret';
    const account = parseAndValidateProviders(VALID_YAML).accounts['dashscope-api'];
    const original = account.apiKeyEnv;
    account.apiKeyEnv = '$TEST_KEY_123';
    expect(resolveApiKey(account)).toBe('secret');
    account.apiKeyEnv = original;
    delete process.env['TEST_KEY_123'];
  });

  it('resolves env var without $ prefix', () => {
    process.env['TEST_KEY_456'] = 'secret2';
    const account = parseAndValidateProviders(VALID_YAML).accounts['dashscope-api'];
    const original = account.apiKeyEnv;
    account.apiKeyEnv = 'TEST_KEY_456';
    expect(resolveApiKey(account)).toBe('secret2');
    account.apiKeyEnv = original;
    delete process.env['TEST_KEY_456'];
  });

  it('returns undefined when no apiKeyEnv', () => {
    const account = parseAndValidateProviders(VALID_YAML).accounts['claude-sub'];
    expect(resolveApiKey(account)).toBeUndefined();
  });
});

describe('loadProviders', () => {
  it('throws on missing file', async () => {
    await expect(loadProviders('/nonexistent/providers.yaml')).rejects.toThrow();
  });
});
