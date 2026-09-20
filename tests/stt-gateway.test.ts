import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { experimental_streamTranscribe as streamTranscribe } from 'ai';
import type { Experimental_TranscriptionModelV4StreamPart, TranscriptionModelV4 } from '@ai-sdk/provider';
import { GatewayStt, GatewayTranscriptNormalizer, GATEWAY_STT_SAMPLE_RATE } from '../apps/speech-filter-harness/src/stt/gateway.js';
import { DEFAULT_STT_MODEL, isGatewaySttModel, type GatewaySttModel } from '../apps/speech-filter-harness/src/stt/models.js';
import { WordAlignment } from '../apps/speech-filter-harness/src/stt/alignment.js';
import type { WordEvent } from '../apps/speech-filter-harness/src/stt/types.js';

function setup(model: GatewaySttModel = DEFAULT_STT_MODEL, timeouts = 1000) {
  const connections: boolean[] = [];
  const transcripts: WordEvent[] = [];
  const boundaries: number[] = [];
  const audio: Uint8Array[] = [];
  let source!: ReadableStreamDefaultController<Experimental_TranscriptionModelV4StreamPart>;
  let request!: Parameters<typeof streamTranscribe>[0];
  let audioReader: ReadableStreamDefaultReader<Uint8Array | string> | undefined;
  let canceled = false;
  const fakeModel: TranscriptionModelV4 = {
    specificationVersion: 'v4', provider: 'test', modelId: 'test',
    doGenerate: async () => { throw new Error('Unexpected nonstreaming request'); },
    doStream: async () => ({ stream: new ReadableStream({
      start: controller => { source = controller; },
      cancel: () => { canceled = true; },
    }) }),
  };
  const stt = new GatewayStt({
    apiKey: 'test-key-do-not-log', model, connectTimeoutMs: timeouts, finalizeTimeoutMs: timeouts,
    callbacks: {
      onConnection: value => connections.push(value),
      onTranscript: event => transcripts.push(event),
      onBoundary: (_reason, end) => boundaries.push(end!),
      log: () => {},
    },
    transcribe: options => { request = options; return streamTranscribe({ ...options, model: fakeModel }); },
  });
  function readAudio() {
    audioReader ??= request.audio.getReader();
    return audioReader.read().then(result => {
      if (!result.done && result.value instanceof Uint8Array) audio.push(result.value);
      return result;
    });
  }
  function part(value: Experimental_TranscriptionModelV4StreamPart) { source.enqueue(value); }
  function finish(text = 'Done.') {
    part({ type: 'finish', text, segments: [] });
    source.close();
  }
  return { stt, connections, transcripts, boundaries, audio, readAudio, part, finish,
    get request() { return request; }, get canceled() { return canceled; } };
}

test('STT model validation defaults to OpenAI and preserves the selected Gateway model ID', () => {
  assert.equal(DEFAULT_STT_MODEL, 'openai/gpt-realtime-whisper');
  assert.equal(isGatewaySttModel('openai/gpt-realtime-whisper'), true);
  assert.equal(isGatewaySttModel('xai/grok-stt'), true);
  assert.equal(isGatewaySttModel('spacexai/grok-stt'), false);
  assert.equal(isGatewaySttModel(undefined), false);
});

test('deltas accumulate, cumulative partials replace, and final revisions remove withdrawn words', () => {
  const normalizer = new GatewayTranscriptNormalizer();
  const alignment = new WordAlignment();
  const first = normalizer.apply({ type: 'transcript-delta', id: 'one', delta: 'Hello' }, 500)!;
  assert.equal(alignment.apply(first).text, 'Hello');
  const second = normalizer.apply({ type: 'transcript-delta', id: 'one', delta: ' there friend' }, 900)!;
  assert.deepEqual(second.words[0], first.words[0]);
  assert.equal(alignment.apply(second).text, 'Hello there friend');
  const partial = normalizer.apply({ type: 'transcript-partial', id: 'one', text: 'Hello there everyone' }, 1000)!;
  assert.equal(alignment.apply(partial).text, 'Hello there everyone');
  const final = normalizer.apply({ type: 'transcript-final', id: 'one', text: 'Hello there.' }, 1100)!;
  assert.equal(alignment.apply(final).text, 'Hello there.');
  assert.ok(final.words.every(word => word.isFinal && word.endMs > word.startMs));
  assert.equal(final.startMs, first.startMs);
  assert.ok(final.endMs >= partial.endMs);
  assert.equal(normalizer.apply({ type: 'transcript-final', id: 'one', text: 'Hello there.' }, 1200), undefined);
  assert.equal(normalizer.apply({ type: 'transcript-delta', id: 'one', delta: 'late' }, 1200), undefined);
  const next = normalizer.apply({ type: 'transcript-final', id: 'two', text: 'Next.' }, 1500)!;
  assert.ok(next.startMs >= final.endMs);
  assert.equal(alignment.apply(next).text, 'Hello there. Next.');
});

test('anonymous transcripts avoid duplicate finals without suppressing repeated later speech', () => {
  const normalizer = new GatewayTranscriptNormalizer();
  const part = { type: 'transcript-final', text: 'Yes.' } as const;
  assert.ok(normalizer.apply(part, 500));
  assert.equal(normalizer.apply(part, 500), undefined);
  assert.ok(normalizer.apply(part, 1000));
});

test('provider segment timings bound coarse words and invalid data cannot reach alignment', () => {
  const normalizer = new GatewayTranscriptNormalizer();
  const event = normalizer.apply({ type: 'transcript-final', text: 'Hello world.', startSecond: 2, endSecond: 3 }, 5000)!;
  assert.equal(event.startMs, 2000);
  assert.equal(event.endMs, 3000);
  assert.deepEqual(event.words.map(word => [word.startMs, word.endMs]), [[2000, 2500], [2500, 3000]]);
  assert.throws(() => normalizer.apply({ type: 'transcript-partial', text: 'bad', startSecond: -1 }, 5100));
  assert.throws(() => normalizer.apply({ type: 'transcript-final', text: 'bad', startSecond: 4, endSecond: 3 }, 5100));
});

test('both models use streamed 24k PCM; readiness waits for the actual audio reader', async t => {
  for (const model of ['openai/gpt-realtime-whisper', 'xai/grok-stt'] as const) {
    const h = setup(model);
    t.after(() => h.stt.close());
    const ready = h.stt.connect();
    assert.equal(h.stt.connected, false);
    assert.equal(h.stt.sendAudio(Buffer.alloc(960)), false);
    assert.deepEqual(h.request.inputAudioFormat, { type: 'audio/pcm', rate: GATEWAY_STT_SAMPLE_RATE });
    assert.equal(typeof h.request.model === 'string' ? h.request.model : h.request.model.modelId, model);
    const read = h.readAudio();
    await ready;
    assert.deepEqual(h.connections, [false, true]);
    const frame = Buffer.alloc(960, 2);
    assert.equal(h.stt.sendAudio(frame), true);
    frame.fill(9);
    await read;
    assert.equal(h.audio[0]![0], 2);
    h.part({ type: 'transcript-delta', id: 'one', delta: 'Hello' });
    h.part({ type: 'transcript-final', id: 'one', text: 'Hello.' });
    await delay(0);
    assert.deepEqual(h.transcripts.map(event => event.text), ['Hello', 'Hello.']);
    assert.equal(h.boundaries.length, 1);
    await h.stt.close();
    assert.equal(h.request.abortSignal?.aborted, true);
  }
});

test('finalize closes audio, drains the final result, and preserves the filter connection until close', async () => {
  const h = setup();
  const ready = h.stt.connect();
  const read = h.readAudio();
  await ready;
  h.stt.sendAudio(Buffer.alloc(24_000));
  await read;
  const audioEnd = h.readAudio();
  const finalized = h.stt.finalize();
  assert.equal((await audioEnd).done, true);
  assert.equal(h.stt.sendAudio(Buffer.alloc(960)), false);
  h.part({ type: 'transcript-final', text: 'Done.' });
  h.finish();
  await finalized;
  await h.stt.done;
  assert.equal(h.transcripts[0]?.text, 'Done.');
  assert.equal(h.stt.connected, true);
  await h.stt.close();
  assert.deepEqual(h.connections, [false, true, false]);
});

test('audio backlog fails closed and rejects done without replaying stale audio', async t => {
  const h = setup();
  t.after(() => h.stt.close());
  const ready = h.stt.connect();
  const read = h.readAudio();
  await ready;
  h.stt.sendAudio(Buffer.alloc(960));
  await read;
  assert.equal(h.stt.sendAudio(Buffer.alloc(48_000)), true);
  assert.equal(h.stt.sendAudio(Buffer.alloc(960)), false);
  assert.equal(h.stt.connected, false);
  assert.equal(h.audio.length, 1);
  await assert.rejects(h.stt.done, /backpressure/);
  assert.equal(h.request.abortSignal?.aborted, true);
});

test('startup and streaming provider failures reject lifecycle and never expose the key', async t => {
  const startup = setup();
  t.after(() => startup.stt.close());
  const ready = startup.stt.connect();
  startup.part({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized test-key-do-not-log dGVzdC1rZXktZG8tbm90LWxvZw==' } });
  await assert.rejects(ready, error => error instanceof Error && error.message ===
    'Gateway STT (openai/gpt-realtime-whisper): Authentication failed; check AI_GATEWAY_API_KEY.');
  await assert.rejects(startup.stt.done, /Authentication failed/);
  assert.equal(startup.stt.connected, false);

  const ongoing = setup();
  t.after(() => ongoing.stt.close());
  const connected = ongoing.stt.connect();
  const read = ongoing.readAudio();
  await connected;
  ongoing.stt.sendAudio(Buffer.alloc(960));
  await read;
  ongoing.part({ type: 'error', error: new Error('Provider failed') });
  await assert.rejects(ongoing.stt.done, /Provider stream failed/);
  assert.deepEqual(ongoing.connections, [false, true, false]);
});

test('shutdown cancels pending startup and finalization has a finite timeout', async () => {
  const startup = setup();
  const connecting = startup.stt.connect();
  await startup.stt.close();
  await assert.rejects(connecting, /stopped/);
  await startup.stt.done;
  assert.equal(startup.request.abortSignal?.aborted, true);

  const ongoing = setup(DEFAULT_STT_MODEL, 25);
  const ready = ongoing.stt.connect();
  const read = ongoing.readAudio();
  await ready;
  const finalized = ongoing.stt.finalize();
  assert.equal((await read).done, true);
  await assert.rejects(finalized, /finalization timed out/);
  await assert.rejects(ongoing.stt.done, /finalization timed out/);
  await ongoing.stt.close();
});

test('silent audio can finish without a transcript and unexpected live EOF is an error', async () => {
  const silent = setup();
  const ready = silent.stt.connect();
  const read = silent.readAudio();
  await ready;
  silent.part({ type: 'transcript-partial', text: '' });
  const finalized = silent.stt.finalize();
  await read;
  silent.finish('');
  await finalized;
  await silent.stt.done;
  await silent.stt.close();

  const early = setup();
  const connected = early.stt.connect();
  const audio = early.readAudio();
  await connected;
  early.stt.sendAudio(Buffer.alloc(960));
  await audio;
  early.finish();
  await assert.rejects(early.stt.done, /ended before audio/);
  await early.stt.close();
});

test('finalize drains already accepted queued PCM before ending audio', async () => {
  const h = setup();
  const ready = h.stt.connect();
  const first = h.readAudio();
  await ready;
  h.stt.sendAudio(Buffer.alloc(960, 1));
  await first;
  h.stt.sendAudio(Buffer.alloc(960, 2));
  h.stt.sendAudio(Buffer.alloc(960, 3));
  const finalized = h.stt.finalize();
  assert.equal((await h.readAudio()).done, false);
  assert.equal((await h.readAudio()).done, false);
  assert.equal((await h.readAudio()).done, true);
  assert.deepEqual(h.audio.map(chunk => chunk[0]), [1, 2, 3]);
  h.finish();
  await finalized;
  await h.stt.close();
});

test('connection timeout and malformed transcript timing fail closed', async () => {
  const timeout = setup(DEFAULT_STT_MODEL, 20);
  await assert.rejects(timeout.stt.connect(), /connection timed out/);
  await assert.rejects(timeout.stt.done, /connection timed out/);
  await timeout.stt.close();

  const malformed = setup();
  const ready = malformed.stt.connect();
  const read = malformed.readAudio();
  await ready;
  malformed.stt.sendAudio(Buffer.alloc(960));
  await read;
  malformed.part({ type: 'transcript-partial', text: 'Unsafe timing', startSecond: -5 });
  await assert.rejects(malformed.stt.done, /malformed/);
  assert.equal(malformed.stt.stats.malformedEvents, 1);
  assert.equal(malformed.stt.connected, false);
  assert.equal(malformed.transcripts.length, 0);
  await malformed.stt.close();
});

test('finalizing during startup settles pending connect without hanging', async () => {
  const h = setup();
  const ready = h.stt.connect();
  await h.stt.finalize();
  await assert.rejects(ready, /stopped/);
  await h.stt.done;
  assert.equal(h.request.abortSignal?.aborted, true);
});
