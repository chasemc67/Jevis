import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../apps/speech-filter-harness/src/config.js';
import { MemoryQueueDownstream } from '../apps/speech-filter-harness/src/downstream/console.js';
import { SpeechFilter } from '../apps/speech-filter-harness/src/filter/controller.js';
import type { Clock } from '../apps/speech-filter-harness/src/filter/debounce.js';
import { confidenceGate } from '../apps/speech-filter-harness/src/filter/gate.js';
import { candidateWindows } from '../apps/speech-filter-harness/src/filter/slidingWindow.js';
import type { EvaluationInput, JevEvaluation, JevEvaluator } from '../apps/speech-filter-harness/src/jev/types.js';
import type { WordEvent } from '../apps/speech-filter-harness/src/stt/types.js';

async function settle(): Promise<void> { for (let i = 0; i < 15; i++) await Promise.resolve(); }

class ManualClock implements Clock {
  current = 0;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.current; }
  setTimeout(callback: () => void, ms: number): number {
    this.timers.set(++this.id, { at: this.current + ms, callback }); return this.id;
  }
  clearTimeout(id: unknown): void { this.timers.delete(id as number); }
  async advance(ms: number): Promise<void> {
    const end = this.current + ms;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      this.current = next[1].at; this.timers.delete(next[0]); next[1].callback(); await settle();
    }
    this.current = end; await settle();
  }
}

function event(text: string, offset = 0): WordEvent {
  const parts = text.split(' ');
  return {
    text, startMs: offset, endMs: offset + parts.length * 100, isFinal: false,
    words: parts.map((text, i) => ({ text, startMs: offset + i * 100, endMs: offset + (i + 1) * 100, isFinal: false })),
  };
}

function result(input: EvaluationInput, mode: 'directed' | 'ambient' | 'unclear' = 'directed'): JevEvaluation {
  return {
    latencyMs: 20,
    decisions: input.candidates.map(c => ({ startIndex: c.startIndex, addressing: mode,
      directedProbability: mode === 'directed' ? 0.9 : 0.05,
      ambientProbability: mode === 'ambient' ? 0.9 : 0.05,
      isDirectedProbability: mode === 'directed' ? 0.9 : 0.1,
    })),
  };
}

function harness(evaluator: JevEvaluator, overrides = {}) {
  const clock = new ManualClock();
  const queue = new MemoryQueueDownstream();
  const filter = new SpeechFilter({ ...readConfig({}), ...overrides }, evaluator, queue, () => {}, clock);
  filter.onConnection(true);
  return { filter, clock, queue };
}

test('default configuration matches the architecture and rejects unsupported provider/model and invalid thresholds', () => {
  const c = readConfig({});
  assert.deepEqual([c.everyNWords, c.debounceMs, c.directedThreshold, c.booleanThreshold, c.k, c.windowMaxWords, c.regionSilenceMs],
    [1, 1500, 0.6, 0.6, 8, 40, 1500]);
  for (const env of [{ STT_PROVIDER: 'other' }, { JEV_MODEL: 'other' }, { T_NOUL: 'NaN' }, { DEBOUNCE_MS: '999' }, { DEBUG_AUDIO: 'yes' }]) {
    assert.throws(() => readConfig(env));
  }
});

test('sliding candidates include the bounded region start, retained startIndex, and last 1..K words', () => {
  const words = event(Array.from({ length: 55 }, (_, i) => `w${i}`).join(' ')).words;
  const candidates = candidateWindows(words, 40, 0, 8, 40);
  assert.deepEqual(candidates.map(c => c.startIndex), [15, 40, 47, 48, 49, 50, 51, 52, 53, 54]);
  assert.ok(candidates.every(c => c.text.split(' ').length <= 40));
  assert.equal(candidateWindows(words, 40, 50, 8, 40)[0]?.startIndex, 50);
  assert.deepEqual(candidateWindows(words, null, 55, 8, 40), []);
});

test('gate requires both probabilities and a directed Choice, and rejects malformed batches', () => {
  const input: EvaluationInput = { regionId: 1, seq: 1, fullTranscript: 'request', candidates: [{ startIndex: 0, text: 'request' }] };
  const r = result(input);
  assert.equal(confidenceGate(r, input.candidates, 0.6, 0.6).kind, 'directed');
  for (const patch of [
    { directedProbability: 0.59 }, { isDirectedProbability: 0.59 }, { addressing: 'unclear' as const },
    { directedProbability: NaN }, { isDirectedProbability: 2 }, { startIndex: 999 },
  ]) {
    assert.equal(confidenceGate({ ...r, decisions: [{ ...r.decisions[0]!, ...patch }] }, input.candidates, 0.6, 0.6).kind, 'unclear');
  }
  assert.equal(confidenceGate({ ...r, decisions: [...r.decisions, ...r.decisions] }, input.candidates, 0.6, 0.6).kind, 'unclear');
  assert.equal(confidenceGate({ ...r, error: 'provider_error' }, input.candidates, 0.6, 0.6).kind, 'unclear');
});

test('mixed transcript emits only the earliest qualifying directed suffix after the full debounce', async () => {
  const { filter, clock, queue } = harness({ evaluate: async input => ({
    latencyMs: 10, decisions: input.candidates.map(c => ({
      startIndex: c.startIndex, addressing: c.startIndex >= 3 ? 'directed' : 'ambient',
      directedProbability: c.startIndex >= 3 ? 0.95 : 0.02,
      ambientProbability: c.startIndex >= 3 ? 0.02 : 0.95,
      isDirectedProbability: c.startIndex >= 3 ? 0.95 : 0.02,
    })),
  }) });
  filter.onTranscript(event('the television plays summarize my notes'));
  await settle();
  await clock.advance(1499); assert.equal(queue.segments.length, 0);
  await clock.advance(1);
  assert.equal(queue.segments[0]?.text, 'summarize my notes');
  assert.equal(queue.segments[0]?.startIndex, 3);
  await filter.stop();
});

test('a newer word invalidates an applied directed gate even when its evaluation fails', async () => {
  let calls = 0;
  const { filter, clock, queue } = harness({ evaluate: async input => ++calls === 1
    ? result(input) : { latencyMs: 10, decisions: [], error: 'gateway_http_503' } });
  filter.onTranscript(event('summarize'));
  await settle(); await clock.advance(500);
  filter.onTranscript(event('summarize television'));
  await settle(); await clock.advance(1500);
  assert.equal(queue.segments.length, 0);
  assert.equal(filter.counters.jev_errors, 1);
  await filter.stop();
});

test('coalesces newest input while cancellation settles, ignores stale replies, and waits at debounce', async () => {
  const calls: { input: EvaluationInput; signal: AbortSignal; resolve: (r: JevEvaluation) => void }[] = [];
  const { filter, clock, queue } = harness({ evaluate: (input, signal) => new Promise(resolve => calls.push({ input, signal, resolve })) });
  filter.onTranscript(event('please'));
  await settle();
  filter.onTranscript(event('please summarize'));
  filter.onTranscript(event('please summarize notes'));
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.signal.aborted, true);
  calls[0]!.resolve(result(calls[0]!.input)); await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.input.fullTranscript, 'please summarize notes');
  await clock.advance(2000); assert.equal(queue.segments.length, 0);
  calls[1]!.resolve(result(calls[1]!.input)); await settle();
  assert.deepEqual(queue.segments.map(s => s.text), ['please summarize notes']);
  assert.equal(filter.counters.jev_stale_ignored, 1);
  assert.ok(filter.counters.jev_inflight_dropped >= 2);
  await filter.stop();
});

test('finality-only updates do not reset debounce or duplicate Jev calls', async () => {
  let calls = 0;
  const { filter, clock, queue } = harness({ evaluate: async input => { calls++; return result(input); } });
  const original = event('summarize notes');
  filter.onTranscript(original); await settle(); await clock.advance(1000);
  filter.onTranscript({ ...original, isFinal: true, words: original.words.map(w => ({ ...w, isFinal: true })) });
  await clock.advance(500);
  assert.equal(calls, 1);
  assert.equal(queue.segments.length, 1);
  assert.equal(queue.segments[0]?.words.every(w => w.isFinal), true);
  await filter.stop();
});

test('profiling every three words evaluates residual words at the final quiet interval', async () => {
  let calls = 0;
  const { filter, clock, queue } = harness({ evaluate: async input => { calls++; return result(input); } }, { everyNWords: 3 });
  filter.onTranscript(event('summarize notes')); await settle();
  assert.equal(calls, 0);
  await clock.advance(1500);
  assert.equal(calls, 1);
  assert.equal(queue.segments[0]?.text, 'summarize notes');
  await filter.stop();
});

test('unclear holds without resetting the live region, ambient excludes previously heard words', async () => {
  const inputs: EvaluationInput[] = [];
  const { filter, clock, queue } = harness({ evaluate: async input => {
    inputs.push(input); return result(input, inputs.length === 1 ? 'ambient' : inputs.length === 2 ? 'unclear' : 'directed');
  } });
  filter.onTranscript(event('ambient chatter')); await settle(); await clock.advance(100);
  filter.onTranscript(event('ambient chatter could')); await settle(); await clock.advance(100);
  filter.onTranscript(event('ambient chatter could you help')); await settle(); await clock.advance(1500);
  assert.ok(inputs.every(i => i.regionId === inputs[0]?.regionId));
  assert.equal(inputs[2]?.candidates[0]?.startIndex, 2);
  assert.equal(queue.segments[0]?.text, 'could you help');
  await filter.stop();
});

test('synchronous evaluator exceptions fail closed and release the slot', async () => {
  const { filter, clock, queue } = harness({ evaluate: () => { throw new Error('transport failure'); } });
  filter.onTranscript(event('request')); await settle(); await clock.advance(1500);
  assert.equal(queue.segments.length, 0);
  assert.equal(filter.counters.jev_errors, 1);
  await filter.finish(); await filter.stop();
});
