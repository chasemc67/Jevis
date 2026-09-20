import type { CandidateWindow } from '../jev/types.js';
import type { Word } from '../stt/types.js';

/** Absolute indices within this region; zero is clipped to the bounded window. */
export function candidateWindows(words: readonly Word[], startIndex: number | null, excludedBefore: number, k: number, maxWords: number): CandidateWindow[] {
  const floor = Math.max(excludedBefore, words.length - maxWords, 0);
  if (floor >= words.length) return [];
  const indices = new Set<number>([floor]);
  if (startIndex !== null && startIndex >= floor && startIndex < words.length) indices.add(startIndex);
  for (let length = 1; length <= k && words.length - length >= floor; length++) indices.add(words.length - length);
  return [...indices].sort((a, b) => a - b).map((index) => ({
    startIndex: index,
    text: words.slice(index).map((word) => word.text).join(' '),
  }));
}
