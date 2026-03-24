/**
 * Tests for shell completion script generation and dynamic completion
 */

import * as fs from 'fs';
import { generateBashCompletion, generateZshCompletion, handleComplete } from '../src/completion';
import { ConfigManager } from '../src/config';
import { AliasManager } from '../src/aliases';

jest.mock('fs');
jest.mock('../src/config');
jest.mock('../src/aliases');

const mockFs = fs as jest.Mocked<typeof fs>;
const MockConfigManager = ConfigManager as jest.MockedClass<typeof ConfigManager>;
const MockAliasManager = AliasManager as jest.MockedClass<typeof AliasManager>;

describe('Completion Scripts', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock ConfigManager
    MockConfigManager.prototype.getProfiles = jest.fn().mockReturnValue([
      {
        name: 'test',
        commandName: 'claude-mini',
        cliType: 'claude',
        provider: 'minimax',
        apiKey: 'sk-test',
        createdAt: '2025-02-03T00:00:00.000Z'
      },
      {
        name: 'test2',
        commandName: 'claude-qwen',
        cliType: 'claude',
        provider: 'qwen',
        apiKey: 'sk-test2',
        createdAt: '2025-02-03T00:00:00.000Z'
      }
    ]);

    // Mock AliasManager
    MockAliasManager.prototype.getAliases = jest.fn().mockReturnValue({
      work: 'claude-mini',
      personal: 'claude-qwen'
    });
  });

  describe('generateBashCompletion', () => {
    test('generates valid bash completion script', () => {
      const script = generateBashCompletion();

      expect(script).toContain('_sweech_completion()');
      expect(script).toContain('complete -F _sweech_completion sweech');
    });

    test('includes all command names in completion', () => {
      const script = generateBashCompletion();

      expect(script).toContain('add');
      expect(script).toContain('list');
      expect(script).toContain('remove');
      expect(script).toContain('stats');
      expect(script).toContain('show');
      expect(script).toContain('alias');
      expect(script).toContain('discover');
      expect(script).toContain('completion');
      expect(script).toContain('edit');
      expect(script).toContain('usage');
      expect(script).toContain('doctor');
    });

    test('includes profile names for relevant commands', () => {
      const script = generateBashCompletion();

      expect(script).toContain('claude-mini');
      expect(script).toContain('claude-qwen');
    });

    test('includes alias names in completion', () => {
      const script = generateBashCompletion();

      expect(script).toContain('work');
      expect(script).toContain('personal');
    });

    test('handles profile-accepting commands including edit', () => {
      const script = generateBashCompletion();

      expect(script).toContain('remove|rm|show|stats|edit|test|clone|rename|backup-chats');
      expect(script).toMatch(/profiles="claude-mini claude-qwen"/);
    });

    test('handles alias subcommands', () => {
      const script = generateBashCompletion();

      expect(script).toContain('alias)');
      expect(script).toContain('list remove');
    });

    test('handles completion shell options', () => {
      const script = generateBashCompletion();

      expect(script).toContain('completion)');
      expect(script).toContain('bash zsh');
    });

    test('handles --sort for usage and stats', () => {
      const script = generateBashCompletion();

      expect(script).toContain('--sort)');
      expect(script).toContain('smart status manual');
      expect(script).toContain('uses recent name');
    });

    test('uses bash variable syntax', () => {
      const script = generateBashCompletion();

      expect(script).toContain('${COMP_WORDS[COMP_CWORD]}');
      expect(script).toContain('COMPREPLY');
      expect(script).toContain('compgen');
    });

    test('includes dynamic completion via --complete', () => {
      const script = generateBashCompletion();

      expect(script).toContain('sweech --complete');
    });

    test('handles empty profiles list', () => {
      MockConfigManager.prototype.getProfiles = jest.fn().mockReturnValue([]);

      const script = generateBashCompletion();

      expect(script).toContain('profiles=""');
    });

    test('handles empty aliases list', () => {
      MockAliasManager.prototype.getAliases = jest.fn().mockReturnValue({});

      const script = generateBashCompletion();

      expect(script).toContain('aliases=""');
    });
  });

  describe('generateZshCompletion', () => {
    test('generates valid zsh completion script', () => {
      const script = generateZshCompletion();

      expect(script).toContain('#compdef sweech');
      expect(script).toContain('_sweech()');
      expect(script).toContain('_sweech "$@"');
    });

    test('includes command descriptions', () => {
      const script = generateZshCompletion();

      expect(script).toContain('add:Add a new provider');
      expect(script).toContain('list:List all configured providers');
      expect(script).toContain('remove:Remove a configured provider');
      expect(script).toContain('stats:Show usage statistics');
      expect(script).toContain('show:Show provider details');
      expect(script).toContain('alias:Manage command aliases');
      expect(script).toContain('edit:Edit a provider config');
      expect(script).toContain('usage:Show account usage windows');
      expect(script).toContain('doctor:Check installation health');
    });

    test('includes profile names', () => {
      const script = generateZshCompletion();

      expect(script).toContain('claude-mini');
      expect(script).toContain('claude-qwen');
    });

    test('includes alias names', () => {
      const script = generateZshCompletion();

      expect(script).toContain('work');
      expect(script).toContain('personal');
    });

    test('handles command-specific completion including edit', () => {
      const script = generateZshCompletion();

      expect(script).toContain('remove|rm|show|stats|edit|test|clone|rename|backup-chats)');
      expect(script).toContain('_arguments "*:profile:($profiles)"');
    });

    test('handles usage sort mode completion', () => {
      const script = generateZshCompletion();

      expect(script).toContain("'--sort[Sort order]:sort mode:(smart status manual)'");
    });

    test('handles stats sort field completion', () => {
      const script = generateZshCompletion();

      expect(script).toContain("'--sort[Sort by]:sort field:(uses recent name)'");
    });

    test('handles alias subcommands', () => {
      const script = generateZshCompletion();

      expect(script).toContain('alias)');
      expect(script).toContain('if [[ $words[3] == "remove" ]]');
      expect(script).toContain('_arguments "*:alias:($aliases_list)"');
    });

    test('includes dynamic completion via --complete', () => {
      const script = generateZshCompletion();

      expect(script).toContain('sweech --complete');
    });

    test('uses zsh variable syntax', () => {
      const script = generateZshCompletion();

      expect(script).toContain('$words[2]');
      expect(script).toContain('$words[3]');
      expect(script).toContain('_describe');
      expect(script).toContain('_arguments');
    });

    test('handles empty profiles list', () => {
      MockConfigManager.prototype.getProfiles = jest.fn().mockReturnValue([]);

      const script = generateZshCompletion();

      expect(script).toContain('profiles=()');
    });

    test('handles empty aliases list', () => {
      MockAliasManager.prototype.getAliases = jest.fn().mockReturnValue({});

      const script = generateZshCompletion();

      expect(script).toContain('aliases_list=()');
    });
  });

  describe('Script format', () => {
    test('bash script is executable format', () => {
      const script = generateBashCompletion();

      expect(script).toMatch(/^# Bash completion/);
      expect(script.trim().endsWith('sweech')).toBe(true);
    });

    test('zsh script is executable format', () => {
      const script = generateZshCompletion();

      expect(script).toMatch(/^#compdef sweech/);
      expect(script.trim().endsWith('"$@"')).toBe(true);
    });

    test('bash script has proper line endings', () => {
      const script = generateBashCompletion();

      expect(script).not.toContain('\r\n'); // No Windows line endings
      expect(script.split('\n').length).toBeGreaterThan(10); // Multi-line
    });

    test('zsh script has proper line endings', () => {
      const script = generateZshCompletion();

      expect(script).not.toContain('\r\n'); // No Windows line endings
      expect(script.split('\n').length).toBeGreaterThan(10); // Multi-line
    });
  });

  describe('Dynamic content', () => {
    test('bash script updates with different profiles', () => {
      MockConfigManager.prototype.getProfiles = jest.fn().mockReturnValue([
        {
          name: 'test',
          commandName: 'test-command',
          cliType: 'claude',
          provider: 'minimax',
          apiKey: 'sk-test',
          createdAt: '2025-02-03T00:00:00.000Z'
        }
      ]);

      const script = generateBashCompletion();

      expect(script).toContain('test-command');
      expect(script).not.toContain('claude-mini');
    });

    test('zsh script updates with different profiles', () => {
      MockConfigManager.prototype.getProfiles = jest.fn().mockReturnValue([
        {
          name: 'test',
          commandName: 'test-command',
          cliType: 'claude',
          provider: 'minimax',
          apiKey: 'sk-test',
          createdAt: '2025-02-03T00:00:00.000Z'
        }
      ]);

      const script = generateZshCompletion();

      expect(script).toContain('test-command');
      expect(script).not.toContain('claude-mini');
    });

    test('bash script updates with different aliases', () => {
      MockAliasManager.prototype.getAliases = jest.fn().mockReturnValue({
        test: 'test-command'
      });

      const script = generateBashCompletion();

      expect(script).toContain('test');
      expect(script).not.toContain('work');
    });

    test('zsh script updates with different aliases', () => {
      MockAliasManager.prototype.getAliases = jest.fn().mockReturnValue({
        test: 'test-command'
      });

      const script = generateZshCompletion();

      expect(script).toContain('test');
      expect(script).not.toContain('work');
    });
  });

  describe('handleComplete (dynamic completion)', () => {
    test('returns all subcommands for empty line', () => {
      const result = handleComplete('sweech ');
      expect(result).toContain('show');
      expect(result).toContain('edit');
      expect(result).toContain('remove');
      expect(result).toContain('usage');
      expect(result).toContain('alias');
      expect(result).toContain('completion');
      expect(result.length).toBeGreaterThan(15);
    });

    test('returns all subcommands for just "sweech"', () => {
      const result = handleComplete('sweech');
      expect(result).toContain('show');
      expect(result).toContain('edit');
      expect(result.length).toBeGreaterThan(15);
    });

    test('filters subcommands by partial input', () => {
      const result = handleComplete('sweech sh');
      expect(result).toContain('show');
      expect(result).not.toContain('edit');
      expect(result).not.toContain('remove');
    });

    test('completes profile names for show command', () => {
      const result = handleComplete('sweech show ');
      expect(result).toEqual(['claude-mini', 'claude-qwen']);
    });

    test('completes profile names for edit command', () => {
      const result = handleComplete('sweech edit ');
      expect(result).toEqual(['claude-mini', 'claude-qwen']);
    });

    test('completes profile names for remove command', () => {
      const result = handleComplete('sweech remove ');
      expect(result).toEqual(['claude-mini', 'claude-qwen']);
    });

    test('completes profile names for stats command', () => {
      const result = handleComplete('sweech stats ');
      expect(result).toEqual(['claude-mini', 'claude-qwen']);
    });

    test('completes profile names for test command', () => {
      const result = handleComplete('sweech test ');
      expect(result).toEqual(['claude-mini', 'claude-qwen']);
    });

    test('filters profile names by partial input', () => {
      const result = handleComplete('sweech show claude-m');
      expect(result).toEqual(['claude-mini']);
    });

    test('returns empty for unknown profile prefix', () => {
      const result = handleComplete('sweech show zzz');
      expect(result).toEqual([]);
    });

    test('completes usage --sort with sort modes', () => {
      const result = handleComplete('sweech usage --sort ');
      expect(result).toEqual(['smart', 'status', 'manual']);
    });

    test('filters usage sort modes by partial', () => {
      const result = handleComplete('sweech usage --sort s');
      expect(result).toEqual(['smart', 'status']);
    });

    test('completes stats --sort with sort fields', () => {
      const result = handleComplete('sweech stats --sort ');
      expect(result).toEqual(['uses', 'recent', 'name']);
    });

    test('filters stats sort fields by partial', () => {
      const result = handleComplete('sweech stats --sort r');
      expect(result).toEqual(['recent']);
    });

    test('completes alias subcommands', () => {
      const result = handleComplete('sweech alias ');
      expect(result).toEqual(['list', 'remove']);
    });

    test('completes alias remove with alias names', () => {
      const result = handleComplete('sweech alias remove ');
      expect(result).toEqual(['work', 'personal']);
    });

    test('filters alias names by partial', () => {
      const result = handleComplete('sweech alias remove w');
      expect(result).toEqual(['work']);
    });

    test('completes completion shell argument', () => {
      const result = handleComplete('sweech completion ');
      expect(result).toEqual(['bash', 'zsh']);
    });

    test('filters completion shells by partial', () => {
      const result = handleComplete('sweech completion b');
      expect(result).toEqual(['bash']);
    });

    test('returns empty for completed commands with no more args', () => {
      const result = handleComplete('sweech list ');
      expect(result).toEqual([]);
    });

    test('handles empty profiles gracefully', () => {
      MockConfigManager.prototype.getProfiles = jest.fn().mockReturnValue([]);

      const result = handleComplete('sweech show ');
      expect(result).toEqual([]);
    });

    test('handles empty aliases gracefully', () => {
      MockAliasManager.prototype.getAliases = jest.fn().mockReturnValue({});

      const result = handleComplete('sweech alias remove ');
      expect(result).toEqual([]);
    });

    test('handles line without sweech prefix', () => {
      const result = handleComplete('show ');
      expect(result).toEqual(['claude-mini', 'claude-qwen']);
    });

    test('returns all subcommands for empty string', () => {
      const result = handleComplete('');
      expect(result).toContain('show');
      expect(result).toContain('edit');
      expect(result.length).toBeGreaterThan(15);
    });
  });
});
