import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startUiServer } from '../apps/speech-filter-harness/src/ui/server.js';

const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => path && existsSync(path));

test('Chrome captures synthetic mic PCM, retains multiple submits, switches models, and releases/restarts capture',
  { skip: !chrome && 'Chrome not installed; set CHROME_PATH to enable browser integration', timeout: 30000 }, async t => {
    let frames = 0;
    let runs = 0;
    let changes = 0;
    const ui = await startUiServer({
      port: 0, mode: 'mic', classifier: 'disabled', log() {},
      run: async (signal, log, controls) => {
        runs++;
        controls.onSttModelChange(async () => { changes++; });
        log('harness_started', { mode: 'mic', classifier: 'disabled' });
        await controls.browserAudio!.start(frame => {
          assert.equal(frame.length, 960);
          frames++;
          if (frames % 30 === 0) log('queue_submit', { id: String(frames), text: 'Synthetic request ' + frames, startIndex: 0 });
        });
        await controls.browserAudio!.done;
        assert.equal(signal.aborted, true);
      },
    });
    t.after(() => ui.close());
    const profile = await mkdtemp(join(tmpdir(), 'jevis-chrome-'));
    const child = spawn(chrome!, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--remote-debugging-port=0', '--remote-allow-origins=*',
      '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    let ws: WebSocket | undefined;
    t.after(async () => {
      ws?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome did not expose DevTools')), 8000);
      child.stderr.on('data', chunk => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      child.once('error', reject);
    });
    ws = new WebSocket(endpoint);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    ws.on('message', raw => {
      const response = JSON.parse(String(raw));
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.error) request.reject(new Error(JSON.stringify(response.error)));
      else request.resolve(response.result);
    });
    const command = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws!.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await command('Target.createTarget', { url: ui.url });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression: string) => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async (expression: string) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); }
      assert.fail('Browser condition timed out: ' + expression);
    };
    await until("document.getElementById('run') && !document.getElementById('run').disabled");
    await evaluate("document.getElementById('run').click()");
    await until("Number(document.getElementById('submit-count').textContent) >= 2");
    assert.equal(runs, 1);
    assert.ok(frames >= 60);
    assert.equal(await evaluate("document.getElementById('stop').disabled"), false);
    assert.equal(await evaluate("mic.stream.getAudioTracks()[0].readyState"), 'live');
    assert.ok(await evaluate("document.getElementById('mic-device').options.length > 1"));
    await evaluate("document.getElementById('stt-model').value = 'xai/grok-stt'; document.getElementById('stt-model').dispatchEvent(new Event('change'))");
    await until("!document.getElementById('stt-model').disabled && document.getElementById('active-stt-model').textContent.includes('xai/grok-stt')");
    assert.equal(changes, 1);
    assert.equal(runs, 1);
    await evaluate("window.capturedTrack = mic.stream.getAudioTracks()[0]; document.getElementById('stop').click()");
    await until("!document.getElementById('run').disabled");
    assert.equal(await evaluate('window.capturedTrack.readyState'), 'ended');
    assert.equal(await evaluate('mic'), null);
    const stoppedFrames = frames;
    await delay(100);
    assert.equal(frames, stoppedFrames);
    await evaluate("document.getElementById('run').click()");
    await until("mic && mic.stream && mic.processor && !state.pending");
    assert.equal(runs, 2);
    await command('Target.closeTarget', { targetId });
    for (let i = 0; i < 100; i++) {
      const status = await fetch(ui.url + '/api/status').then(response => response.json());
      if (!status.running) { assert.equal(status.state, 'stopped'); return; }
      await delay(20);
    }
    assert.fail('Closing the capture tab must stop the server session');
  });
