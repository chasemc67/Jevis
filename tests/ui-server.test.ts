import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';

async function startMic(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/audio', { origin: url });
  await once(socket, 'open');
  return socket;
}
import { startUiServer } from '../apps/speech-filter-harness/src/ui/server.js';

interface UiRecord { event: string; [key: string]: unknown }

const selectModel = (url: string, model: string) => fetch(`${url}/api/stt-model`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
});

async function snapshot(url: string, state: string): Promise<{ records: UiRecord[]; bytes: number }> {
  const response = await fetch(`${url}/events`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const records: UiRecord[] = [];
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE closed before the complete replay reached the client');
      bytes += chunk.value!.byteLength;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith('data: ')) continue;
        const record = JSON.parse(frame.slice(6)) as UiRecord;
        records.push(record);
        if (record.event === 'ui_status' && record.state === state) return { records, bytes };
      }
    }
  } finally { await reader.cancel(); }
}

test('large SSE reconnect snapshots drain fully and preserve older submits without duplicates', async t => {
  const ui = await startUiServer({
    port: 0, mode: 'fixture', classifier: 'SCRIPTED_FIXTURE_MOCK', log: () => {},
    run: async (_signal, log) => {
      log('harness_started', { mode: 'fixture', classifier: 'SCRIPTED_FIXTURE_MOCK' });
      log('queue_submit', { id: 'early', text: 'the first directed request' });
      for (let seq = 0; seq < 2200; seq++) {
        log('evaluation_requested', { regionId: 1, seq, fullTranscript: 'word '.repeat(120) });
      }
      log('queue_submit', { id: 'last', text: 'the last directed request' });
      log('fixture_completed');
    },
  });
  t.after(() => ui.close());
  assert.equal((await fetch(`${ui.url}/api/run`, { method: 'POST' })).status, 202);
  for (let connection = 0; connection < 2; connection++) {
    const replay = await snapshot(ui.url, 'completed');
    assert.ok(replay.bytes > 64 * 1024, 'exercise response backpressure during an ordinary replay');
    assert.equal(replay.records[0]?.event, 'ui_reset');
    assert.equal(replay.records.filter(record => record.event === 'harness_started').length, 1);
    assert.deepEqual(replay.records.filter(record => record.event === 'queue_submit').map(record => record.id), ['early', 'last']);
    const sequences = replay.records.filter(record => record.event === 'evaluation_requested').map(record => record.seq as number);
    assert.ok(sequences[0]! > 0, 'ordinary history is bounded even while old chat submits survive');
    assert.equal(sequences.at(-1), 2199);
    assert.equal(new Set(sequences).size, sequences.length);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  }
});

test('failed UI runs expose safe errors and release the run slot for replay and stop', async t => {
  let runs = 0;
  let runningSignal: AbortSignal | undefined;
  const providerDetail = 'provider-diagnostic-that-must-stay-out-of-the-browser';
  const terminalRecords: UiRecord[] = [];
  const ui = await startUiServer({
    port: 0, mode: 'fixture', classifier: 'SCRIPTED_FIXTURE_MOCK',
    log: (event, fields) => { terminalRecords.push({ event, ...fields }); },
    run: async (signal, log) => {
      runs++;
      log('harness_started');
      if (runs === 1) throw new Error(providerDetail);
      runningSignal = signal;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  t.after(() => ui.close());
  assert.equal((await fetch(`${ui.url}/api/run`, { method: 'POST' })).status, 202);
  const failed = await snapshot(ui.url, 'error');
  assert.equal(failed.records.filter(record => record.event === 'ui_error').length, 1);
  assert.ok(!JSON.stringify(failed.records).includes(providerDetail));
  assert.ok(JSON.stringify(terminalRecords.filter(record => record.event === 'harness_error')).includes(providerDetail));
  assert.equal(failed.records.at(-1)?.running, false);

  assert.equal((await fetch(`${ui.url}/api/run`, { method: 'POST' })).status, 202);
  assert.equal((await fetch(`${ui.url}/api/run`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${ui.url}/api/stop`, { method: 'POST' })).status, 202);
  const stopped = await snapshot(ui.url, 'stopped');
  assert.equal(runs, 2);
  assert.equal(runningSignal?.aborted, true);
  assert.equal(stopped.records.at(-1)?.running, false);
  assert.equal(stopped.records.filter(record => record.event === 'ui_error').length, 0, 'replay clears the previous run error');
});

test('Gateway model changes serialize reconnects, preserve the session, and replay the active model', async t => {
  let runs = 0;
  let reconnects = 0;
  let maxReconnects = 0;
  let releaseFirst!: () => void;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  const changes: string[] = [];
  const ui = await startUiServer({
    port: 0, mode: 'mic', classifier: 'typesafe-ai/jev', sttProvider: 'gateway', log: () => {},
    run: async (signal, log, controls) => {
      runs++;
      assert.equal(controls.sttModel, 'openai/gpt-realtime-whisper');
      const unsubscribe = controls.onSttModelChange(async model => {
        changes.push(model);
        maxReconnects = Math.max(maxReconnects, ++reconnects);
        if (changes.length === 1) { enteredFirst(); await firstReleased; }
        log('stt_connected', { model });
        reconnects--;
      });
      log('queue_submit', { id: 'preserved', text: 'Keep this chat message.' });
      try { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
      finally { unsubscribe(); }
    },
  });
  t.after(async () => { releaseFirst(); await ui.close(); });
  await startMic(ui.url);
  const first = selectModel(ui.url, 'xai/grok-stt');
  await firstEntered;
  const during = await fetch(`${ui.url}/api/status`).then(response => response.json());
  assert.equal(during.sttModel, 'openai/gpt-realtime-whisper', 'do not label a model active before it connects');
  assert.equal(during.sttModelChanging, true);
  const second = selectModel(ui.url, 'openai/gpt-realtime-whisper');
  releaseFirst();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(changes, ['xai/grok-stt', 'openai/gpt-realtime-whisper']);
  assert.equal(maxReconnects, 1);
  assert.equal(runs, 1, 'a model switch must not restart input, filtering, or chat');
  const latest = await fetch(`${ui.url}/api/status`).then(response => response.json());
  assert.equal(latest.sttModel, 'openai/gpt-realtime-whisper');
  assert.equal(latest.sttModelChanging, false);
  assert.equal(latest.running, true);
  await fetch(`${ui.url}/api/stop`, { method: 'POST' });
  const replay = await snapshot(ui.url, 'stopped');
  assert.deepEqual(replay.records.filter(record => record.event === 'queue_submit').map(record => record.id), ['preserved']);
});

test('model selection validates input and hides provider diagnostics when reconnect fails', async t => {
  const diagnostic = 'private-provider-reconnect-diagnostic';
  const terminal: UiRecord[] = [];
  let signal: AbortSignal | undefined;
  let changes = 0;
  const ui = await startUiServer({
    port: 0, mode: 'mic', classifier: 'typesafe-ai/jev',
    log: (event, fields) => { terminal.push({ event, ...fields }); },
    run: async (runSignal, _log, controls) => {
      signal = runSignal;
      controls.onSttModelChange(async () => { changes++; throw new Error(diagnostic); });
      await new Promise<void>(resolve => runSignal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  t.after(() => ui.close());
  assert.equal((await selectModel(ui.url, 'not/a-supported-model')).status, 400);
  assert.equal((await fetch(`${ui.url}/api/stt-model`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${ui.url}/api/stt-model`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
  })).status, 400);
  assert.equal((await fetch(`${ui.url}/api/stt-model`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({ model: 'xai/grok-stt' }),
  })).status, 403);
  await startMic(ui.url);
  const failed = await selectModel(ui.url, 'xai/grok-stt');
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes(diagnostic));
  const replay = await snapshot(ui.url, 'running');
  assert.ok(!JSON.stringify(replay.records).includes(diagnostic));
  assert.equal(changes, 1);
  assert.ok(JSON.stringify(terminal).includes(diagnostic));
  const current = await fetch(`${ui.url}/api/status`).then(response => response.json());
  assert.equal(current.sttModel, 'openai/gpt-realtime-whisper');
  assert.equal(current.sttModelChanging, false);
  assert.equal((await fetch(`${ui.url}/api/stop`, { method: 'POST' })).status, 202);
  assert.equal(signal?.aborted, true);
});

test('stopping a pending model reconnect cancels it without committing the selection', async t => {
  let entered!: () => void;
  const reconnecting = new Promise<void>(resolve => { entered = resolve; });
  const ui = await startUiServer({
    port: 0, mode: 'mic', classifier: 'typesafe-ai/jev', log: () => {},
    run: async (signal, _log, controls) => {
      const stopped = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      controls.onSttModelChange(async () => { entered(); await stopped; });
      await stopped;
    },
  });
  t.after(() => ui.close());
  await startMic(ui.url);
  const changing = selectModel(ui.url, 'xai/grok-stt');
  await reconnecting;
  assert.equal((await fetch(`${ui.url}/api/stop`, { method: 'POST' })).status, 202);
  assert.equal((await changing).status, 409);
  const current = await fetch(`${ui.url}/api/status`).then(response => response.json());
  assert.equal(current.state, 'stopped');
  assert.equal(current.running, false);
  assert.equal(current.sttModel, 'openai/gpt-realtime-whisper');
  assert.equal(current.sttModelChanging, false);
});


test('browser PCM owns mic sessions, validates frames, and aborts on disconnect or Stop', async t => {
  const frames: Buffer[] = [];
  const signals: AbortSignal[] = [];
  const ui = await startUiServer({
    port: 0, mode: 'mic', classifier: 'disabled', log: () => {},
    run: async (signal, _log, controls) => {
      signals.push(signal);
      assert.ok(controls.browserAudio, 'UI mic cannot fall back to SoX');
      await controls.browserAudio.start(frame => frames.push(frame));
      await controls.browserAudio.done;
    },
  });
  t.after(() => ui.close());
  assert.equal((await fetch(`${ui.url}/api/run`, { method: 'POST' })).status, 409);
  for (const origin of [undefined, 'https://example.com']) {
    const denied = new WebSocket(ui.url.replace('http:', 'ws:') + '/audio', { origin });
    await assert.rejects(once(denied, 'open'), /403/);
  }
  const open = async () => {
    const ws = new WebSocket(ui.url.replace('http:', 'ws:') + '/audio', { origin: ui.url });
    const [message] = await once(ws, 'message');
    assert.deepEqual(JSON.parse(String(message)), { type: 'ready', sampleRate: 24000, channels: 1, format: 'pcm16le', frameMs: 20 });
    return ws;
  };
  const socket = await open();
  const duplicate = new WebSocket(ui.url.replace('http:', 'ws:') + '/audio', { origin: ui.url });
  await assert.rejects(once(duplicate, 'open'), /409/);
  socket.send(Buffer.alloc(960, 42));
  // Ordered WS messages ensure the valid frame is handled before malformed input.
  socket.send('not PCM');
  const [code] = await once(socket, 'close');
  assert.equal(code, 1008);
  await snapshot(ui.url, 'stopped');
  assert.equal(signals[0]?.aborted, true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.[0], 42);

  const second = await open();
  const closed = once(second, 'close');
  await fetch(`${ui.url}/api/stop`, { method: 'POST' });
  await closed;
  await snapshot(ui.url, 'stopped');
  assert.equal(signals[1]?.aborted, true);
  const third = await open();
  third.terminate();
  await snapshot(ui.url, 'stopped');
  assert.equal(signals[2]?.aborted, true);
});

test('losing the browser during STT startup cancels the pending connection', async t => {
  let signal: AbortSignal | undefined;
  const ui = await startUiServer({
    port: 0, mode: 'mic', classifier: 'disabled', log: () => {},
    run: async runSignal => {
      signal = runSignal;
      await new Promise<void>(resolve => runSignal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  t.after(() => ui.close());
  const socket = await startMic(ui.url);
  socket.terminate();
  await snapshot(ui.url, 'stopped');
  assert.equal(signal?.aborted, true);
});


test('fatal STT cleanup closes browser audio without hiding the run error as a user Stop', async t => {
  const ui = await startUiServer({
    port: 0, mode: 'mic', classifier: 'disabled', log() {},
    run: async (_signal, _log, controls) => {
      try {
        await controls.browserAudio!.start(() => {});
        throw new Error('simulated fatal STT failure');
      } finally { await controls.browserAudio!.stop(); }
    },
  });
  t.after(() => ui.close());
  const ws = new WebSocket(ui.url.replace('http:', 'ws:') + '/audio', { origin: ui.url });
  await once(ws, 'close');
  const failed = await snapshot(ui.url, 'error');
  assert.equal(failed.records.filter(record => record.event === 'ui_error').length, 1);
});
