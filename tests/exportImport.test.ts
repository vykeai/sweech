/**
 * Tests for export/import settings (T-033)
 */

import { ProfileConfig } from '../src/config';

describe('Export/Import Settings', () => {
  const SENSITIVE_FIELDS = ['apiKey', 'oauth', 'accessToken', 'refreshToken'];

  const makeProfile = (overrides: Partial<ProfileConfig> = {}): ProfileConfig => ({
    name: 'test-profile',
    commandName: 'test-profile',
    cliType: 'claude',
    provider: 'minimax',
    apiKey: 'sk-secret-api-key-123',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'abab5.5s-chat',
    smallFastModel: 'abab5.5t-chat',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  describe('Export — sensitive field stripping', () => {
    function exportProfile(profile: ProfileConfig): Record<string, unknown> {
      // Replicates the export logic from cli.ts
      const template: Record<string, unknown> = {
        commandName: profile.commandName,
        cliType: profile.cliType,
        provider: profile.provider,
      };
      if (profile.model) template.model = profile.model;
      if (profile.smallFastModel) template.smallFastModel = profile.smallFastModel;
      if (profile.baseUrl) template.baseUrl = profile.baseUrl;
      if (profile.sharedWith) template.sharedWith = profile.sharedWith;
      return template;
    }

    test('strips apiKey from exported template', () => {
      const profile = makeProfile({ apiKey: 'sk-super-secret' });
      const exported = exportProfile(profile);

      expect(exported).not.toHaveProperty('apiKey');
      expect(JSON.stringify(exported)).not.toContain('sk-super-secret');
    });

    test('strips oauth tokens from exported template', () => {
      const profile = makeProfile({
        oauth: {
          accessToken: 'access-token-123',
          refreshToken: 'refresh-token-456',
          expiresAt: Date.now() + 3600000,
          tokenType: 'bearer',
          provider: 'anthropic',
        },
      });
      const exported = exportProfile(profile);

      expect(exported).not.toHaveProperty('oauth');
      expect(exported).not.toHaveProperty('accessToken');
      expect(exported).not.toHaveProperty('refreshToken');
      const jsonStr = JSON.stringify(exported);
      expect(jsonStr).not.toContain('access-token-123');
      expect(jsonStr).not.toContain('refresh-token-456');
    });

    test('preserves non-sensitive fields', () => {
      const profile = makeProfile({
        model: 'custom-model',
        smallFastModel: 'fast-model',
        baseUrl: 'https://custom.endpoint',
        sharedWith: 'claude',
      });
      const exported = exportProfile(profile);

      expect(exported.commandName).toBe('test-profile');
      expect(exported.cliType).toBe('claude');
      expect(exported.provider).toBe('minimax');
      expect(exported.model).toBe('custom-model');
      expect(exported.smallFastModel).toBe('fast-model');
      expect(exported.baseUrl).toBe('https://custom.endpoint');
      expect(exported.sharedWith).toBe('claude');
    });

    test('omits undefined optional fields', () => {
      const profile = makeProfile({
        model: undefined,
        smallFastModel: undefined,
        baseUrl: undefined,
        sharedWith: undefined,
      });
      const exported = exportProfile(profile);

      expect(exported).not.toHaveProperty('model');
      expect(exported).not.toHaveProperty('smallFastModel');
      expect(exported).not.toHaveProperty('baseUrl');
      expect(exported).not.toHaveProperty('sharedWith');
    });

    test('does not include createdAt in export', () => {
      const profile = makeProfile();
      const exported = exportProfile(profile);

      expect(exported).not.toHaveProperty('createdAt');
    });

    test('exported template has no sensitive field keys at all', () => {
      const profile = makeProfile({
        apiKey: 'secret',
        oauth: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAt: Date.now(),
          provider: 'anthropic',
        },
      });
      const exported = exportProfile(profile);
      const keys = Object.keys(exported);

      for (const sensitive of SENSITIVE_FIELDS) {
        expect(keys).not.toContain(sensitive);
      }
    });
  });

  describe('Import — template validation', () => {
    function validateTemplate(template: Record<string, unknown>): string[] {
      // Replicates the import validation logic from cli.ts
      const required = ['commandName', 'cliType', 'provider'];
      return required.filter(f => !template[f]);
    }

    function validateCommandName(name: string): boolean {
      return /^[a-z0-9-]+$/.test(name);
    }

    test('accepts valid template with all required fields', () => {
      const template = {
        commandName: 'my-profile',
        cliType: 'claude',
        provider: 'minimax',
      };
      const missing = validateTemplate(template);
      expect(missing).toHaveLength(0);
    });

    test('rejects template missing commandName', () => {
      const template = {
        cliType: 'claude',
        provider: 'minimax',
      };
      const missing = validateTemplate(template);
      expect(missing).toContain('commandName');
    });

    test('rejects template missing cliType', () => {
      const template = {
        commandName: 'my-profile',
        provider: 'minimax',
      };
      const missing = validateTemplate(template);
      expect(missing).toContain('cliType');
    });

    test('rejects template missing provider', () => {
      const template = {
        commandName: 'my-profile',
        cliType: 'claude',
      };
      const missing = validateTemplate(template);
      expect(missing).toContain('provider');
    });

    test('rejects template missing all required fields', () => {
      const template = { model: 'something' };
      const missing = validateTemplate(template);
      expect(missing).toHaveLength(3);
      expect(missing).toContain('commandName');
      expect(missing).toContain('cliType');
      expect(missing).toContain('provider');
    });

    test('validates lowercase alphanumeric command names', () => {
      expect(validateCommandName('my-profile')).toBe(true);
      expect(validateCommandName('claude-mini')).toBe(true);
      expect(validateCommandName('test123')).toBe(true);
      expect(validateCommandName('a-b-c-1-2-3')).toBe(true);
    });

    test('rejects invalid command names', () => {
      expect(validateCommandName('My-Profile')).toBe(false); // uppercase
      expect(validateCommandName('my_profile')).toBe(false); // underscore
      expect(validateCommandName('my profile')).toBe(false); // space
      expect(validateCommandName('my.profile')).toBe(false); // dot
      expect(validateCommandName('my/profile')).toBe(false); // slash
      expect(validateCommandName('')).toBe(false); // empty
    });
  });

  describe('Round-trip export → import', () => {
    function exportProfile(profile: ProfileConfig): Record<string, unknown> {
      const template: Record<string, unknown> = {
        commandName: profile.commandName,
        cliType: profile.cliType,
        provider: profile.provider,
      };
      if (profile.model) template.model = profile.model;
      if (profile.smallFastModel) template.smallFastModel = profile.smallFastModel;
      if (profile.baseUrl) template.baseUrl = profile.baseUrl;
      if (profile.sharedWith) template.sharedWith = profile.sharedWith;
      return template;
    }

    test('exported template can be serialized and parsed back', () => {
      const profile = makeProfile();
      const exported = exportProfile(profile);
      const json = JSON.stringify(exported, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.commandName).toBe(profile.commandName);
      expect(parsed.cliType).toBe(profile.cliType);
      expect(parsed.provider).toBe(profile.provider);
    });

    test('re-imported template preserves all non-sensitive data', () => {
      const profile = makeProfile({
        model: 'custom-model',
        smallFastModel: 'fast-model',
        baseUrl: 'https://custom.endpoint',
        sharedWith: 'claude',
      });
      const exported = exportProfile(profile);
      const json = JSON.stringify(exported);
      const reimported = JSON.parse(json);

      expect(reimported.commandName).toBe(profile.commandName);
      expect(reimported.provider).toBe(profile.provider);
      expect(reimported.model).toBe(profile.model);
      expect(reimported.smallFastModel).toBe(profile.smallFastModel);
      expect(reimported.baseUrl).toBe(profile.baseUrl);
      expect(reimported.sharedWith).toBe(profile.sharedWith);
    });

    test('sensitive data is not recoverable from export', () => {
      const profile = makeProfile({
        apiKey: 'sk-secret-key-very-long-and-unique',
        oauth: {
          accessToken: 'bearer-access-token-unique',
          refreshToken: 'refresh-token-unique',
          expiresAt: Date.now(),
          provider: 'anthropic',
        },
      });
      const exported = exportProfile(profile);
      const json = JSON.stringify(exported);

      expect(json).not.toContain('sk-secret-key-very-long-and-unique');
      expect(json).not.toContain('bearer-access-token-unique');
      expect(json).not.toContain('refresh-token-unique');
    });
  });
});
