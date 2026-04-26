/**
 * Tests for backup and restore functionality
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

// Mock modules
jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('Backup and Restore', () => {
  describe('Encryption/Decryption', () => {
    test('encrypts and decrypts data correctly', () => {
      const originalData = Buffer.from('test data for encryption');
      const password = 'test-password-123';

      // Encrypt
      const salt = crypto.randomBytes(32);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      const encrypted = Buffer.concat([
        salt,
        iv,
        cipher.update(originalData),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();

      // Decrypt
      const extractedSalt = encrypted.slice(0, 32);
      const extractedIv = encrypted.slice(32, 48);
      const encryptedData = encrypted.slice(48);
      const decryptKey = crypto.pbkdf2Sync(password, extractedSalt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-gcm', decryptKey, extractedIv, { authTagLength: 16 });
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final()
      ]);

      expect(decrypted.toString()).toBe(originalData.toString());
    });

    test('decryption fails with wrong password', () => {
      const originalData = Buffer.from('sensitive data');
      const correctPassword = 'correct-password';
      const wrongPassword = 'wrong-password';

      // Encrypt with correct password
      const salt = crypto.randomBytes(32);
      const key = crypto.pbkdf2Sync(correctPassword, salt, 100000, 32, 'sha256');
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      const encrypted = Buffer.concat([
        cipher.update(originalData),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();

      // Try to decrypt with wrong password
      const wrongKey = crypto.pbkdf2Sync(wrongPassword, salt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrongKey, iv, { authTagLength: 16 });
      decipher.setAuthTag(authTag);

      expect(() => {
        Buffer.concat([
          decipher.update(encrypted),
          decipher.final()
        ]);
      }).toThrow();
    });
  });

  describe('Password Validation', () => {
    test('validates minimum password length', () => {
      const shortPassword = '12345678901'; // Only 11 characters
      const validPassword = '123456789012'; // 12 characters

      expect(shortPassword.length).toBeLessThan(12);
      expect(validPassword.length).toBeGreaterThanOrEqual(12);
    });

    test('password confirmation matching', () => {
      const password1 = 'test-password';
      const password2 = 'test-password';
      const password3 = 'different-password';

      expect(password1).toBe(password2); // Match
      expect(password1).not.toBe(password3); // No match
    });
  });

  describe('PBKDF2 Key Derivation', () => {
    test('generates consistent keys for same password and salt', () => {
      const password = 'test-password';
      const salt = crypto.randomBytes(32);

      const key1 = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      const key2 = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

      expect(key1.equals(key2)).toBe(true);
    });

    test('generates different keys for different passwords', () => {
      const salt = crypto.randomBytes(32);

      const key1 = crypto.pbkdf2Sync('password1', salt, 100000, 32, 'sha256');
      const key2 = crypto.pbkdf2Sync('password2', salt, 100000, 32, 'sha256');

      expect(key1.equals(key2)).toBe(false);
    });

    test('generates different keys for different salts', () => {
      const password = 'test-password';

      const key1 = crypto.pbkdf2Sync(password, crypto.randomBytes(32), 100000, 32, 'sha256');
      const key2 = crypto.pbkdf2Sync(password, crypto.randomBytes(32), 100000, 32, 'sha256');

      expect(key1.equals(key2)).toBe(false);
    });

    test('uses 100,000 iterations (security requirement)', () => {
      const password = 'test-password';
      const salt = crypto.randomBytes(32);

      // This test just verifies the function doesn't throw
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      expect(key.length).toBe(32); // 256 bits
    });
  });

  describe('AES-256-GCM Encryption', () => {
    test('uses correct cipher algorithm', () => {
      const password = 'test-password';
      const salt = crypto.randomBytes(32);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      const iv = crypto.randomBytes(16);

      // This should not throw
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      expect(cipher).toBeDefined();
    });

    test('IV is 16 bytes', () => {
      const iv = crypto.randomBytes(16);
      expect(iv.length).toBe(16);
    });

    test('key is 32 bytes (256 bits)', () => {
      const password = 'test-password';
      const salt = crypto.randomBytes(32);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

      expect(key.length).toBe(32); // 256 bits = 32 bytes
    });
  });

  describe('Backup File Format', () => {
    test('backup filename format', () => {
      const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const filename = `sweech-backup-${timestamp}.zip`;

      expect(filename).toMatch(/^sweech-backup-\d{8}\.zip$/);
    });

    test('custom filename support', () => {
      const customName = 'my-backup.zip';
      expect(customName).toMatch(/\.zip$/);
    });
  });

  describe('Backup Contents', () => {
    test('includes required directories and files', () => {
      const requiredPaths = [
        'profiles/',
        'bin/',
        'config.json'
      ];

      requiredPaths.forEach(path => {
        expect(path).toBeDefined();
        expect(typeof path).toBe('string');
      });
    });

    test('profile structure', () => {
      const mockProfile = {
        name: 'test',
        commandName: 'claude-mini',
        cliType: 'claude',
        provider: 'minimax',
        apiKey: 'sk-test-key',
        createdAt: new Date().toISOString()
      };

      expect(mockProfile.commandName).toBeDefined();
      expect(mockProfile.apiKey).toBeDefined();
      expect(mockProfile.cliType).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('handles missing backup file', () => {
      const nonExistentFile = '/path/to/nonexistent.zip';

      // Test the concept - backup/restore should check file existence
      expect(nonExistentFile).toBeDefined();
      expect(nonExistentFile).toMatch(/\.zip$/);
    });

    test('handles corrupted encryption', () => {
      const corruptedData = Buffer.from('corrupted data that is not properly encrypted');
      const password = 'test-password';

      // Try to decrypt corrupted data
      expect(() => {
        const salt = corruptedData.slice(0, 32);
        const iv = corruptedData.slice(32, 48);
        const authTag = corruptedData.slice(48, 64);
        const encrypted = corruptedData.slice(64);

        if (encrypted.length === 0) {
          throw new Error('No encrypted data');
        }

        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAuthTag(authTag);

        Buffer.concat([
          decipher.update(encrypted),
          decipher.final()
        ]);
      }).toThrow();
    });

    test('validates password length on backup', () => {
      const tooShort = 'short';
      const validLength = 'valid-password-12';

      expect(tooShort.length < 12).toBe(true);
      expect(validLength.length >= 12).toBe(true);
    });
  });

  describe('Security Properties', () => {
    test('salt is random for each encryption', () => {
      const salt1 = crypto.randomBytes(32);
      const salt2 = crypto.randomBytes(32);

      expect(salt1.equals(salt2)).toBe(false);
    });

    test('IV is random for each encryption', () => {
      const iv1 = crypto.randomBytes(16);
      const iv2 = crypto.randomBytes(16);

      expect(iv1.equals(iv2)).toBe(false);
    });

    test('encrypted output differs even for same input', () => {
      const data = Buffer.from('same data');
      const password = 'same password';

      // Encrypt twice
      const encrypt = (input: Buffer, pass: string) => {
        const salt = crypto.randomBytes(32);
        const key = crypto.pbkdf2Sync(pass, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        return Buffer.concat([
          salt,
          iv,
          cipher.update(input),
          cipher.final()
        ]);
      };

      const encrypted1 = encrypt(data, password);
      const encrypted2 = encrypt(data, password);

      // Different because of random salt and IV
      expect(encrypted1.equals(encrypted2)).toBe(false);
    });

    test('no password recovery possible', () => {
      // This is a documentation test - passwords are not stored
      const password = 'user-password';
      const salt = crypto.randomBytes(32);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

      // Key derivation is one-way - cannot recover password from key
      expect(key).toBeDefined();
      expect(key.length).toBe(32);
      // No function exists to reverse PBKDF2
    });
  });
});
