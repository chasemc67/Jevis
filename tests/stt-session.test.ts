import assert from 'node:assert/strict';
import test from 'node:test';
import { SttSession, type SttAdapter } from '../apps/speech-filter-harness/src/stt/session.js';
import type { SttCallbacks } from '../apps/speech-filter-harness/src/stt/types.js';

test('model switch closes the old stream, discards late callbacks, and retains the session', async () => {
  const connections: boolean[] = [];
  const transcripts: string[] = [];
  const order: string[] = [];
  const callbacks: SttCallbacks = {
    onConnection: value => connections.push(value), onBoundary: () => {},
    onTranscript: event => transcripts.push(event.text), log: () => {},
  };
  const adapters: { callbacks: SttCallbacks; fail: (error: Error) => void }[] = [];
  const session = new SttSession(callbacks, (model, events): SttAdapter => {
    let fail!: (error: Error) => void;
    const done = new Promise<void>((_resolve, reject) => { fail = reject; });
    adapters.push({ callbacks: events, fail });
    return {
      done, stats: { droppedAudioFrames: 0, reconnects: 0, malformedEvents: 0 },
      connect: async () => { order.push(`open:${model}`); events.onConnection(true); },
      sendAudio: () => true, finalize: async () => {},
      close: async () => { order.push(`close:${model}`); events.onConnection(false); },
    };
  });
  await session.setModel('openai/gpt-realtime-whisper');
  await session.setModel('xai/grok-stt');
  assert.deepEqual(order, ['open:openai/gpt-realtime-whisper', 'close:openai/gpt-realtime-whisper', 'open:xai/grok-stt']);
  const event = { text: 'late', words: [], startMs: 0, endMs: 1, isFinal: true };
  adapters[0]!.callbacks.onTranscript(event);
  adapters[0]!.callbacks.onConnection(false);
  adapters[0]!.fail(new Error('late failure from retired adapter'));
  adapters[1]!.callbacks.onTranscript({ ...event, text: 'current' });
  assert.deepEqual(transcripts, ['current']);
  assert.equal(connections.at(-1), true);
  assert.equal(session.sendAudio(Buffer.alloc(960)), true);
  await session.close();
  await session.done;
  assert.equal(connections.at(-1), false);
});

test('stop during model connection cancels promptly and prevents queued model changes', async () => {
  let opens = 0;
  let cancelConnect!: () => void;
  const session = new SttSession({ onConnection: () => {}, onBoundary: () => {}, onTranscript: () => {}, log: () => {} }, () => ({
    done: new Promise(() => {}), stats: { droppedAudioFrames: 0, reconnects: 0, malformedEvents: 0 },
    connect: () => { opens++; return new Promise<void>(resolve => { cancelConnect = resolve; }); },
    close: async () => cancelConnect(), sendAudio: () => true, finalize: async () => {},
  }));
  const initial = session.setModel('openai/gpt-realtime-whisper');
  const queued = session.setModel('xai/grok-stt');
  const rejected = assert.rejects(queued, /stopped/);
  await new Promise(resolve => setImmediate(resolve));
  await session.close();
  await initial;
  await rejected;
  await session.done;
  assert.equal(opens, 1);
  assert.equal(session.sendAudio(Buffer.alloc(960)), false);
});

test('a replacement connection failure reaches the capture supervisor', async () => {
  let opens = 0;
  const session = new SttSession({ onConnection: () => {}, onBoundary: () => {}, onTranscript: () => {}, log: () => {} }, () => ({
    done: new Promise(() => {}), stats: { droppedAudioFrames: 0, reconnects: 0, malformedEvents: 0 },
    connect: async () => { if (++opens === 2) throw new Error('connection failed'); },
    close: async () => {}, sendAudio: () => true, finalize: async () => {},
  }));
  await session.setModel('openai/gpt-realtime-whisper');
  await assert.rejects(session.setModel('xai/grok-stt'), /connection failed/);
  await assert.rejects(session.done, /connection failed/);
  await session.close();
});
