import assert from 'node:assert/strict';
import test from 'node:test';
import type { FilterConfig } from '../apps/speech-filter-harness/src/config.js';
import type { FilteredSegment } from '../apps/speech-filter-harness/src/downstream/types.js';
import { SpeechFilter } from '../apps/speech-filter-harness/src/filter/controller.js';
import type { Clock } from '../apps/speech-filter-harness/src/filter/debounce.js';
import type { EvaluationInput, JevEvaluation, JevEvaluator } from '../apps/speech-filter-harness/src/jev/types.js';
import type { WordEvent } from '../apps/speech-filter-harness/src/stt/types.js';

class TestClock implements Clock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { time: number; callback: () => void }>();
  now(): number { return this.current; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { time: this.current + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  async advance(ms: number): Promise<void> {
    const end = this.current + ms;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].time - b[1].time || a[0] - b[0])[0];
      if (!next || next[1].time > end) break;
      this.current = next[1].time;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.current = end;
    await settle();
  }
}

const config: FilterConfig = {
  everyNWords: 1, debounceMs: 1500, directedThreshold: 0.6,
  booleanThreshold: 0.6, k: 8, windowMaxWords: 40, regionSilenceMs: 1500,
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

function words(text: string, startMs: number): WordEvent {
  const tokens = text.split(' ');
  return {
    text, startMs, endMs: startMs + tokens.length * 100, isFinal: false,
    words: tokens.map((text, index) => ({ text, startMs: startMs + index * 100, endMs: startMs + (index + 1) * 100, isFinal: false })),
  };
}

function directed(input: EvaluationInput): JevEvaluation {
  return {
    latencyMs: 0,
    decisions: input.candidates.map(candidate => ({
      startIndex: candidate.startIndex, addressing: 'directed', directedProbability: 0.98,
      ambientProbability: 0.01, isDirectedProbability: 0.99,
    })),
  };
}

const immediate: JevEvaluator = { evaluate: async input => directed(input) };

test('a queued segment from a disconnected session stays invalid after reconnect', async () => {
  const clock = new TestClock();
  const submitted: FilteredSegment[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const filter = new SpeechFilter(config, immediate, {
    submit: async segment => {
      submitted.push(segment);
      if (submitted.length === 1) await blocked;
    },
  }, () => {}, clock);
  filter.onConnection(true);
  filter.onTranscript(words('first request', 0));
  await settle();
  await clock.advance(1500);
  assert.equal(submitted.length, 1);
  filter.onTranscript(words('second request', 2000));
  await settle();
  await clock.advance(1500);
  assert.equal(submitted.length, 1, 'second segment waits for downstream');
  filter.onConnection(false);
  filter.onConnection(true);
  release();
  await settle();
  assert.deepEqual(submitted.map(segment => segment.text), ['first request']);
  await filter.stop();
});

test('endpoint at 300ms seals its own region but preserves the 1500ms debounce exactly once', async () => {
  const clock = new TestClock();
  const submitted: FilteredSegment[] = [];
  const filter = new SpeechFilter(config, immediate, { submit: async segment => { submitted.push(segment); } }, () => {}, clock);
  filter.onConnection(true);
  const event = words('summarize my notes', 0);
  filter.onTranscript(event);
  await settle();
  await clock.advance(300);
  filter.onBoundary('speech_final');
  filter.onTranscript({ ...event, isFinal: true, words: event.words.map(word => ({ ...word, isFinal: true })) });
  await clock.advance(1199);
  assert.equal(submitted.length, 0);
  await clock.advance(1);
  assert.deepEqual(submitted.map(segment => segment.text), ['summarize my notes']);
  await clock.advance(5000);
  assert.equal(submitted.length, 1);
  await filter.stop();
});

test('late uncancellable evaluate from before disconnect cannot affect the next session', async () => {
  const clock = new TestClock();
  const submitted: FilteredSegment[] = [];
  let resolveFirst!: (result: JevEvaluation) => void;
  let firstInput!: EvaluationInput;
  let calls = 0;
  const evaluator: JevEvaluator = {
    evaluate: input => {
      calls += 1;
      if (calls === 1) {
        firstInput = input;
        return new Promise(resolve => { resolveFirst = resolve; });
      }
      return Promise.resolve({ decisions: input.candidates.map(candidate => ({
        startIndex: candidate.startIndex, addressing: 'ambient', directedProbability: 0.01,
        ambientProbability: 0.98, isDirectedProbability: 0.01,
      })), latencyMs: 0 });
    },
  };
  const filter = new SpeechFilter(config, evaluator, { submit: async segment => { submitted.push(segment); } }, () => {}, clock);
  filter.onConnection(true);
  filter.onTranscript(words('old request', 0));
  await settle();
  filter.onConnection(false);
  filter.onConnection(true);
  filter.onTranscript(words('ambient conversation', 0));
  assert.equal(calls, 1, 'uncancellable old transport retains the single evaluate slot');
  resolveFirst(directed(firstInput));
  await settle();
  assert.equal(calls, 2);
  await clock.advance(1500);
  assert.equal(submitted.length, 0);
  assert.equal(filter.counters.jev_stale_ignored, 1);
  await filter.stop();
});

test('recognizer insertion before a submitted span cannot move submitted words into a new candidate', async () => {
  const clock = new TestClock();
  const submitted: FilteredSegment[] = [];
  const filter = new SpeechFilter({ ...config, debounceMs: 1000 }, immediate,
    { submit: async segment => { submitted.push(segment); } }, () => {}, clock);
  filter.onConnection(true);
  filter.onTranscript(words('please summarize notes', 0));
  await settle();
  await clock.advance(1000);
  assert.deepEqual(submitted.map(segment => segment.text), ['please summarize notes']);
  // A delayed STT correction inserts a word before already-emitted audio. Keep
  // the original notes timing so a time watermark can still identify it.
  filter.onTranscript({
    text: 'please summarize my notes then email them', startMs: 0, endMs: 600, isFinal: false,
    words: [
      { text: 'please', startMs: 0, endMs: 100, isFinal: false },
      { text: 'summarize', startMs: 100, endMs: 170, isFinal: false },
      { text: 'my', startMs: 170, endMs: 200, isFinal: false },
      { text: 'notes', startMs: 200, endMs: 300, isFinal: false },
      { text: 'then', startMs: 300, endMs: 400, isFinal: false },
      { text: 'email', startMs: 400, endMs: 500, isFinal: false },
      { text: 'them', startMs: 500, endMs: 600, isFinal: false },
    ],
  });
  await settle();
  await clock.advance(1000);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1]?.text, 'then email them');
  assert.ok(submitted[1]?.words.every(word => word.startMs >= 300));
  await filter.stop();
});
