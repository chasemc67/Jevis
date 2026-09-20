import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../apps/speech-filter-harness/src/config.js';

test('config defaults to Gateway/OpenAI without requiring keys for offline demos', () => {
  const config = readConfig({});
  assert.equal(config.sttProvider, 'gateway');
  assert.equal(config.sttModel, 'openai/gpt-realtime-whisper');
  assert.equal(config.gatewayApiKey, undefined);
  assert.equal(config.deepgramApiKey, undefined);
});

test('Gateway supports either streaming model with a single credential', () => {
  for (const sttModel of ['openai/gpt-realtime-whisper', 'xai/grok-stt']) {
    const config = readConfig({ STT_MODEL: sttModel, AI_GATEWAY_API_KEY: ' local-test-key ' });
    assert.equal(config.sttProvider, 'gateway');
    assert.equal(config.sttModel, sttModel);
    assert.equal(config.gatewayApiKey, 'local-test-key');
    assert.equal(config.deepgramApiKey, undefined);
  }
});

test('legacy Deepgram selection falls back to Gateway when its optional key is absent', () => {
  for (const deepgramKey of [undefined, '', '  ']) {
    const config = readConfig({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: deepgramKey, AI_GATEWAY_API_KEY: 'local-test-key' });
    assert.equal(config.sttProvider, 'gateway');
  }
});

test('Deepgram remains an explicit optional provider', () => {
  assert.equal(readConfig({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'local-test-key' }).sttProvider, 'deepgram');
  assert.equal(readConfig({ DEEPGRAM_API_KEY: 'local-test-key' }).sttProvider, 'gateway');
});

test('config rejects unsupported STT providers and Gateway models', () => {
  assert.throws(() => readConfig({ STT_PROVIDER: 'unknown' }), /STT_PROVIDER must be gateway or deepgram/);
  assert.throws(() => readConfig({ STT_MODEL: 'openai/whisper-1' }), /STT_MODEL must be openai\/gpt-realtime-whisper or xai\/grok-stt/);
});
