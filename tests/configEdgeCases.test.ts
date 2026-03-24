/**
 * Edge case tests for configuration management.
 */

import { ProfileConfig } from '../src/config';
import { getProvider, PROVIDERS } from '../src/providers';

describe('ProfileConfig edge cases', () => {
  describe('Empty and minimal profiles', () => {
    test('profile with only required fields', () => {
      const profile: ProfileConfig = {
        name: 'minimal',
        commandName: 'minimal',
        cliType: 'claude',
        provider: 'minimax',
        createdAt: new Date().toISOString(),
      };

      expect(profile.apiKey).toBeUndefined();
      expect(profile.baseUrl).toBeUndefined();
      expect(profile.model).toBeUndefined();
      expect(profile.smallFastModel).toBeUndefined();
      expect(profile.sharedWith).toBeUndefined();
      expect(profile.oauth).toBeUndefined();
    });

    test('profile with empty string values', () => {
      const profile: ProfileConfig = {
        name: '',
        commandName: '',
        cliType: '',
        provider: '',
        createdAt: '',
      };

      expect(profile.name).toBe('');
      expect(profile.commandName).toBe('');
    });
  });

  describe('Command name validation edge cases', () => {
    test('single character command names are valid', () => {
      expect(/^[a-z0-9-]+$/.test('a')).toBe(true);
      expect(/^[a-z0-9-]+$/.test('1')).toBe(true);
    });

    test('empty string is invalid', () => {
      expect(/^[a-z0-9-]+$/.test('')).toBe(false);
    });

    test('leading/trailing hyphens are valid per regex', () => {
      expect(/^[a-z0-9-]+$/.test('-abc')).toBe(true);
      expect(/^[a-z0-9-]+$/.test('abc-')).toBe(true);
      expect(/^[a-z0-9-]+$/.test('-')).toBe(true);
    });

    test('consecutive hyphens are valid per regex', () => {
      expect(/^[a-z0-9-]+$/.test('a--b')).toBe(true);
    });

    test('very long command name is valid per regex', () => {
      const longName = 'a'.repeat(200);
      expect(/^[a-z0-9-]+$/.test(longName)).toBe(true);
    });

    test('unicode characters are invalid', () => {
      expect(/^[a-z0-9-]+$/.test('clàude')).toBe(false);
      expect(/^[a-z0-9-]+$/.test('クロード')).toBe(false);
    });

    test('special characters are all invalid', () => {
      const specials = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '=', '+', '~', '`', '{', '}', '[', ']', '|', '\\', ':', ';', '"', "'", '<', '>', ',', '.', '?'];
      specials.forEach(ch => {
        expect(/^[a-z0-9-]+$/.test(`test${ch}name`)).toBe(false);
      });
    });
  });

  describe('Provider integration edge cases', () => {
    test('unknown provider returns undefined', () => {
      const provider = getProvider('nonexistent-provider-xyz');
      expect(provider).toBeUndefined();
    });

    test('provider list is not empty', () => {
      const providerNames = Object.keys(PROVIDERS);
      expect(providerNames.length).toBeGreaterThan(0);
    });

    test('all providers have required fields', () => {
      Object.values(PROVIDERS).forEach(p => {
        expect(p.name).toBeDefined();
        expect(typeof p.name).toBe('string');
        expect(p.name.length).toBeGreaterThan(0);
      });
    });
  });

  describe('cliType validation', () => {
    test('profile with claude cliType', () => {
      const profile: ProfileConfig = {
        name: 'test-claude',
        commandName: 'test-claude',
        cliType: 'claude',
        provider: 'minimax',
        createdAt: new Date().toISOString(),
      };
      expect(profile.cliType).toBe('claude');
    });

    test('profile with codex cliType', () => {
      const profile: ProfileConfig = {
        name: 'test-codex',
        commandName: 'test-codex',
        cliType: 'codex',
        provider: 'minimax',
        createdAt: new Date().toISOString(),
      };
      expect(profile.cliType).toBe('codex');
    });

    test('profile with arbitrary cliType string (no runtime validation)', () => {
      const profile: ProfileConfig = {
        name: 'test-other',
        commandName: 'test-other',
        cliType: 'unknown-cli',
        provider: 'minimax',
        createdAt: new Date().toISOString(),
      };
      expect(profile.cliType).toBe('unknown-cli');
    });
  });

  describe('createdAt format', () => {
    test('accepts ISO string', () => {
      const profile: ProfileConfig = {
        name: 'test',
        commandName: 'test',
        cliType: 'claude',
        provider: 'minimax',
        createdAt: '2025-01-15T10:30:00.000Z',
      };
      const date = new Date(profile.createdAt);
      expect(date.getTime()).not.toBeNaN();
    });

    test('can store non-ISO string (no runtime validation)', () => {
      const profile: ProfileConfig = {
        name: 'test',
        commandName: 'test',
        cliType: 'claude',
        provider: 'minimax',
        createdAt: 'not-a-date',
      };
      expect(profile.createdAt).toBe('not-a-date');
    });
  });

  describe('sharedWith field', () => {
    test('profile with sharedWith pointing to another command', () => {
      const profile: ProfileConfig = {
        name: 'shared-profile',
        commandName: 'claude-shared',
        cliType: 'claude',
        provider: 'minimax',
        createdAt: new Date().toISOString(),
        sharedWith: 'claude',
      };
      expect(profile.sharedWith).toBe('claude');
    });
  });
});
