import type { Log } from '../stt/types.js';

/** One JSON record per line; terminal control characters in transcripts are escaped. */
export function createTextFeed(write: (line: string) => void = console.log): Log {
  return (event, fields = {}) => write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
