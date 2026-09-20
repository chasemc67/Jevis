/** Vendor-neutral words; timestamps are milliseconds on the STT stream clock. */
export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

/** A replaceable time-range hypothesis, not an append-only text delta. */
export interface WordEvent {
  text: string;
  words: Word[];
  startMs: number;
  endMs: number;
  isFinal: boolean;
  speechFinal?: boolean;
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface SttCallbacks {
  onTranscript(event: WordEvent): void;
  onBoundary(reason: string, lastWordEndMs?: number): void;
  onConnection(connected: boolean): void;
  log: Log;
}
