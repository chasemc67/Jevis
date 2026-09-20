import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureJevEvaluator, loadFixture, parseFixture, replayFixture } from '../apps/speech-filter-harness/src/fixtures/replay.js';
import type { WordFixture } from '../apps/speech-filter-harness/src/fixtures/replay.js';

const unclear = { addressing: 'unclear' as const, directedProbability: 0.2, ambientProbability: 0.2, isDirectedProbability: 0.3 };
const directed = { addressing: 'directed' as const, directedProbability: 0.95, ambientProbability: 0.03, isDirectedProbability: 0.98 };

function fixture(): WordFixture {
  return {
    version: 1,
    name: 'test',
    durationMs: 0,
    events: [{
      atMs: 0, type: 'transcript',
      event: {
        text: 'Summarize', startMs: 0, endMs: 100, isFinal: true,
        words: [{ text: 'Summarize', startMs: 0, endMs: 100, isFinal: true }],
      },
    }, { atMs: 0, type: 'boundary', reason: 'test_end' }],
    dryRun: { latencyMs: 0, rules: [{ text: 'Summarize', ...directed }], defaultDecision: { ...unclear } },
  };
}

test('all bundled fixtures validate as normalized word streams', async () => {
  for (const name of ['mixed', 'ambient-only', 'unclear']) {
    const loaded = await loadFixture(`apps/speech-filter-harness/fixtures/ambient/${name}.json`);
    assert.equal(loaded.name, name);
    assert.ok(loaded.durationMs > loaded.events.at(-1)!.atMs + 1500);
    assert.ok(loaded.events.some(event => event.type === 'transcript'));
  }
});

test('fixture validation rejects out of order events and malformed word ranges', () => {
  const invalidTime = fixture();
  invalidTime.durationMs = 100;
  invalidTime.events[0]!.atMs = 90;
  assert.throws(() => parseFixture(invalidTime), /event times must be ordered/);
  const invalidWord = fixture();
  const first = invalidWord.events[0]!;
  assert.equal(first.type, 'transcript');
  if (first.type === 'transcript') first.event.words[0]!.endMs = 101;
  assert.throws(() => parseFixture(invalidWord), /within the event time range/);
  assert.throws(() => parseFixture({ ...fixture(), version: 2 }), /fixture version/);
});

test('fixture validation rejects duplicate labels and invalid probabilities', () => {
  const duplicate = fixture();
  duplicate.dryRun.rules.push(duplicate.dryRun.rules[0]!);
  assert.throws(() => parseFixture(duplicate), /duplicate label/);
  const invalidProbability = fixture();
  invalidProbability.dryRun.defaultDecision.directedProbability = 1.5;
  assert.throws(() => parseFixture(invalidProbability), /probability exceeds 1/);
});

test('dry-run evaluator uses only exact explicit labels and preserves candidate indices', async () => {
  const evaluator = new FixtureJevEvaluator(fixture());
  const result = await evaluator.evaluate({
    regionId: 1, seq: 1, fullTranscript: 'background Summarize',
    candidates: [{ startIndex: 1, text: 'Summarize' }, { startIndex: 0, text: 'background Summarize' }],
  }, new AbortController().signal);
  assert.deepEqual(result.decisions, [{ startIndex: 1, ...directed }, { startIndex: 0, ...unclear }]);
  assert.ok(result.latencyMs >= 0);
});

test('replay preserves callback order and does not mutate source events', async () => {
  const input = fixture();
  input.events.push({ atMs: 0, type: 'connection', connected: false });
  const seen: string[] = [];
  await replayFixture(input, {
    onConnection: connected => { seen.push(`connected:${connected}`); },
    onTranscript: event => { seen.push(event.text); event.words[0]!.text = 'mutated'; },
    onBoundary: reason => { seen.push(reason); },
    log: () => {},
  });
  assert.deepEqual(seen, ['connected:true', 'Summarize', 'test_end', 'connected:false']);
  const first = input.events[0]!;
  assert.equal(first.type === 'transcript' && first.event.words[0]!.text, 'Summarize');
});

test('fixture replay and dry-run evaluation respect cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(replayFixture(fixture(), {
    onConnection: () => assert.fail('aborted fixture must not connect'),
    onTranscript: () => assert.fail('aborted fixture must not deliver text'),
    onBoundary: () => assert.fail('aborted fixture must not emit boundaries'),
    log: () => {},
  }, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(new FixtureJevEvaluator(fixture()).evaluate({
    regionId: 1, seq: 1, fullTranscript: '', candidates: [],
  }, controller.signal), { name: 'AbortError' });
});
