import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { browserCaptureScript, pcmWorklet } from '../apps/speech-filter-harness/src/ui/browser.js';

test('worklet emits exact 20ms mono PCM16 little-endian frames across render blocks', () => {
  for (const sampleRate of [24000, 16000]) {
    const frames: { frame: ArrayBuffer; level: number }[] = [];
    let Processor: any;
    runInNewContext(pcmWorklet, {
      sampleRate,
      AudioWorkletProcessor: class { port = { postMessage: (frame: typeof frames[number]) => frames.push(frame) }; },
      registerProcessor: (_name: string, processor: unknown) => { Processor = processor; },
    });
    const processor = new Processor();
    // Deliberately split at non-frame/render boundaries. Mix stereo to mono.
    const samples = sampleRate / 50 * 3;
    let sent = 0;
    while (sent < samples) {
      const size = Math.min(128, samples - sent);
      assert.equal(processor.process([[new Float32Array(size).fill(1), new Float32Array(size).fill(-0.5)]]), true);
      sent += size;
    }
    assert.equal(frames.length, 3);
    for (const { frame, level } of frames) {
      assert.equal(frame.byteLength, sampleRate / 50 * 2);
      assert.equal(level, 0.25);
      for (let i = 0; i < frame.byteLength; i += 2) assert.equal(new DataView(frame).getInt16(i, true), 8192);
    }
  }
});

function browserHarness(getUserMedia: () => Promise<unknown>) {
  let contextsClosed = 0;
  let sockets = 0;
  const BrowserMic = runInNewContext(browserCaptureScript + '\nBrowserMic;', {
    navigator: { mediaDevices: { getUserMedia } }, DOMException,
    AudioContext: class {
      sampleRate = 24000;
      resume = async () => {};
      close = async () => { contextsClosed++; };
    },
    WebSocket: class { constructor() { sockets++; } },
  });
  const capture = new BrowserMic(() => {}, () => {});
  return { capture, get contextsClosed() { return contextsClosed; }, get sockets() { return sockets; } };
}

test('Stop during permission prompt closes late microphone tracks without opening an audio socket', async () => {
  let grant!: (value: unknown) => void;
  let requested!: () => void;
  const requesting = new Promise<void>(resolve => { requested = resolve; });
  const h = browserHarness(() => { requested(); return new Promise(resolve => { grant = resolve; }); });
  const started = h.capture.start('default', 24000);
  await requesting;
  h.capture.stop();
  let tracksStopped = 0;
  grant({ getTracks: () => [{ stop: () => { tracksStopped++; } }] });
  await assert.rejects(started, { name: 'AbortError' });
  assert.equal(tracksStopped, 1);
  assert.equal(h.contextsClosed, 1);
  assert.equal(h.sockets, 0);
});

test('permission denial releases the audio context and never starts the server session', async () => {
  const h = browserHarness(async () => { throw new DOMException('Denied', 'NotAllowedError'); });
  await assert.rejects(h.capture.start('default', 24000), { name: 'NotAllowedError' });
  h.capture.stop();
  h.capture.stop();
  assert.equal(h.contextsClosed, 1);
  assert.equal(h.sockets, 0);
});
