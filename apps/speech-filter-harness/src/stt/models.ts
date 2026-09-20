export const GATEWAY_STT_MODELS = ['openai/gpt-realtime-whisper', 'xai/grok-stt'] as const;
export type GatewaySttModel = typeof GATEWAY_STT_MODELS[number];
export const DEFAULT_STT_MODEL: GatewaySttModel = 'openai/gpt-realtime-whisper';

export function isGatewaySttModel(value: unknown): value is GatewaySttModel {
  return typeof value === 'string' && GATEWAY_STT_MODELS.some(model => model === value);
}
