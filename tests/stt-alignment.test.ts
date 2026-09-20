import assert from 'node:assert/strict';
import test from 'node:test';
import { WordAlignment } from '../apps/speech-filter-harness/src/stt/alignment.js';
import type { WordEvent } from '../apps/speech-filter-harness/src/stt/types.js';

function event(text: string, startMs = 0, isFinal = false): WordEvent {
  const words = text ? text.split(' ').map((text, index) => ({ text, startMs: startMs + index * 200, endMs: startMs + (index + 1) * 200, isFinal })) : [];
  return { text, words, startMs, endMs: startMs + words.length * 200, isFinal };
}

test('interims replace hypotheses; corrections do not duplicate words', () => {
  const align = new WordAlignment();
  assert.equal(align.apply(event('Please')).newWordCount, 1);
  const added = align.apply(event('Please timer'));
  assert.equal(added.newWordCount, 1);
  const corrected = align.apply(event('Please summarize'));
  assert.equal(corrected.text, 'Please summarize');
  assert.equal(corrected.newWordCount, 0);
  assert.equal(corrected.contentChanged, true);
  assert.equal(corrected.changedFromIndex, 1);
  const shortened = align.apply(event('Please'));
  assert.equal(shortened.text, 'Please');
  assert.equal(shortened.contentChanged, true);
});

test('finalization updates metadata without retriggering content evaluation', () => {
  const align = new WordAlignment();
  align.apply(event('one two'));
  const final = align.apply(event('one two', 0, true));
  assert.equal(final.changed, true);
  assert.equal(final.contentChanged, false);
  assert.equal(final.newWordCount, 0);
  assert.ok(final.words.every(word => word.isFinal));
  const duplicate = align.apply(event('one two', 0, true));
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.text, 'one two');
});

test('final segments merge with later interims on the shared audio clock', () => {
  const align = new WordAlignment();
  align.apply(event('ambient words', 0, true));
  align.apply(event('Please', 400));
  const result = align.apply(event('Please summarize', 400, true));
  assert.equal(result.text, 'ambient words Please summarize');
  assert.equal(result.words.length, 4);
  assert.equal(result.newWordCount, 1);
  const lateInterim = align.apply(event('Please summarize', 400));
  assert.equal(lateInterim.changed, false);
  assert.ok(lateInterim.words.every(word => word.isFinal));
});

test('partial finalization preserves the still-unfinalized tail', () => {
  const align = new WordAlignment();
  align.apply(event('one two three'));
  const firstFinal = align.apply(event('one two', 0, true));
  assert.equal(firstFinal.text, 'one two three');
  assert.deepEqual(firstFinal.words.map(word => word.isFinal), [true, true, false]);
  assert.equal(align.apply(event('three four', 400, true)).text, 'one two three four');
  align.reset();
  assert.equal(align.apply(event('fresh', 1000)).text, 'fresh');
});

test('an empty replacement retracts interim words while preserving finalized words', () => {
  const align = new WordAlignment();
  align.apply(event('stable', 0, true));
  align.apply(event('hallucination', 200));
  const result = align.apply(event('', 200));
  assert.equal(result.text, 'stable');
  assert.equal(result.contentChanged, true);
});
