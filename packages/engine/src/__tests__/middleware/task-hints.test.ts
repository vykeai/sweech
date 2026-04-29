import { describe, it, expect } from 'vitest';
import { TASK_REQUIREMENTS } from '../../select.js';
import type { SelectOptions } from '../../select.js';

describe('TASK_REQUIREMENTS', () => {
  const ALL_TASK_TYPES = ['coding', 'analysis', 'planning', 'review', 'chat', 'research'];

  it('has entries for all task types', () => {
    for (const taskType of ALL_TASK_TYPES) {
      expect(TASK_REQUIREMENTS).toHaveProperty(taskType);
    }
  });

  it('coding requires toolUse', () => {
    expect(TASK_REQUIREMENTS.coding).toEqual({ supportsToolUse: true });
  });

  it('analysis requires thinking', () => {
    expect(TASK_REQUIREMENTS.analysis).toEqual({ supportsThinking: true });
  });

  it('planning requires thinking', () => {
    expect(TASK_REQUIREMENTS.planning).toEqual({ supportsThinking: true });
  });

  it('review requires toolUse', () => {
    expect(TASK_REQUIREMENTS.review).toEqual({ supportsToolUse: true });
  });

  it('chat has no requirements', () => {
    expect(TASK_REQUIREMENTS.chat).toEqual({});
  });

  it('research requires toolUse', () => {
    expect(TASK_REQUIREMENTS.research).toEqual({ supportsToolUse: true });
  });
});

describe('SelectOptions taskType', () => {
  it('taskType flows through SelectOptions', () => {
    const opts: SelectOptions = {
      provider: 'claude',
      taskType: 'coding',
    };
    expect(opts.taskType).toBe('coding');
  });

  it('taskType is optional', () => {
    const opts: SelectOptions = {};
    expect(opts.taskType).toBeUndefined();
  });
});
