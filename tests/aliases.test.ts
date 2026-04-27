/**
 * Tests for alias management functionality
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AliasManager, AliasMap } from '../src/aliases';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('AliasManager', () => {
  let manager: AliasManager;
  const mockAliasFile = path.join(os.homedir(), '.sweech', 'aliases.json');

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new AliasManager();
  });

  describe('getAliases', () => {
    test('returns empty object when no alias file exists', () => {
      mockFs.existsSync.mockReturnValue(false);

      const aliases = manager.getAliases();

      expect(aliases).toEqual({});
    });

    test('returns aliases from file', () => {
      const mockAliases: AliasMap = {
        work: 'claude-mini',
        personal: 'claude-qwen'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockAliases));

      const aliases = manager.getAliases();

      expect(aliases).toEqual(mockAliases);
    });

    test('handles corrupted alias file', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const aliases = manager.getAliases();

      expect(aliases).toEqual({});
    });

    test('handles file read errors', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const aliases = manager.getAliases();

      expect(aliases).toEqual({});
    });
  });

  describe('addAlias', () => {
    test('adds alias to empty file', () => {
      mockFs.existsSync.mockReturnValue(false);

      manager.addAlias('work', 'claude-mini');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toEqual({ work: 'claude-mini' });
    });

    test('adds alias to existing aliases', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      manager.addAlias('personal', 'claude-qwen');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toEqual({
        work: 'claude-mini',
        personal: 'claude-qwen'
      });
    });

    test('throws error when alias already exists', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      expect(() => manager.addAlias('work', 'claude-qwen')).toThrow(
        "Alias 'work' already exists (points to 'claude-mini')"
      );
    });

    test('writes formatted JSON', () => {
      mockFs.existsSync.mockReturnValue(false);

      manager.addAlias('work', 'claude-mini');

      // atomicWriteFileSync writes to a temp file first, then renames
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        expect.stringContaining('\n'), // Pretty-printed JSON
        'utf-8'
      );
    });
  });

  describe('removeAlias', () => {
    test('removes existing alias', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini',
        personal: 'claude-qwen'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      manager.removeAlias('work');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toEqual({ personal: 'claude-qwen' });
    });

    test('throws error when alias does not exist', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      expect(() => manager.removeAlias('nonexistent')).toThrow(
        "Alias 'nonexistent' does not exist"
      );
    });

    test('handles empty alias file', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => manager.removeAlias('work')).toThrow(
        "Alias 'work' does not exist"
      );
    });
  });

  describe('resolveAlias', () => {
    test('resolves existing alias to command', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini',
        personal: 'claude-qwen'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      const resolved = manager.resolveAlias('work');

      expect(resolved).toBe('claude-mini');
    });

    test('returns input when not an alias', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      const resolved = manager.resolveAlias('claude-qwen');

      expect(resolved).toBe('claude-qwen');
    });

    test('handles empty alias file', () => {
      mockFs.existsSync.mockReturnValue(false);

      const resolved = manager.resolveAlias('work');

      expect(resolved).toBe('work');
    });
  });

  describe('isAlias', () => {
    test('returns true for existing alias', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      expect(manager.isAlias('work')).toBe(true);
    });

    test('returns false for non-alias', () => {
      const existingAliases: AliasMap = {
        work: 'claude-mini'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingAliases));

      expect(manager.isAlias('claude-qwen')).toBe(false);
    });

    test('returns false when no alias file exists', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(manager.isAlias('work')).toBe(false);
    });
  });

  describe('Multiple operations', () => {
    test('can add, resolve, and remove aliases', () => {
      mockFs.existsSync.mockReturnValue(false);

      // Add first alias
      manager.addAlias('work', 'claude-mini');

      // Simulate file now exists with first alias
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ work: 'claude-mini' })
      );

      // Add second alias
      manager.addAlias('personal', 'claude-qwen');

      // Simulate file now has both aliases
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          work: 'claude-mini',
          personal: 'claude-qwen'
        })
      );

      // Resolve aliases
      expect(manager.resolveAlias('work')).toBe('claude-mini');
      expect(manager.resolveAlias('personal')).toBe('claude-qwen');

      // Remove one alias
      manager.removeAlias('work');

      const lastWriteCall = mockFs.writeFileSync.mock.calls[
        mockFs.writeFileSync.mock.calls.length - 1
      ];
      const finalData = JSON.parse(lastWriteCall[1] as string);

      expect(finalData).toEqual({ personal: 'claude-qwen' });
    });

    test('supports multiple aliases pointing to same command', () => {
      mockFs.existsSync.mockReturnValue(false);

      manager.addAlias('w', 'claude-mini');

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ w: 'claude-mini' })
      );

      manager.addAlias('work', 'claude-mini');

      const writeCall = mockFs.writeFileSync.mock.calls[1];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toEqual({
        w: 'claude-mini',
        work: 'claude-mini'
      });
    });
  });
});
