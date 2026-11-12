import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openFor, db, scoreKey } from '../../src/offline/db.js';
import { queueScore, push } from '../../src/offline/syncEngine.js';

const assessment = { assessment_id: 'A1', class_id: 'C1', max_score: 50 };
const actor = { sub: 'teacher-1', schoolId: 'S1' };

test('a mark saved offline keeps its status and is sent with it on reconnect', async () => {
  openFor('teacher-1');
  await queueScore({ schoolId: 'S1', assessment, studentId: 'st1', rawScore: null, markStatus: 'ABSENT', actor });
  await queueScore({ schoolId: 'S1', assessment, studentId: 'st2', rawScore: 40, actor });

  const absent = await db().scores.get(scoreKey('A1', 'st1'));
  assert.equal(absent.mark_status, 'ABSENT');
  assert.equal(absent._pending, true);
  assert.equal((await db().scores.get(scoreKey('A1', 'st2'))).normalized_score, 80);

  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body).variables.input;
    const results = sent.entries.map((e) => ({ student_id: e.student_id, outcome: 'APPLIED', reason: null,
      item: { ...e, assessment_id: 'A1', class_id: 'C1', mark_status: e.mark_status || 'SCORED', _version: 1 } }));
    return { ok: true, json: async () => ({ data: { submitScores: { accepted: results.length, rejected: 0, review: 0, conflicted: 0, results } } }) };
  };
  await push();

  assert.deepEqual(sent.entries.find((e) => e.student_id === 'st1'), { student_id: 'st1', raw_score: null, mark_status: 'ABSENT', _version: null });
  assert.equal(sent.entries.find((e) => e.student_id === 'st2').mark_status, undefined);
  assert.equal(await db().outbox.count(), 0);
  assert.equal((await db().scores.get(scoreKey('A1', 'st1')))._pending, undefined);
});

import { afterEdit, follow, finish, versionFor } from '../../src/offline/scoreDrafts.js';

test('score drafts: an edit keeps the version it started from until it is saved or undone', () => {
  const v1 = { raw_score: 20, mark_status: 'SCORED', _version: 1 };
  const v2 = { raw_score: 25, mark_status: 'SCORED', _version: 2 };
  let bases = afterEdit({}, 'st1', '2', v1);
  bases = afterEdit(bases, 'st1', '27', v2); // later keystrokes do not move the base
  assert.equal(versionFor(bases, { st1: v2 }, 'st1'), 1);
  assert.deepEqual(afterEdit(bases, 'st1', '25', v2), {}); // typed back to the device copy: no longer an edit
  assert.equal(versionFor({}, { st1: v2 }, 'st1'), 2);
  assert.deepEqual(finish({ st1: { version: 1 }, st2: { version: 3 } }, ['st1']), { st2: { version: 3 } });
});

test('score drafts: rows not being edited follow the device copy; rows being edited do not', () => {
  const drafts = { st1: '20', st2: '9', st3: 'abs' };
  const saved = { st1: { raw_score: 25, _version: 2 }, st2: { raw_score: 30, _version: 4 }, st3: { raw_score: null, mark_status: 'ABSENT' } };
  const next = follow(drafts, { st2: { version: 3 } }, saved);
  assert.deepEqual(next, { st1: '25', st2: '9', st3: 'abs' });
  assert.equal(follow(next, { st2: { version: 3 } }, saved), next, 'unchanged drafts keep the same object (no extra render)');
});
