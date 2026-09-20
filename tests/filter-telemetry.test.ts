import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../apps/speech-filter-harness/src/config.js';
import { MemoryQueueDownstream } from '../apps/speech-filter-harness/src/downstream/console.js';
import { SpeechFilter } from '../apps/speech-filter-harness/src/filter/controller.js';
import type { Clock } from '../apps/speech-filter-harness/src/filter/debounce.js';
import type { EvaluationInput, JevEvaluation, JevEvaluator } from '../apps/speech-filter-harness/src/jev/types.js';
import type { WordEvent } from '../apps/speech-filter-harness/src/stt/types.js';

async function settle(): Promise<void> {
  for (let turn = 0; turn < 15; turn++) await Promise.resolve();
}

class ManualClock implements Clock {
  private current = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.current; }
  setTimeout(callback: () => void, ms: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.current + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  async advance(ms: number): Promise<void> {
    const end = this.current + ms;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      this.current = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.current = end;
    await settle();
  }
}

function transcript(text: string): WordEvent {
  const parts = text.split(' ');
  return {
    text, startMs: 0, endMs: parts.length * 100, isFinal: false,
    words: parts.map((text, i) => ({ text, startMs: i * 100, endMs: (i + 1) * 100, isFinal: false })),
  };
}

function result(input: EvaluationInput, addressing: 'ambient' | 'directed'): JevEvaluation {
  return {
    latencyMs: 10,
    decisions: input.candidates.map(candidate => ({
      startIndex: candidate.startIndex, addressing,
      directedProbability: addressing === 'directed' ? 0.95 : 0.02,
      ambientProbability: addressing === 'ambient' ? 0.95 : 0.02,
      isDirectedProbability: addressing === 'directed' ? 0.97 : 0.02,
    })),
  };
}

function harness(evaluator: JevEvaluator) {
  const clock = new ManualClock();
  const queue = new MemoryQueueDownstream();
  const events: { name: string; fields: Record<string, unknown>; at: number }[] = [];
  const filter = new SpeechFilter(readConfig({}), evaluator, queue, (name, fields = {}) => {
    events.push({ name, fields, at: clock.now() });
  }, clock);
  filter.onConnection(true);
  const fields = (name: string) => events.filter(event => event.name === name).map(event => event.fields);
  const latest = (name: string) => {
    const value = fields(name).at(-1);
    assert.ok(value, `expected ${name}`);
    return value;
  };
  return { filter, clock, queue, events, fields, latest };
}

test('telemetry exposes ambient exclusion, fresh candidate spans, and the actual debounce fire', async () => {
  const inputs: EvaluationInput[] = [];
  const h = harness({ evaluate: async input => {
    inputs.push(input);
    return result(input, input.seq === 1 ? 'ambient' : 'directed');
  } });
  h.filter.onTranscript(transcript('room noise'));
  assert.equal(h.latest('filter_preview').decisionFresh, false);
  await settle();
  assert.deepEqual(h.latest('evaluation_requested'), inputs[0]);
  assert.equal(h.latest('jev_result').gate, 'ambient');
  assert.equal(h.latest('jev_result').excludedBefore, 2);
  assert.equal(h.latest('filter_preview').preview, '');

  await h.clock.advance(200);
  const next = transcript('room noise please summarize notes');
  h.filter.onTranscript(next);
  assert.equal(h.latest('filter_preview').decisionFresh, false);
  assert.equal(h.latest('filter_preview').gate, 'unclear');
  await settle();
  const decision = h.latest('jev_result');
  assert.equal(decision.startIndex, 2);
  assert.equal(decision.excludedBefore, 2);
  assert.deepEqual(decision.candidates, inputs[1]?.candidates);
  assert.equal(decision.fullTranscript, next.text);
  assert.equal(h.latest('filter_preview').decisionFresh, true);
  assert.deepEqual(h.latest('filter_preview').words, next.words);
  assert.equal(h.latest('filter_preview').preview, 'please summarize notes');
  assert.equal(h.latest('filter_preview').debounceDueAt, 1700);
  assert.equal(h.latest('filter_preview').debounceMs, 1500);
  assert.equal(h.latest('filter_preview').debounceReady, false);

  await h.clock.advance(1499);
  assert.equal(h.fields('debounce_fired').length, 0);
  assert.equal(h.queue.segments.length, 0);
  await h.clock.advance(1);
  assert.deepEqual(h.latest('debounce_fired'), { regionId: 1, seq: 2 });
  assert.equal(h.events.find(event => event.name === 'debounce_fired')?.at, 1700);
  assert.equal(h.latest('filter_preview').debounceReady, true);
  assert.equal(h.queue.segments[0]?.text, 'please summarize notes');
  await h.clock.advance(1500);
  assert.equal(h.fields('debounce_fired').length, 1);
  await h.filter.stop();
});

test('queued revisions are not reported as dispatched and stale results never become current previews', async () => {
  let release!: (result: JevEvaluation) => void;
  let firstInput!: EvaluationInput;
  let calls = 0;
  const h = harness({ evaluate: input => {
    calls++;
    if (calls === 1) {
      firstInput = input;
      return new Promise(resolve => { release = resolve; });
    }
    return Promise.resolve(result(input, 'directed'));
  } });
  h.filter.onTranscript(transcript('please'));
  await settle();
  h.filter.onTranscript(transcript('please summarize'));
  h.filter.onTranscript(transcript('please summarize notes'));
  await settle();
  assert.deepEqual(h.fields('evaluation_requested').map(value => value.seq), [1]);
  assert.equal(h.latest('filter_preview').seq, 3);
  assert.equal(h.latest('filter_preview').decisionFresh, false);
  release(result(firstInput, 'directed'));
  await settle();
  assert.deepEqual(h.fields('evaluation_requested').map(value => value.seq), [1, 3]);
  assert.deepEqual(h.fields('jev_result').map(value => value.seq), [3]);
  assert.equal(h.latest('jev_stale_ignored').seq, 1);
  assert.equal(h.latest('jev_inflight_dropped').count, 2);
  assert.equal(h.latest('filter_preview').decisionFresh, true);
  await h.filter.stop();
});

test('a revised directed span is revoked immediately and evaluator errors publish the held state', async () => {
  const h = harness({ evaluate: input => {
    if (input.seq > 1) throw new Error('transport failed');
    return Promise.resolve(result(input, 'directed'));
  } });
  h.filter.onTranscript(transcript('please summarize notes'));
  await settle();
  assert.equal(h.latest('filter_preview').preview, 'please summarize notes');
  await h.clock.advance(200);
  h.filter.onTranscript(transcript('please summarize no'));
  assert.equal(h.latest('filter_preview').startIndex, 0, 'retained boundary is only a candidate until reclassified');
  assert.equal(h.latest('filter_preview').gate, 'unclear');
  assert.equal(h.latest('filter_preview').decisionFresh, false);
  assert.equal(h.latest('filter_preview').preview, '');
  await settle();
  const errorIndex = h.events.findIndex(event => event.name === 'jev_error');
  assert.ok(errorIndex >= 0);
  assert.equal(h.events[errorIndex + 1]?.name, 'filter_preview');
  assert.equal(h.latest('filter_preview').decisionFresh, true);
  assert.equal(h.latest('filter_preview').gate, 'unclear');
  assert.equal(h.latest('filter_preview').preview, '');
  await h.clock.advance(1500);
  assert.equal(h.queue.segments.length, 0);
  await h.filter.stop();
});
