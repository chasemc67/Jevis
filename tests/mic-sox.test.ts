import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildSoxArgs, pcmRms, PCM_FRAME_BYTES, SoxAudioSource } from '../apps/speech-filter-harness/src/mic/sox.js';

test('SoX captures default CoreAudio input as 16k mono signed little-endian PCM', () => {
  assert.deepEqual(buildSoxArgs({ kind: 'mic' }), ['-q', '--buffer', '640', '-d', '-t', 'raw', '-r', '16000', '-e', 'signed-integer', '-b', '16', '-c', '1', '-L', '-']);
  const device = 'External Microphone; literal device name';
  assert.equal(buildSoxArgs({ kind: 'mic', device })[5], device);
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

const soxInstalled = spawnSync('sox', ['--version'], { encoding: 'utf8' }).status === 0;
test('WAV mode converts and paces audio into the same 20ms streaming frames', { skip: !soxInstalled }, async t => {
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
  const source = new SoxAudioSource({ kind: 'wav', wavPath: path,
    onFrame: frame => { arrivals.push(performance.now()); frames.push(Buffer.from(frame)); }, log: () => {} });
  t.after(() => source.stop());
  await source.start();
  await source.done;
  assert.equal(Buffer.concat(frames).length, 6400);
  assert.ok(frames.every(frame => frame.length === PCM_FRAME_BYTES));
  assert.ok(arrivals.at(-1)! - arrivals[0]! >= 155, 'WAV must play in realtime, not burst all audio into STT');
});
