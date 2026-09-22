import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, savedRevisions, type Revision } from '../shared/history';

test('diff preserves both texts through additions, removals, replacements and whitespace', () => {
  const cases = [['', 'First'], ['First', ''], ['A\nB\nC', 'A\nNew\nC'], ['A\nB\nA', 'B\nA\nB'], ['A\n', 'A'], ['A B', 'A  B'], ['x'.repeat(500), 'y'.repeat(500)]];
  for (const [before, after] of cases) {
    const diff = diffLines(before, after);
    assert.equal(diff.filter(p => p.kind !== 'added').flatMap(p => p.lines).join('\n'), before);
    assert.equal(diff.filter(p => p.kind !== 'removed').flatMap(p => p.lines).join('\n'), after);
    assert.ok(diff.some(p => p.kind !== 'same'));
  }
  assert.deepEqual(diffLines('same', 'same'), [{ kind: 'same', lines: ['same'] }]);
});
test('large changes have a bounded, lossless replacement diff', () => {
  const before = Array.from({ length: 2000 }, (_, i) => `Before ${i}`).join('\n');
  const after = Array.from({ length: 2000 }, (_, i) => `After ${i}`).join('\n');
  assert.deepEqual(diffLines(before, after).map(part => part.kind), ['removed', 'added']);
});
test('legacy snapshots become meaningful saved versions without deleting history', () => {
  const entry = (id: string, markdown: string, previousMarkdown?: string): Revision => ({ _id: id, markdown, previousMarkdown, docId: 'doc', reason: 'autosave', createdAt: 1 });
  const old = [entry('1', ''), entry('2', 'First'), entry('3', 'First'), entry('4', 'Second'), entry('5', 'Third', 'Second')];
  const result = savedRevisions(old, 'Third');
  assert.deepEqual(result.map(r => [r.previousMarkdown, r.markdown]), [['Second', 'Third'], ['First', 'Second'], ['', 'First']]);
  assert.equal(old.length, 5); assert.equal(old[0].markdown, '');
});
