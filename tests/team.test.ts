/**
 * Tests for local team management operations.
 *
 * Covers: joinTeamLocal, leaveTeamLocal, getLocalMembers, addLocalInvite
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  joinTeamLocal,
  leaveTeamLocal,
  getLocalMembers,
  addLocalInvite,
  loadTeamConfig,
  saveTeamConfig,
  removeTeamConfig,
  getTeamConfigPath,
  TeamConfig,
} from '../src/team';

describe('Team local operations', () => {
  const configPath = getTeamConfigPath();

  // Back up and restore any existing team config
  let originalConfig: string | null = null;

  beforeAll(() => {
    try {
      if (fs.existsSync(configPath)) {
        originalConfig = fs.readFileSync(configPath, 'utf-8');
      }
    } catch { /* no existing config */ }
  });

  afterAll(() => {
    if (originalConfig !== null) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, originalConfig);
    } else {
      try { fs.unlinkSync(configPath); } catch { /* ok */ }
    }
  });

  beforeEach(() => {
    // Ensure clean state before each test
    try { fs.unlinkSync(configPath); } catch { /* ok */ }
  });

  // ---------------------------------------------------------------------------
  // joinTeamLocal
  // ---------------------------------------------------------------------------

  describe('joinTeamLocal', () => {
    test('creates team config from invite code', () => {
      const config = joinTeamLocal('abc123xyz');
      expect(config).toBeDefined();
      expect(config.teamId).toBeTruthy();
      expect(config.name).toBe('team-abc123xy');
      expect(config.role).toBe('admin');
      expect(config.inviteCode).toBe('abc123xyz');
      expect(config.joinedAt).toBeTruthy();
      expect(config.members).toHaveLength(1);
      expect(config.members[0].role).toBe('admin');
      expect(config.pendingInvites).toEqual([]);
    });

    test('persists config to disk', () => {
      joinTeamLocal('persist-test');
      const loaded = loadTeamConfig();
      expect(loaded).not.toBeNull();
      expect(loaded!.teamId).toBeTruthy();
      expect(loaded!.inviteCode).toBe('persist-test');
    });

    test('same invite code produces same teamId', () => {
      const config1 = joinTeamLocal('deterministic');
      removeTeamConfig();
      const config2 = joinTeamLocal('deterministic');
      expect(config1.teamId).toBe(config2.teamId);
    });

    test('throws if already in a team', () => {
      joinTeamLocal('first-team');
      expect(() => joinTeamLocal('second-team')).toThrow(/Already a member/);
    });

    test('includes current user as first member', () => {
      const config = joinTeamLocal('member-check');
      expect(config.members[0].name).toBe(os.userInfo().username);
      expect(config.members[0].email).toContain('@local');
    });
  });

  // ---------------------------------------------------------------------------
  // leaveTeamLocal
  // ---------------------------------------------------------------------------

  describe('leaveTeamLocal', () => {
    test('removes team config file', () => {
      joinTeamLocal('leave-test');
      expect(loadTeamConfig()).not.toBeNull();

      leaveTeamLocal();
      expect(loadTeamConfig()).toBeNull();
    });

    test('throws if not in a team', () => {
      expect(() => leaveTeamLocal()).toThrow(/Not connected to a team/);
    });

    test('can rejoin after leaving', () => {
      joinTeamLocal('rejoin-code');
      leaveTeamLocal();
      const config = joinTeamLocal('new-code');
      expect(config.inviteCode).toBe('new-code');
    });
  });

  // ---------------------------------------------------------------------------
  // getLocalMembers
  // ---------------------------------------------------------------------------

  describe('getLocalMembers', () => {
    test('returns members from config', () => {
      joinTeamLocal('members-test');
      const members = getLocalMembers();
      expect(members).toHaveLength(1);
      expect(members[0].role).toBe('admin');
    });

    test('throws if not in a team', () => {
      expect(() => getLocalMembers()).toThrow(/Not connected to a team/);
    });

    test('returns all members when config has multiple', () => {
      const config = joinTeamLocal('multi-member');
      config.members.push({
        email: 'bob@example.com',
        name: 'bob',
        role: 'member',
        joinedAt: new Date().toISOString(),
      });
      saveTeamConfig(config);

      const members = getLocalMembers();
      expect(members).toHaveLength(2);
      expect(members[1].email).toBe('bob@example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // addLocalInvite
  // ---------------------------------------------------------------------------

  describe('addLocalInvite', () => {
    test('adds email to pending invites', () => {
      joinTeamLocal('invite-test');
      addLocalInvite('alice@example.com');

      const config = loadTeamConfig()!;
      expect(config.pendingInvites).toContain('alice@example.com');
    });

    test('throws if not in a team', () => {
      expect(() => addLocalInvite('nobody@example.com')).toThrow(/Not connected to a team/);
    });

    test('throws for duplicate invite', () => {
      joinTeamLocal('dup-invite');
      addLocalInvite('dup@example.com');
      expect(() => addLocalInvite('dup@example.com')).toThrow(/already in the pending invites/);
    });

    test('throws if email is already a member', () => {
      const config = joinTeamLocal('member-invite');
      // The first member has an @local email, so use that
      const memberEmail = config.members[0].email;
      expect(() => addLocalInvite(memberEmail)).toThrow(/already a team member/);
    });

    test('can add multiple invites', () => {
      joinTeamLocal('multi-invite');
      addLocalInvite('a@example.com');
      addLocalInvite('b@example.com');
      addLocalInvite('c@example.com');

      const config = loadTeamConfig()!;
      expect(config.pendingInvites).toHaveLength(3);
      expect(config.pendingInvites).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    });
  });

  // ---------------------------------------------------------------------------
  // loadTeamConfig / saveTeamConfig edge cases
  // ---------------------------------------------------------------------------

  describe('config persistence edge cases', () => {
    test('loadTeamConfig returns null for missing file', () => {
      expect(loadTeamConfig()).toBeNull();
    });

    test('loadTeamConfig returns null for malformed JSON', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, 'not json{{{');
      expect(loadTeamConfig()).toBeNull();
    });

    test('saveTeamConfig creates directory if needed', () => {
      // Remove config file (directory should already exist from test setup)
      const config: TeamConfig = {
        teamId: 'test-id',
        name: 'test-team',
        hubUrl: '',
        role: 'admin',
        joinedAt: new Date().toISOString(),
        members: [],
        pendingInvites: [],
      };
      saveTeamConfig(config);
      expect(loadTeamConfig()).not.toBeNull();
      expect(loadTeamConfig()!.teamId).toBe('test-id');
    });
  });
});
