import type { Word, WordEvent } from './types.js';

export interface AlignmentUpdate {
  words: Word[];
  text: string;
  changed: boolean;
  /** Text/word membership changed; final flags and timing alone do not reclassify. */
  contentChanged: boolean;
  newWordCount: number;
  changedFromIndex: number;
}

function sameWord(a: Word | undefined, b: Word | undefined): boolean {
  return a?.text === b?.text && a?.startMs === b?.startMs &&
    a?.endMs === b?.endMs && a?.isFinal === b?.isFinal;
}

function overlaps(a: Word, b: { startMs: number; endMs: number }): boolean {
  return a.startMs < b.endMs && a.endMs > b.startMs;
}

/** Merge replacement hypotheses on the stream clock, never append transcript strings. */
export class WordAlignment {
  private current: Word[] = [];

  reset(): void {
    this.current = [];
  }

  apply(event: WordEvent): AlignmentUpdate {
    const before = this.current;
    // An interim replaces the entire unfinished tail, including words withdrawn by
    // the recognizer. A final only replaces its own range, preserving later interim
    // words until the next update. An interim cannot un-finalize committed words.
    const retained = before.filter(word => {
      if (!event.isFinal && word.isFinal) return true;
      if (overlaps(word, event)) return false;
      if (!event.isFinal && !word.isFinal && word.startMs >= event.startMs) return false;
      return true;
    });
    const inserted = event.words.filter(word => event.isFinal ||
      !retained.some(old => old.isFinal && overlaps(old, word)));
    const after = [...retained, ...inserted.map(word => ({ ...word }))]
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let changedFromIndex = 0;
    while (changedFromIndex < Math.min(before.length, after.length) &&
      sameWord(before[changedFromIndex], after[changedFromIndex])) changedFromIndex++;
    const changed = before.length !== after.length || changedFromIndex < after.length;
    const contentChanged = before.length !== after.length ||
      after.some((word, index) => word.text !== before[index]?.text);
    this.current = after;
    return {
      words: after.map(word => ({ ...word })),
      text: after.map(word => word.text).join(' '),
      changed,
      contentChanged,
      newWordCount: Math.max(0, after.length - before.length),
      changedFromIndex: changed ? changedFromIndex : after.length,
    };
  }
}
