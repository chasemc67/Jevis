import { DEFAULT_STT_MODEL, isGatewaySttModel, type GatewaySttModel } from './stt/models.js';

export interface FilterConfig {
  everyNWords: number;
  debounceMs: number;
  directedThreshold: number;
  booleanThreshold: number;
  k: number;
  windowMaxWords: number;
  regionSilenceMs: number;
}

export interface Config extends FilterConfig {
  sttProvider: 'gateway' | 'deepgram';
  sttModel: GatewaySttModel;
  deepgramApiKey?: string;
  gatewayApiKey?: string;
  jevTimeoutMs: number;
  zeroDataRetention: boolean;
  soxPath: string;
  micDevice: string;
  debugAudio: boolean;
}

function number(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number, integer = true): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  if (env[key] === undefined) return fallback;
  if (env[key] === 'true') return true;
  if (env[key] === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const requestedSttProvider = env.STT_PROVIDER?.trim() || 'gateway';
  const sttModel = env.STT_MODEL?.trim() || DEFAULT_STT_MODEL;
  const deepgramApiKey = env.DEEPGRAM_API_KEY?.trim() || undefined;
  if (requestedSttProvider !== 'gateway' && requestedSttProvider !== 'deepgram') throw new Error('STT_PROVIDER must be gateway or deepgram');
  if (!isGatewaySttModel(sttModel)) throw new Error('STT_MODEL must be openai/gpt-realtime-whisper or xai/grok-stt');
  if (env.JEV_MODEL && env.JEV_MODEL !== 'typesafe-ai/jev') throw new Error('JEV_MODEL must be typesafe-ai/jev via Vercel AI Gateway');
  return {
    // Older .env files selected Deepgram by default. Migrate them to the one-key
    // Gateway path unless an optional Deepgram credential is actually supplied.
    sttProvider: requestedSttProvider === 'deepgram' && deepgramApiKey ? 'deepgram' : 'gateway',
    sttModel,
    deepgramApiKey,
    gatewayApiKey: env.AI_GATEWAY_API_KEY?.trim() || undefined,
    everyNWords: number(env, 'JEV_EVERY_N_WORDS', 1, 1, 3),
    debounceMs: number(env, 'DEBOUNCE_MS', 1500, 1000, 2000),
    directedThreshold: number(env, 'T_DIR_CONFIDENCE', 0.6, 0, 1, false),
    booleanThreshold: number(env, 'T_NOUL', 0.6, 0, 1, false),
    k: number(env, 'K', 8, 1, 40),
    windowMaxWords: number(env, 'WINDOW_MAX_WORDS', 40, 1, 400),
    regionSilenceMs: number(env, 'REGION_SILENCE_MS', 1500, 1500, 2000),
    jevTimeoutMs: number(env, 'JEV_TIMEOUT_MS', 4000, 100, 30000),
    zeroDataRetention: boolean(env, 'GATEWAY_ZERO_DATA_RETENTION', false),
    soxPath: env.SOX_PATH || 'sox',
    micDevice: env.MIC_DEVICE || 'default',
    debugAudio: boolean(env, 'DEBUG_AUDIO', false),
  };
}
