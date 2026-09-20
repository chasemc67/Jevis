import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TranscriptionStreamPart } from 'ai';
import { GatewayStt } from '../apps/speech-filter-harness/src/stt/gateway.js';
import type { SttCallbacks } from '../apps/speech-filter-harness/src/stt/types.js';
import { SttSession } from '../apps/speech-filter-harness/src/stt/session.js';
import { SpeechFilter } from '../apps/speech-filter-harness/src/filter/controller.js';
import { readConfig } from '../apps/speech-filter-harness/src/config.js';
import { MemoryQueueDownstream } from '../apps/speech-filter-harness/src/downstream/console.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); }
  assert.fail('Timed out waiting for lifecycle event');
}

function provider() {
  const streams: { output: ReadableStreamDefaultController<TranscriptionStreamPart>; audio: Buffer[]; signal: AbortSignal }[] = [];
  const transcribe: NonNullable<ConstructorParameters<typeof GatewayStt>[0]['transcribe']> = options => {
    const stream = { output: undefined as unknown as ReadableStreamDefaultController<TranscriptionStreamPart>, audio: [] as Buffer[], signal: options.abortSignal! };
    streams.push(stream);
    const reader = options.audio.getReader();
    void (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stream.audio.push(Buffer.from(chunk.value));
      }
    })();
    return { fullStream: new ReadableStream<TranscriptionStreamPart>({ start(controller) { stream.output = controller; } }) as ReturnType<typeof transcribe>['fullStream'] };
  };
  return { streams, transcribe };
}

const emptyCallbacks: SttCallbacks = { onConnection() {}, onTranscript() {}, onBoundary() {}, log() {} };

test('one mic session submits three turns across normal Gateway EOFs without losing pending debounce', async t => {
  const queue = new MemoryQueueDownstream();
  const filter = new SpeechFilter({ ...readConfig({}), debounceMs: 50 }, {
    evaluate: async input => ({ latencyMs: 0, decisions: input.candidates.map(candidate => ({
      startIndex: candidate.startIndex, addressing: 'directed', directedProbability: 0.99,
      ambientProbability: 0.01, isDirectedProbability: 0.99,
    })) }),
  }, queue, () => {});
  const fake = provider();
  const session = new SttSession({
    onConnection: value => filter.onConnection(value), onTranscript: event => filter.onTranscript(event),
    onBoundary: (reason, end) => filter.onBoundary(reason, end), log() {},
  }, (model, callbacks) => new GatewayStt({ apiKey: 'test', model, callbacks, continuous: true, reconnectDelayMs: 5, transcribe: fake.transcribe }));
  t.after(async () => { await session.close(); await filter.stop(); });
  let ended = false;
  void session.done.then(() => { ended = true; });
  await session.setModel('openai/gpt-realtime-whisper');
  for (let turn = 0; turn < 3; turn++) {
    assert.equal(session.sendAudio(Buffer.alloc(960, turn + 1)), true);
    const stream = fake.streams[turn]!;
    await until(() => stream.audio.length === 1);
    // Provider IDs and timestamps repeat on each new connection.
    stream.output.enqueue({ type: 'transcript-final', id: 'one', text: `Request ${turn + 1}`, startSecond: 0, endSecond: 0.02 });
    stream.output.close();
    await until(() => fake.streams.length === turn + 2 && queue.segments.length === turn + 1);
    assert.equal(ended, false, 'provider EOF cannot complete the mic supervisor');
  }
  assert.deepEqual(queue.segments.map(segment => segment.text), ['Request 1', 'Request 2', 'Request 3']);
  assert.equal(new Set(queue.segments.map(segment => segment.regionId)).size, 3);
  assert.equal(session.stats.reconnects, 3);
  await session.close();
  await session.done;
  assert.equal(ended, true);
});

test('transient failures reconnect without stale PCM; auth failure ends even during continuous capture', async t => {
  const fake = provider();
  const connections: boolean[] = [];
  const stt = new GatewayStt({ apiKey: 'test', callbacks: { ...emptyCallbacks, onConnection: connected => connections.push(connected) },
    continuous: true, reconnectDelayMs: 15, transcribe: fake.transcribe });
  t.after(() => stt.close());
  await stt.connect();
  fake.streams[0]!.output.enqueue({ type: 'transcript-partial', text: 'Unfinished request' });
  fake.streams[0]!.output.enqueue({ type: 'error', error: { statusCode: 503 } });
  await until(() => stt.stats.reconnects === 1);
  assert.equal(stt.sendAudio(Buffer.alloc(960, 99)), false);
  await until(() => fake.streams.length === 2 && stt.connected);
  assert.deepEqual(fake.streams[1]!.audio, []);
  assert.deepEqual(connections, [false, true, false, true]);
  fake.streams[1]!.output.enqueue({ type: 'error', error: { statusCode: 401 } });
  await assert.rejects(stt.done, /Authentication failed/);
  assert.equal(stt.stats.reconnects, 1);
  assert.equal(connections.at(-1), false);
});

test('fatal failure after clean EOF invalidates pending filter work and close cancels backoff', async () => {
  const fake = provider();
  const connections: boolean[] = [];
  const stt = new GatewayStt({ apiKey: 'test', continuous: true, reconnectDelayMs: 5,
    callbacks: { ...emptyCallbacks, onConnection: value => connections.push(value) },
    transcribe: options => {
      if (fake.streams.length) throw { statusCode: 403 };
      return fake.transcribe(options);
    },
  });
  await stt.connect();
  fake.streams[0]!.output.close();
  await assert.rejects(stt.done, /Access denied/);
  assert.deepEqual(connections, [false, true, false]);
  await stt.close();

  const stopped = provider();
  const second = new GatewayStt({ apiKey: 'test', continuous: true, reconnectDelayMs: 25, callbacks: emptyCallbacks, transcribe: stopped.transcribe });
  await second.connect();
  stopped.streams[0]!.output.close();
  await until(() => second.stats.reconnects === 1);
  await second.close();
  await second.done;
  await delay(40);
  assert.equal(stopped.streams.length, 1);
});

test('model switch during reconnect retires the timer and keeps mic session alive', async () => {
  const fake = provider();
  const session = new SttSession(emptyCallbacks, (model, callbacks) => new GatewayStt({
    apiKey: 'test', model, callbacks, continuous: true, reconnectDelayMs: 30, transcribe: fake.transcribe,
  }));
  await session.setModel('openai/gpt-realtime-whisper');
  fake.streams[0]!.output.close();
  await until(() => session.stats.reconnects === 1);
  await session.setModel('xai/grok-stt');
  await delay(45);
  assert.equal(fake.streams.length, 2);
  assert.equal(fake.streams[0]!.signal.aborted, true);
  assert.equal(session.sendAudio(Buffer.alloc(960)), true);
  await session.close();
});
