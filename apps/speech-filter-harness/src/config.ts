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
  if (env.STT_PROVIDER && env.STT_PROVIDER !== 'deepgram') throw new Error('Phase 0 implements STT_PROVIDER=deepgram only');
  if (env.JEV_MODEL && env.JEV_MODEL !== 'typesafe-ai/jev') throw new Error('JEV_MODEL must be typesafe-ai/jev via Vercel AI Gateway');
  return {
    deepgramApiKey: env.DEEPGRAM_API_KEY?.trim() || undefined,
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
