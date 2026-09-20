import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSoxArgs, pcmRms, PCM_FRAME_BYTES, SoxAudioSource } from '../apps/speech-filter-harness/src/mic/sox.js';

test('SoX captures default CoreAudio input as 16k mono signed little-endian PCM', () => {
  assert.deepEqual(buildSoxArgs({ kind: 'mic' }), ['-q', '--buffer', '640', '-d', '-t', 'raw', '-r', '16000', '-e', 'signed-integer', '-b', '16', '-c', '1', '-L', '-']);
  const device = 'External Microphone; literal device name';
  assert.equal(buildSoxArgs({ kind: 'mic', device })[5], device);
});

test('SoX captures Gateway input as 24k mono PCM in 960-byte frames', () => {
  assert.deepEqual(buildSoxArgs({ kind: 'mic', sampleRate: 24_000 }), ['-q', '--buffer', '960', '-d', '-t', 'raw', '-r', '24000', '-e', 'signed-integer', '-b', '16', '-c', '1', '-L', '-']);
});

test('local RMS measures signed PCM and handles silence without becoming a gate', () => {
  assert.equal(pcmRms(Buffer.alloc(640)), 0);
  const frame = Buffer.alloc(4);
  frame.writeInt16LE(16384, 0);
  frame.writeInt16LE(-16384, 2);
  assert.equal(pcmRms(frame), 0.5);
  assert.equal(pcmRms(Buffer.alloc(0)), 0);
});

test('missing SoX explains the Homebrew setup', async () => {
  const source = new SoxAudioSource({ kind: 'mic', soxPath: '/not/a/real/jevis-sox', onFrame: () => {}, log: () => {} });
  await assert.rejects(source.start(), /brew install sox/);
  await assert.rejects(source.done, /brew install sox/);
  await source.stop();
});

test('stop before start skips input validation and does not spawn capture', async () => {
  const events: string[] = [];
  const source = new SoxAudioSource({ kind: 'wav', wavPath: '/not/a/real/jevis.wav', soxPath: '/not/a/real/jevis-sox',
    onFrame: () => { assert.fail('stopped source emitted audio'); }, log: event => { events.push(event); } });
  await source.stop();
  await source.start();
  await source.done;
  assert.deepEqual(events, []);
});

test('stop during WAV input validation prevents a late capture process', async () => {
  const events: string[] = [];
  const source = new SoxAudioSource({ kind: 'wav', wavPath: fileURLToPath(new URL('../package.json', import.meta.url)),
    soxPath: '/not/a/real/jevis-sox', onFrame: () => { assert.fail('stopped source emitted audio'); },
    log: event => { events.push(event); } });
  // start() reaches its asynchronous readability check before stop() resolves done.
  const starting = source.start();
  await source.stop();
  await starting;
  await source.done;
  assert.deepEqual(events, []);
});

test('stop waits for the capture child and escalates when it ignores SIGTERM', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jevis-stop-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeSox = join(directory, 'fake-sox');
  const pidPath = join(directory, 'capture.pid');
  await writeFile(fakeSox, `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdout.write(Buffer.alloc(9600));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  let firstFrame!: () => void;
  const arrived = new Promise<void>(resolve => { firstFrame = resolve; });
  const source = new SoxAudioSource({ kind: 'wav', wavPath: fakeSox, soxPath: fakeSox,
    sampleRate: 24_000, onFrame: () => firstFrame(), log: () => {} });
  let pid: number | undefined;
  t.after(async () => {
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    await source.stop();
  });
  await source.start();
  await arrived;
  pid = Number(await readFile(pidPath, 'utf8'));
  // Let consume enter a WAV pacing delay, which stop aborts before child exit.
  await delay(5);
  await source.stop();
  assert.throws(() => process.kill(pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    'stop must not return while the audio child is alive');
});

const soxInstalled = spawnSync('sox', ['--version'], { encoding: 'utf8' }).status === 0;
for (const outputRate of [16_000, 24_000] as const) {
  test(`WAV mode resamples to ${outputRate}Hz and paces 20ms streaming frames`, { skip: !soxInstalled }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'jevis-audio-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'sample.wav');
    // 200ms, stereo 8kHz, deliberately unlike the wire format.
    const sampleRate = 8000;
    const dataBytes = sampleRate * 0.2 * 4;
    const wav = Buffer.alloc(44 + dataBytes);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 4, 28);
    wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
    wav.writeUInt32LE(dataBytes, 40);
    await writeFile(path, wav);
    const arrivals: number[] = [];
    const frames: Buffer[] = [];
    const events: { name: string; detail: Record<string, unknown> }[] = [];
    const source = new SoxAudioSource({ kind: 'wav', wavPath: path, sampleRate: outputRate,
      onFrame: frame => { arrivals.push(performance.now()); frames.push(Buffer.from(frame)); },
      log: (name, detail = {}) => { events.push({ name, detail }); } });
    t.after(() => source.stop());
    await source.start();
    await source.done;
    assert.equal(Buffer.concat(frames).length, outputRate * 2 * 0.2);
    assert.ok(frames.every(frame => frame.length === outputRate * 2 * 0.02));
    assert.equal(PCM_FRAME_BYTES, 640, 'legacy Deepgram frame size stays unchanged');
    assert.ok(arrivals.at(-1)! - arrivals[0]! >= 155, 'WAV must play in realtime, not burst all audio into STT');
    assert.equal(events.find(event => event.name === 'audio_started')?.detail.sampleRate, outputRate);
    assert.equal(events.find(event => event.name === 'audio_stopped')?.detail.audioMs, 200);
  });
}
