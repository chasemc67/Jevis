import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket, { type ClientOptions } from 'ws';
import { DeepgramStt, deepgramUrl, normalizeDeepgramResult, reconnectDelayMs } from '../apps/speech-filter-harness/src/stt/deepgram.js';
import type { WordEvent } from '../apps/speech-filter-harness/src/stt/types.js';

function result(text = 'Hello,', start = 0, speechFinal = false): Record<string, unknown> {
  return { type: 'Results', start, duration: 0.5, is_final: speechFinal, speech_final: speechFinal,
    channel: { alternatives: [{ transcript: text, words: text ? [{ word: text.toLowerCase(), punctuated_word: text, start, end: start + 0.5 }] : [] }] } };
}

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: (Buffer | string)[] = [];
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open'); }
  message(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  send(data: Buffer | string, _options: unknown, callback: (error?: Error) => void): void {
    this.sent.push(data);
    callback();
    if (typeof data === 'string' && JSON.parse(data).type === 'CloseStream') this.terminate();
  }
  terminate(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', 1000));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const connections: boolean[] = [];
  const transcripts: WordEvent[] = [];
  const boundaries: { reason: string; endMs?: number }[] = [];
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const requests: { url: string; options: ClientOptions }[] = [];
  const stt = new DeepgramStt({
    apiKey: 'test-key-never-live',
    callbacks: {
      onTranscript: event => transcripts.push(event),
      onBoundary: (reason, endMs) => boundaries.push({ reason, endMs }),
      onConnection: connected => connections.push(connected),
      log: (event, fields) => logs.push({ event, fields }),
    },
    createSocket: (url, options) => {
      requests.push({ url, options });
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { stt, sockets, connections, transcripts, boundaries, logs, requests };
}

test('Nova-3 URL uses every concrete architecture parameter and capped backoff', () => {
  const url = new URL(deepgramUrl());
  assert.equal(url.origin + url.pathname, 'wss://api.deepgram.com/v1/listen');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    model: 'nova-3', interim_results: 'true', smart_format: 'true', encoding: 'linear16',
    channels: '1', sample_rate: '16000', language: 'en-US', endpointing: '300',
    utterance_end_ms: '1000', vad_events: 'true',
  });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(reconnectDelayMs), [250, 500, 1000, 2000, 4000, 4000, 4000]);
});

test('normalization converts seconds to milliseconds and rejects malformed timed words', () => {
  assert.deepEqual(normalizeDeepgramResult(result('Hello,', 1.25, true)).words,
    [{ text: 'Hello,', startMs: 1250, endMs: 1750, isFinal: true }]);
  const invalid = result();
  invalid.duration = -1;
  assert.throws(() => normalizeDeepgramResult(invalid));
  assert.throws(() => normalizeDeepgramResult({ ...result(), channel: { alternatives: [{ transcript: 'untimed', words: [] }] } }));
  assert.throws(() => normalizeDeepgramResult({ ...result(), is_final: 'true' }));
});

test('audio drops during outage; reconnect resets clocks and never replays old frames', async t => {
  const harness = setup();
  t.after(() => harness.stt.close());
  const connected = harness.stt.connect();
  assert.equal(harness.stt.sendAudio(Buffer.from([1, 2])), false);
  const first = harness.sockets[0]!;
  first.open();
  await connected;
  assert.deepEqual(harness.connections, [false, true]);
  assert.equal(harness.requests[0]!.options.headers?.Authorization, 'Token test-key-never-live');
  assert.equal(harness.stt.sendAudio(Buffer.from([3, 4])), true);
  assert.equal(first.sent.length, 1);
  first.message(result('First.', 1, true));
  first.terminate();
  await delay(10);
  assert.equal(harness.stt.connected, false);
  assert.equal(harness.stt.sendAudio(Buffer.from([5, 6])), false);
  await delay(270);
  const second = harness.sockets[1]!;
  assert.ok(second);
  second.open();
  assert.equal(second.sent.length, 0);
  second.message(result('New.', 0, true));
  assert.deepEqual(harness.boundaries.map(boundary => boundary.endMs), [1500, 500]);
  assert.equal(harness.stt.stats.droppedAudioFrames, 2);
  assert.equal(harness.logs.find(log => log.event === 'stt_reconnect_scheduled')?.fields?.delayMs, 250);
});

test('duplicate and delayed UtteranceEnd cannot reset a newer speech region', async t => {
  const harness = setup();
  t.after(() => harness.stt.close());
  const ready = harness.stt.connect();
  const socket = harness.sockets[0]!;
  socket.open();
  await ready;
  socket.message(result('One.', 0, true));
  socket.message({ type: 'UtteranceEnd', last_word_end: 0.5 });
  socket.message(result('Two', 1));
  socket.message({ type: 'UtteranceEnd', last_word_end: 0.5 });
  assert.equal(harness.boundaries.length, 1);
  socket.message({ type: 'UtteranceEnd', last_word_end: 1.5 });
  assert.equal(harness.boundaries.length, 2);
});

test('malformed vendor data and socket backlog immediately invalidate connected state', async t => {
  const harness = setup();
  t.after(() => harness.stt.close());
  const ready = harness.stt.connect();
  const socket = harness.sockets[0]!;
  socket.open();
  await ready;
  socket.message({ type: 'Results', channel: {} });
  assert.equal(harness.stt.connected, false);
  assert.equal(harness.transcripts.length, 0);
  assert.equal(harness.stt.stats.malformedEvents, 1);
  assert.deepEqual(harness.connections, [false, true, false]);
});

test('network backlog resets the gate rather than creating a spliced utterance', async t => {
  const harness = setup();
  t.after(() => harness.stt.close());
  const ready = harness.stt.connect();
  const socket = harness.sockets[0]!;
  socket.open();
  await ready;
  socket.bufferedAmount = 32_001;
  assert.equal(harness.stt.sendAudio(Buffer.alloc(640)), false);
  assert.equal(harness.stt.connected, false);
  assert.equal(socket.sent.length, 0);
});

test('Finalize flushes results before CloseStream shuts down', async () => {
  const harness = setup();
  const ready = harness.stt.connect();
  const socket = harness.sockets[0]!;
  socket.open();
  await ready;
  const finalized = harness.stt.finalize();
  assert.deepEqual(JSON.parse(socket.sent[0] as string), { type: 'Finalize' });
  socket.message({ ...result('Done.', 0, true), from_finalize: true });
  await finalized;
  assert.equal(harness.transcripts[0]?.text, 'Done.');
  assert.equal(harness.stt.connected, true);
  await harness.stt.close();
  assert.deepEqual(JSON.parse(socket.sent[1] as string), { type: 'CloseStream' });
  assert.equal(harness.stt.connected, false);
});

test('terminal authentication errors reject startup and the ongoing lifecycle', async t => {
  const startup = setup();
  t.after(() => startup.stt.close());
  const connecting = startup.stt.connect();
  startup.sockets[0]!.emit('unexpected-response', {}, { statusCode: 401, resume() {} });
  await assert.rejects(connecting, /authentication failed.*401/);
  await assert.rejects(startup.stt.done, /DEEPGRAM_API_KEY/);

  const ongoing = setup();
  t.after(() => ongoing.stt.close());
  const ready = ongoing.stt.connect();
  ongoing.sockets[0]!.open();
  await ready;
  ongoing.sockets[0]!.terminate();
  await delay(280);
  assert.ok(ongoing.sockets[1]);
  ongoing.sockets[1]!.emit('unexpected-response', {}, { statusCode: 403, resume() {} });
  await assert.rejects(ongoing.stt.done, /authentication failed.*403/);
  assert.equal(ongoing.stt.connected, false);
});
