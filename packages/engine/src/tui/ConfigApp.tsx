import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { detectEngines } from '../detect.js';
import { loadProfiles } from '../middleware/profiles.js';
import { getDefaultProfile, getFailoverOrder } from '../middleware/profiles.js';
import { keyExists } from '../keychain.js';
import { MODEL_OPTIONS } from '../models.js';
import type { CredentialProfile } from '../middleware/types.js';

interface EngineInfo {
  engine: string;
  available: boolean;
  binaryPath?: string;
  providers?: string[];
}

export function ConfigApp() {
  const { exit } = useApp();
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [profiles, setProfiles] = useState<Record<string, CredentialProfile>>({});
  const [defaults, setDefaults] = useState<Record<string, string | undefined>>({});
  const [failover, setFailover] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [detected, profs] = await Promise.all([
        detectEngines(),
        loadProfiles(),
      ]);
      setEngines(detected);
      setProfiles(profs);

      const defs: Record<string, string | undefined> = {};
      for (const eid of ['claude-code', 'codex', 'qwen-code', 'gemini-cli'] as const) {
        defs[eid] = await getDefaultProfile(eid);
      }
      setDefaults(defs);
      setFailover(await getFailoverOrder());
      setLoading(false);
    })();
  }, []);

  const profileList = Object.values(profiles);
  const totalItems = profileList.length + engines.length;

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx(Math.max(0, selectedIdx - 1));
    }
    if (key.downArrow) {
      setSelectedIdx(Math.min(totalItems - 1, selectedIdx + 1));
    }
  });

  if (loading) {
    return <Text color="gray">Loading config...</Text>;
  }

  const modelCount = Object.keys(MODEL_OPTIONS).length;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Omnai Config</Text>
        <Text color="gray"> — {engines.filter(e => e.available).length} engines, {profileList.length} profiles, {modelCount} models</Text>
      </Box>

      {/* Engines */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>Engines</Text>
        {engines.map((e, i) => {
          const idx = i;
          const isSelected = idx === selectedIdx;
          return (
            <Box key={e.engine}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '› ' : '  '}
              </Text>
              <Text color={e.available ? 'green' : 'red'}>
                {e.available ? '✓' : '✗'}
              </Text>
              <Text> {e.engine.padEnd(14)}</Text>
              {e.providers && e.providers.length > 0 && (
                <Text color="gray">{e.providers.join(', ')}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Profiles */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>Profiles</Text>
        {profileList.length === 0 && (
          <Text color="gray">  No profiles configured. Run: omnai profiles add &lt;name&gt;</Text>
        )}
        {profileList.map((p, i) => {
          const idx = engines.length + i;
          const isSelected = idx === selectedIdx;
          const hasKey = keyExists(p.name);
          return (
            <Box key={p.name}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '› ' : '  '}
              </Text>
              <Text color={hasKey ? 'green' : 'yellow'}>
                {hasKey ? '🔑' : '⚠'}
              </Text>
              <Text> {p.name.padEnd(20)}</Text>
              <Text color="gray">{p.provider}</Text>
              {p.baseUrl && <Text color="blue"> → {p.baseUrl}</Text>}
              {!hasKey && p.provider !== 'claude' && p.provider !== 'codex' && (
                <Text color="yellow"> (no key)</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Defaults & Failover */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>Routing</Text>
        {Object.entries(defaults).map(([engine, profile]) => (
          profile ? (
            <Box key={engine}>
              <Text color="gray">  {engine} → </Text>
              <Text>{profile}</Text>
            </Box>
          ) : null
        ))}
        {failover.length > 0 && (
          <Box>
            <Text color="gray">  failover: </Text>
            <Text>{failover.join(' → ')}</Text>
          </Box>
        )}
      </Box>

      {/* Controls */}
      <Box>
        <Text color="gray">[↑↓] navigate  [q] quit</Text>
      </Box>
    </Box>
  );
}
