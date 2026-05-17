/**
 * Tests for src/accountCrud.ts — account lifecycle CRUD.
 *
 * Like workspaceCrud.test, we mock os.homedir() to redirect ~/.sweech/
 * onto a temp directory. Additionally, the credential store is mocked
 * since the real macOS keychain backend would spawn `security` per call.
 */

import * as fs from 'fs';
import * as path from 'path';

// CRITICAL: mock BOTH `os` and `node:os`. vault.ts imports `node:os`,
// and the prefixed and unprefixed forms are different module specifiers
// to jest. A mock targeting only `os` leaves vault.ts writing to the
// REAL ~/.sweech/accounts.json. A prior version of this test file had
// exactly that bug and silently polluted the developer's vault during
// every test run.
//
// jest.mock factories are hoisted above all `let`/`const` declarations,
// so the factory body has to look up the (also-hoisted) `var`-declared
// `__mockHome` cell rather than referencing a hoisted helper.
var __mockHome: string | null = null;
jest.mock('os', () => {
  const actual = jest.requireActual('node:os');
  return {
    ...actual,
    homedir: () => __mockHome ?? actual.homedir(),
  };
});
jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return {
    ...actual,
    homedir: () => __mockHome ?? actual.homedir(),
  };
});
import * as os from 'os';
function setHomedir(p: string | null): void { __mockHome = p; }

// Mock credential store. Backing map is per-test (cleared in beforeEach).
const credStore = new Map<string, string>();
jest.mock('../src/credentialStore', () => ({
  getCredentialStore: () => ({
    get: async (service: string, account: string) => credStore.get(`${service}:${account}`) ?? null,
    set: async (service: string, account: string, value: string) => {
      credStore.set(`${service}:${account}`, value);
    },
    delete: async (service: string, account: string) => {
      credStore.delete(`${service}:${account}`);
    },
  }),
}));

import {
  AccountMeta,
  idFor,
  saveAccount,
  listAccounts,
  setActiveAccountId,
  getActiveAccountId,
  workspaceMarkerPath,
} from '../src/vault';
import {
  resolveAccount,
  setAccountHidden,
  logoutAccount,
  deleteAccount,
  editAccount,
  partitionByHidden,
} from '../src/accountCrud';

function isolateHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-acct-test-'));
  setHomedir(home);
  fs.mkdirSync(path.join(home, '.sweech'), { recursive: true, mode: 0o700 });
  return home;
}

async function seedAnthropic(email: string, orgId?: string): Promise<AccountMeta> {
  const meta: AccountMeta = {
    id: idFor('anthropic', email, orgId),
    kind: 'anthropic',
    email,
    orgId,
    plan: 'Max 20x',
    addedAt: '2026-05-17T00:00:00.000Z',
    status: 'ok',
  };
  await saveAccount(meta, { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 86400_000 });
  return meta;
}

describe('resolveAccount', () => {
  let home: string;
  beforeEach(() => { home = isolateHome(); credStore.clear(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); setHomedir(null); });

  test('by 12-char id', async () => {
    const a = await seedAnthropic('a@b.c');
    const r = resolveAccount(a.id);
    expect('resolved' in r && r.resolved.email).toBe('a@b.c');
  });

  test('by email (case-insensitive)', async () => {
    await seedAnthropic('Mixed@Case.com');
    const r = resolveAccount('mixed@case.com');
    expect('resolved' in r).toBe(true);
  });

  test('returns notFound when email not present', () => {
    expect('notFound' in resolveAccount('nope@nope.nope')).toBe(true);
  });

  test('returns ambiguous when two orgs share an email', async () => {
    await seedAnthropic('shared@x.com', 'org-1');
    await seedAnthropic('shared@x.com', 'org-2');
    const r = resolveAccount('shared@x.com');
    expect('ambiguous' in r && r.ambiguous.length).toBe(2);
  });

  test('kind filter narrows ambiguity', async () => {
    await seedAnthropic('shared@x.com', 'org-1');
    await seedAnthropic('shared@x.com', 'org-2');
    // Still ambiguous within kind=anthropic since both are anthropic.
    const r = resolveAccount('shared@x.com', 'anthropic');
    expect('ambiguous' in r).toBe(true);
  });
});

describe('setAccountHidden', () => {
  let home: string;
  beforeEach(() => { home = isolateHome(); credStore.clear(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); setHomedir(null); });

  test('hide → persists hidden=true', async () => {
    const a = await seedAnthropic('a@b.c');
    const result = setAccountHidden('a@b.c', 'hide');
    expect(result.noop).toBe(false);
    expect(result.after.hidden).toBe(true);

    const re = listAccounts().find(x => x.id === a.id)!;
    expect(re.hidden).toBe(true);
  });

  test('hide → hide is a noop', async () => {
    await seedAnthropic('a@b.c');
    setAccountHidden('a@b.c', 'hide');
    const result = setAccountHidden('a@b.c', 'hide');
    expect(result.noop).toBe(true);
  });

  test('unhide flips back', async () => {
    await seedAnthropic('a@b.c');
    setAccountHidden('a@b.c', 'hide');
    const result = setAccountHidden('a@b.c', 'unhide');
    expect(result.before.hidden).toBe(true);
    expect(result.after.hidden).toBe(false);
  });

  test('throws on unknown email', () => {
    expect(() => setAccountHidden('nope@nope.nope', 'hide'))
      .toThrow(/not found/);
  });
});

describe('logoutAccount — decoupling contract', () => {
  let home: string;
  beforeEach(() => { home = isolateHome(); credStore.clear(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); setHomedir(null); });

  test('drops keychain secret + clears markers + sets status=unauthorized', async () => {
    const a = await seedAnthropic('a@b.c');
    const workspaces = [{ commandName: 'claude-ted' }];

    // Mount the account into the workspace so logout has something to clear.
    const wsDir = path.join(home, '.claude-ted');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    setActiveAccountId('claude-ted', a.id);
    expect(getActiveAccountId('claude-ted')).toBe(a.id);

    const result = await logoutAccount('a@b.c', workspaces);
    expect(result.hadSecret).toBe(true);
    expect(result.unmountedWorkspaces).toEqual(['claude-ted']);

    // Marker is gone.
    expect(getActiveAccountId('claude-ted')).toBeNull();
    // Workspace data dir is intact — that's the load-bearing decoupling.
    expect(fs.existsSync(wsDir)).toBe(true);
    // Account row is intact, but status flipped.
    const re = listAccounts().find(x => x.id === a.id)!;
    expect(re).toBeDefined();
    expect(re.status).toBe('unauthorized');
    // Keychain entry is gone.
    expect(credStore.size).toBe(0);
  });

  test('logging out an account with no credentials reports hadSecret=false', async () => {
    await seedAnthropic('a@b.c');
    credStore.clear(); // simulate "credentials manually deleted"
    const result = await logoutAccount('a@b.c', []);
    expect(result.hadSecret).toBe(false);
  });
});

describe('deleteAccount — decoupling contract', () => {
  let home: string;
  beforeEach(() => { home = isolateHome(); credStore.clear(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); setHomedir(null); });

  test('removes account row + secret; clears markers; LEAVES workspace dir intact', async () => {
    const a = await seedAnthropic('ted@anthropic.test');
    const workspaces = [{ commandName: 'claude-ted' }];

    // Mount + seed workspace data.
    const wsDir = path.join(home, '.claude-ted');
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    setActiveAccountId('claude-ted', a.id);
    fs.writeFileSync(path.join(wsDir, 'history.jsonl'), '{"session":"important"}\n');

    const result = await deleteAccount('ted@anthropic.test', workspaces);
    expect(result.hadSecret).toBe(true);
    expect(result.unmountedWorkspaces).toEqual(['claude-ted']);

    // Account row gone.
    expect(listAccounts().find(x => x.id === a.id)).toBeUndefined();
    // Keychain entry gone.
    expect(credStore.size).toBe(0);
    // Marker gone.
    expect(fs.existsSync(workspaceMarkerPath('claude-ted'))).toBe(false);
    // *** Critical: workspace data dir + history are intact ***
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, 'history.jsonl'), 'utf-8')).toContain('important');
  });

  test('--keep-workspace-markers preserves the .sweech-account file', async () => {
    const a = await seedAnthropic('a@b.c');
    const workspaces = [{ commandName: 'claude-x' }];
    fs.mkdirSync(path.join(home, '.claude-x'), { recursive: true, mode: 0o700 });
    setActiveAccountId('claude-x', a.id);

    const result = await deleteAccount('a@b.c', workspaces, { keepWorkspaceMarkers: true });
    expect(result.unmountedWorkspaces).toEqual([]);
    // Marker survives — even though the account it points to is gone.
    expect(getActiveAccountId('claude-x')).toBe(a.id);
  });

  test('refuses on ambiguous email and surfaces hint', async () => {
    await seedAnthropic('shared@x.com', 'org-1');
    await seedAnthropic('shared@x.com', 'org-2');
    await expect(deleteAccount('shared@x.com', [])).rejects.toThrow(/ambiguous/);
  });

  test('ambiguity error message names the match count and the escape hatch', async () => {
    // Integration audit follow-up: the CLI surfaces this string verbatim
    // in the `--json` error envelope. Renderers depend on the (N matches)
    // count + the "12-char id or --kind" hint to guide the user. Lock
    // the format with a strong assertion so a future cosmetic edit
    // doesn't silently drop the breadcrumbs.
    await seedAnthropic('shared@x.com', 'org-1');
    await seedAnthropic('shared@x.com', 'org-2');
    await seedAnthropic('shared@x.com', 'org-3');
    await expect(deleteAccount('shared@x.com', [])).rejects.toThrow(
      /shared@x\.com.+ambiguous.+3 matches.+12-char id.+--kind/s,
    );
  });
});

describe('editAccount', () => {
  let home: string;
  beforeEach(() => { home = isolateHome(); credStore.clear(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); setHomedir(null); });

  test('updates displayName + plan; leaves id/kind/email untouched', async () => {
    const a = await seedAnthropic('a@b.c');
    const merged = editAccount('a@b.c', { displayName: 'Alice', plan: 'Pro' });
    expect(merged.id).toBe(a.id);
    expect(merged.kind).toBe('anthropic');
    expect(merged.email).toBe('a@b.c');
    expect(merged.displayName).toBe('Alice');
    expect(merged.plan).toBe('Pro');
  });
});

describe('vault → listAccountsV2 propagates hidden (codex P2.1 regression)', () => {
  let home: string;
  beforeEach(() => { home = isolateHome(); credStore.clear(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); setHomedir(null); });

  test('hidden flag round-trips through listAccountsV2 into the JSON surface', async () => {
    const a = await seedAnthropic('a@b.c');
    setAccountHidden('a@b.c', 'hide');

    // The hidden flag has to survive the legacy AccountMeta read AND
    // the V2 projection — both consumers (terminal renderer + SweechBar
    // via `sweech accounts list --json`) depend on this.
    const { listAccountsV2 } = require('../src/vault');
    const v2 = listAccountsV2();
    const oauth = v2.find((e: any) => e.kind === 'oauth' && e.id === a.id);
    expect(oauth).toBeDefined();
    expect(oauth.hidden).toBe(true);

    // Round-trip after unhide — the flag is dropped entirely so
    // older callers don't see a `hidden: false` ghost in the JSON.
    setAccountHidden('a@b.c', 'unhide');
    const v2After = listAccountsV2();
    const oauthAfter = v2After.find((e: any) => e.kind === 'oauth' && e.id === a.id);
    expect(oauthAfter.hidden).toBeUndefined();
  });
});

describe('partitionByHidden', () => {
  test('splits accounts into visible and hidden arrays', () => {
    const accts: AccountMeta[] = [
      { id: '1', kind: 'anthropic', email: 'a', addedAt: '' },
      { id: '2', kind: 'anthropic', email: 'b', addedAt: '', hidden: true },
      { id: '3', kind: 'openai', email: 'c', addedAt: '' },
    ];
    const { visible, hidden } = partitionByHidden(accts);
    expect(visible.map(a => a.id)).toEqual(['1', '3']);
    expect(hidden.map(a => a.id)).toEqual(['2']);
  });
});
