import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import test from 'node:test';

type Event = { event: string; [key: string]: unknown };

async function subscribe(url: string) {
  const abort = new AbortController();
  const response = await fetch(`${url}/events`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const records: Event[] = [];
  const listeners = new Set<() => void>();
  const done = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!block.startsWith('data: ')) continue;
        records.push(JSON.parse(block.slice(6)) as Event);
        for (const listener of listeners) listener();
      }
    }
  })().catch(error => { if (!abort.signal.aborted) throw error; });
  return {
    records,
    close: async () => { abort.abort(); await done; },
    wait: (predicate: (events: Event[]) => boolean): Promise<void> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Timed out waiting for UI events')); }, 18000);
      const check = () => {
        if (!predicate(records)) return;
        clearTimeout(timer); listeners.delete(check); resolve();
      };
      listeners.add(check); check();
    }),
  };
}

test('offline UI streams real filter events, cancels safely, replays, and restores chat on reconnect', { timeout: 35000 }, async t => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/speech-filter-harness/src/main.ts',
    '--mode', 'fixture', '--dry-run', '--ui', '--port', '0'], {
    env: {
      ...process.env, DEEPGRAM_API_KEY: '', AI_GATEWAY_API_KEY: '',
      STT_PROVIDER: 'deepgram', JEV_MODEL: 'typesafe-ai/jev',
      JEV_EVERY_N_WORDS: '1', DEBOUNCE_MS: '1500', T_DIR_CONFIDENCE: '0.6', T_NOUL: '0.6',
      K: '8', WINDOW_MAX_WORDS: '40', REGION_SILENCE_MS: '1500', JEV_TIMEOUT_MS: '4000',
      GATEWAY_ZERO_DATA_RETENTION: 'false', DEBUG_AUDIO: 'false',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const subscriptions: Awaited<ReturnType<typeof subscribe>>[] = [];
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  t.after(async () => {
    for (const stream of subscriptions) await stream.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '');
  });
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`UI did not start: ${stderr}`)), 5000);
    lines.on('line', line => {
      const record = JSON.parse(line) as Event;
      if (record.event === 'ui_listening') { clearTimeout(timer); resolve(String(record.url)); }
    });
  });
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Chat stream/);
  const initial = await fetch(`${url}/api/status`).then(res => res.json()) as { running: boolean };
  assert.equal(initial.running, false, 'opening the page must not start capture or miss fixture words');
  assert.equal((await fetch(`${url}/api/run`, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  const stream = await subscribe(url);
  subscriptions.push(stream);
  assert.equal((await fetch(`${url}/api/run`, { method: 'POST' })).status, 202);
  assert.equal((await fetch(`${url}/api/run`, { method: 'POST' })).status, 409, 'one input run at a time');
  await stream.wait(events => events.some(e => e.event === 'stt_partial'));
  await fetch(`${url}/api/stop`, { method: 'POST' });
  await stream.wait(events => events.some(e => e.event === 'ui_status' && e.state === 'stopped'));
  assert.equal(stream.records.filter(e => e.event === 'queue_submit').length, 0);

  const replayAt = stream.records.length;
  await fetch(`${url}/api/run`, { method: 'POST' });
  await stream.wait(events => events.slice(replayAt).some(e => e.event === 'ui_status' && e.state === 'completed'));
  const records = stream.records.slice(replayAt);
  assert.equal(records.find(e => e.event === 'harness_started')?.classifier, 'SCRIPTED_FIXTURE_MOCK');
  assert.ok(records.some(e => e.event === 'ui_reset'));
  assert.ok(records.some(e => e.event === 'stt_partial'));
  assert.ok(records.some(e => e.event === 'stt_final'));
  assert.ok(records.some(e => e.event === 'evaluation_requested'));
  const submits = records.filter(e => e.event === 'queue_submit');
  assert.deepEqual(submits.map(e => e.text), ['Could you summarize my notes?']);
  assert.equal(submits[0]?.startIndex, 4);
  const ready = records.filter(e => e.event === 'filter_preview' && e.gate === 'directed').at(-1)!;
  assert.equal(ready.decisionFresh, true);
  assert.equal(ready.startIndex, 4);
  assert.ok(Date.parse(String(submits[0]?.emittedAt)) >= Number(ready.debounceDueAt));
  assert.ok(records.some(e => e.event === 'debounce_fired' && e.regionId === submits[0]?.regionId));
  const result = records.find(e => e.event === 'jev_result' && e.gate === 'directed')!;
  assert.ok(Array.isArray(result.candidates));
  assert.ok(Array.isArray(result.decisions));
  assert.equal(records.find(e => e.event === 'filter_counters')?.segments_emitted, 1);

  const restored = await subscribe(url);
  subscriptions.push(restored);
  await restored.wait(events => events.some(e => e.event === 'ui_status' && e.state === 'completed'));
  assert.equal(restored.records[0]?.event, 'ui_reset');
  assert.deepEqual(restored.records.filter(e => e.event === 'queue_submit').map(e => e.text), ['Could you summarize my notes?']);
});
