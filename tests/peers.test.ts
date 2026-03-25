/**
 * Tests for federation peer discovery and sync (T-016)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the fedClient functions directly since they are the core logic
// The CLI commands are thin wrappers that call these functions.

// Use a temp dir for tests
let tmpDir: string;
let peersFile: string;

// Override the peers file path for tests
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
  hostname: () => 'test-machine.local',
}));

// We need to import after mocking
let fedClient: typeof import('../src/fedClient');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-peers-test-'));
  peersFile = path.join(tmpDir, '.sweech', 'peers.json');
  // Ensure the dir exists
  fs.mkdirSync(path.join(tmpDir, '.sweech'), { recursive: true });
  // Clear module cache to pick up new tmpDir
  jest.resetModules();
  // Re-require after reset
  fedClient = require('../src/fedClient');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe('Federation Peer Discovery', () => {
  describe('loadFedPeers', () => {
    test('returns empty array when no peers file exists', () => {
      // Remove the file if it was created
      try { fs.unlinkSync(peersFile); } catch {}
      const peers = fedClient.loadFedPeers();
      expect(peers).toEqual([]);
    });

    test('loads peers from peers.json', () => {
      const data = [
        { name: 'laptop', host: '192.168.1.10', port: 7854, addedAt: '2025-01-01T00:00:00Z' },
        { name: 'server', host: '10.0.0.5', port: 7854, addedAt: '2025-01-02T00:00:00Z' },
      ];
      fs.writeFileSync(peersFile, JSON.stringify(data));
      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(2);
      expect(peers[0].name).toBe('laptop');
      expect(peers[1].name).toBe('server');
    });

    test('backfills addedAt for legacy entries without it', () => {
      const data = [
        { name: 'legacy-peer', host: '10.0.0.1', port: 7854 },
      ];
      fs.writeFileSync(peersFile, JSON.stringify(data));
      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].addedAt).toBeDefined();
      expect(new Date(peers[0].addedAt!).getTime()).toBeGreaterThan(0);
    });

    test('migrates from legacy fed-peers.json', () => {
      // Write to legacy location, not the new one
      const legacyFile = path.join(tmpDir, '.sweech', 'fed-peers.json');
      const data = [
        { name: 'old-peer', host: '192.168.1.1', port: 7854 },
      ];
      fs.writeFileSync(legacyFile, JSON.stringify(data));

      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].name).toBe('old-peer');
      expect(peers[0].addedAt).toBeDefined();

      // Should have saved to new location
      expect(fs.existsSync(peersFile)).toBe(true);
    });

    test('handles corrupt JSON gracefully', () => {
      fs.writeFileSync(peersFile, 'not valid json{{{');
      const peers = fedClient.loadFedPeers();
      expect(peers).toEqual([]);
    });
  });

  describe('saveFedPeers', () => {
    test('saves peers to peers.json', () => {
      const peers = [
        { name: 'test', host: 'localhost', port: 7854, addedAt: '2025-01-01T00:00:00Z' },
      ];
      fedClient.saveFedPeers(peers);
      const raw = fs.readFileSync(peersFile, 'utf-8');
      const saved = JSON.parse(raw);
      expect(saved).toHaveLength(1);
      expect(saved[0].name).toBe('test');
    });

    test('creates directory if not exists', () => {
      // Remove the directory
      fs.rmSync(path.join(tmpDir, '.sweech'), { recursive: true, force: true });
      const peers = [{ name: 'new', host: 'example.com', port: 8080, addedAt: '2025-01-01T00:00:00Z' }];
      fedClient.saveFedPeers(peers);
      expect(fs.existsSync(peersFile)).toBe(true);
    });

    test('overwrites existing file', () => {
      fedClient.saveFedPeers([{ name: 'first', host: 'a.com', port: 1, addedAt: '2025-01-01T00:00:00Z' }]);
      fedClient.saveFedPeers([{ name: 'second', host: 'b.com', port: 2, addedAt: '2025-01-02T00:00:00Z' }]);
      const peers = JSON.parse(fs.readFileSync(peersFile, 'utf-8'));
      expect(peers).toHaveLength(1);
      expect(peers[0].name).toBe('second');
    });
  });

  describe('addPeer', () => {
    test('adds a new peer', () => {
      fedClient.addPeer({ name: 'new-peer', host: '10.0.0.1', port: 7854 });
      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].name).toBe('new-peer');
      expect(peers[0].host).toBe('10.0.0.1');
      expect(peers[0].port).toBe(7854);
      expect(peers[0].addedAt).toBeDefined();
    });

    test('updates existing peer by name', () => {
      fedClient.addPeer({ name: 'peer1', host: '10.0.0.1', port: 7854 });
      fedClient.addPeer({ name: 'peer1', host: '10.0.0.2', port: 8080 });
      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].host).toBe('10.0.0.2');
      expect(peers[0].port).toBe(8080);
    });

    test('preserves addedAt when updating existing peer', () => {
      const originalTime = '2024-01-01T00:00:00Z';
      fedClient.saveFedPeers([{ name: 'peer1', host: '10.0.0.1', port: 7854, addedAt: originalTime }]);
      fedClient.addPeer({ name: 'peer1', host: '10.0.0.2', port: 9999 });
      const peers = fedClient.loadFedPeers();
      expect(peers[0].addedAt).toBe(originalTime);
    });

    test('adds addedAt to new peer automatically', () => {
      const before = new Date().toISOString();
      fedClient.addPeer({ name: 'auto-time', host: 'localhost', port: 1234 });
      const after = new Date().toISOString();
      const peers = fedClient.loadFedPeers();
      const addedAt = peers[0].addedAt!;
      expect(addedAt >= before).toBe(true);
      expect(addedAt <= after).toBe(true);
    });

    test('supports optional secret field', () => {
      fedClient.addPeer({ name: 'secret-peer', host: 'secure.local', port: 7854, secret: 'my-secret' });
      const peers = fedClient.loadFedPeers();
      expect(peers[0].secret).toBe('my-secret');
    });
  });

  describe('removePeer', () => {
    test('removes peer by name', () => {
      fedClient.saveFedPeers([
        { name: 'keep', host: 'a.com', port: 1, addedAt: '2025-01-01T00:00:00Z' },
        { name: 'remove', host: 'b.com', port: 2, addedAt: '2025-01-01T00:00:00Z' },
      ]);
      fedClient.removePeer('remove');
      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].name).toBe('keep');
    });

    test('no-op when removing non-existent peer', () => {
      fedClient.saveFedPeers([
        { name: 'existing', host: 'a.com', port: 1, addedAt: '2025-01-01T00:00:00Z' },
      ]);
      fedClient.removePeer('nonexistent');
      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(1);
    });

    test('handles empty peers list', () => {
      fedClient.saveFedPeers([]);
      fedClient.removePeer('anything');
      const peers = fedClient.loadFedPeers();
      expect(peers).toHaveLength(0);
    });
  });

  describe('updatePeerLastSeen', () => {
    test('updates lastSeen for existing peer', () => {
      fedClient.saveFedPeers([
        { name: 'peer1', host: 'a.com', port: 1, addedAt: '2025-01-01T00:00:00Z' },
      ]);
      fedClient.updatePeerLastSeen('peer1');
      const peers = fedClient.loadFedPeers();
      expect(peers[0].lastSeen).toBeDefined();
      const lastSeen = new Date(peers[0].lastSeen!);
      expect(lastSeen.getTime()).toBeGreaterThan(0);
    });

    test('does not affect other peers', () => {
      fedClient.saveFedPeers([
        { name: 'peer1', host: 'a.com', port: 1, addedAt: '2025-01-01T00:00:00Z' },
        { name: 'peer2', host: 'b.com', port: 2, addedAt: '2025-01-01T00:00:00Z' },
      ]);
      fedClient.updatePeerLastSeen('peer1');
      const peers = fedClient.loadFedPeers();
      expect(peers[0].lastSeen).toBeDefined();
      expect(peers[1].lastSeen).toBeUndefined();
    });

    test('no-op for non-existent peer', () => {
      fedClient.saveFedPeers([
        { name: 'peer1', host: 'a.com', port: 1, addedAt: '2025-01-01T00:00:00Z' },
      ]);
      fedClient.updatePeerLastSeen('nonexistent');
      const peers = fedClient.loadFedPeers();
      expect(peers[0].lastSeen).toBeUndefined();
    });
  });

  describe('FedPeer type contract', () => {
    test('peer has required fields: name, host, port', () => {
      const peer: import('../src/fedClient').FedPeer = {
        name: 'test',
        host: 'localhost',
        port: 7854,
      };
      expect(peer.name).toBeDefined();
      expect(peer.host).toBeDefined();
      expect(peer.port).toBeDefined();
    });

    test('peer supports optional fields: secret, addedAt, lastSeen', () => {
      const peer: import('../src/fedClient').FedPeer = {
        name: 'full',
        host: 'remote.local',
        port: 8080,
        secret: 'shared-secret',
        addedAt: '2025-01-01T00:00:00Z',
        lastSeen: '2025-01-02T12:00:00Z',
      };
      expect(peer.secret).toBe('shared-secret');
      expect(peer.addedAt).toBe('2025-01-01T00:00:00Z');
      expect(peer.lastSeen).toBe('2025-01-02T12:00:00Z');
    });
  });

  describe('Config persistence', () => {
    test('peers survive save → load cycle', () => {
      const original = [
        { name: 'a', host: '10.0.0.1', port: 7854, addedAt: '2025-01-01T00:00:00Z', lastSeen: '2025-01-02T00:00:00Z' },
        { name: 'b', host: '10.0.0.2', port: 8080, secret: 'key', addedAt: '2025-01-03T00:00:00Z' },
      ];
      fedClient.saveFedPeers(original);
      const loaded = fedClient.loadFedPeers();
      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({ name: 'a', host: '10.0.0.1', port: 7854 });
      expect(loaded[0].lastSeen).toBe('2025-01-02T00:00:00Z');
      expect(loaded[1]).toMatchObject({ name: 'b', host: '10.0.0.2', port: 8080, secret: 'key' });
    });

    test('file is valid JSON after save', () => {
      fedClient.addPeer({ name: 'json-test', host: 'localhost', port: 1234 });
      const raw = fs.readFileSync(peersFile, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    test('file is pretty-printed', () => {
      fedClient.addPeer({ name: 'pretty', host: 'localhost', port: 1234 });
      const raw = fs.readFileSync(peersFile, 'utf-8');
      expect(raw).toContain('\n');
      expect(raw).toContain('  '); // 2-space indent
    });
  });
});
