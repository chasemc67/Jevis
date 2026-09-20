import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const runFile = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function runDemo(name: string): Promise<Record<string, unknown>[]> {
  const { stdout, stderr } = await runFile(process.execPath, [
    '--import', 'tsx',
    'apps/speech-filter-harness/src/main.ts',
    '--mode', 'fixture', '--dry-run', '--downstream', 'queue',
    '--file', `apps/speech-filter-harness/fixtures/ambient/${name}.json`,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    // dotenv does not override existing variables, including empty keys. Pin every
    // config knob so a developer's shell/.env cannot alter this offline acceptance run.
    env: {
      ...process.env,
      DEEPGRAM_API_KEY: '', AI_GATEWAY_API_KEY: '',
      STT_PROVIDER: 'deepgram', JEV_MODEL: 'typesafe-ai/jev',
      JEV_EVERY_N_WORDS: '1', DEBOUNCE_MS: '1500',
      T_DIR_CONFIDENCE: '0.6', T_NOUL: '0.6', K: '8',
      WINDOW_MAX_WORDS: '40', REGION_SILENCE_MS: '1500',
      JEV_TIMEOUT_MS: '4000', GATEWAY_ZERO_DATA_RETENTION: 'false',
      SOX_PATH: 'sox', MIC_DEVICE: 'default', DEBUG_AUDIO: 'false',
    },
  });
  assert.equal(stderr, '', `${name}: CLI should complete without warnings or errors`);
  return stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

test('CLI dry-run keeps ambient/unclear speech closed and queues only the directed suffix', { timeout: 45_000 }, async () => {
  const cases = [
    { name: 'mixed', expected: ['Could you summarize my notes?'] },
    { name: 'ambient-only', expected: [] },
    { name: 'unclear', expected: [] },
  ];
  await Promise.all(cases.map(async ({ name, expected }) => {
    // Use actual wall-clock pacing and the production CLI path, including cleanup.
    const records = await runDemo(name);
    assert.equal(records.find(record => record.event === 'harness_started')?.classifier, 'SCRIPTED_FIXTURE_MOCK', name);
    assert.equal(records.filter(record => record.event === 'dry_run_notice').length, 1, name);
    assert.deepEqual(records.filter(record => record.event === 'queue_submit').map(record => record.text), expected, name);
    const summary = records.find(record => record.event === 'queue_summary');
    assert.equal(summary?.size, expected.length, name);
    assert.deepEqual(summary?.segments, expected, name);
    const counters = records.find(record => record.event === 'filter_counters');
    assert.equal(counters?.segments_emitted, expected.length, name);
    assert.equal(counters?.jev_errors, 0, name);
    assert.equal(records.filter(record => record.event === 'fixture_completed').length, 1, name);
  }));
});
