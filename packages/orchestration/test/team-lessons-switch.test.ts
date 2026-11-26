import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/** Switching "team lessons go in by themselves" on takes in those that were waiting; an office's own guess still waits. */
test('switched on, the team lessons that waited go in', () => {
  const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  eng.core.updateSettings({ selfImprovement: { ...eng.core.settings.selfImprovement, autoApproveSharedLessons: false } });
  const now = new Date().toISOString();
  const put = (id: string, scope: string, source: string) => eng.core.put('lesson', { id, scope, employeeId: null, projectId: null, text: id, appliesWhen: '', source, evidence: [], status: 'proposed', authoredBy: { kind: 'employee', id: 'e', name: 'E' }, appliedCount: 0, createdAt: now, updatedAt: now } as never);
  put('team', 'company', 'retrospective');
  put('guess', 'company', 'orchestrator');
  eng.core.updateSettings({ selfImprovement: { ...eng.core.settings.selfImprovement, autoApproveSharedLessons: true } });
  assert.equal(eng.core.lessons.get('team')!.status, 'active');
  assert.equal(eng.core.lessons.get('guess')!.status, 'proposed', 'words that are not evidently a rule still wait');
});
