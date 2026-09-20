import assert from 'node:assert/strict';
import test from 'node:test';
import { startUiServer } from '../apps/speech-filter-harness/src/ui/server.js';

interface UiRecord { event: string; [key: string]: unknown }

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
