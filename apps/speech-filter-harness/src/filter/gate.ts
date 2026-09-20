import type { CandidateDecision, CandidateWindow, JevEvaluation } from '../jev/types.js';

export type Gate = { kind: 'directed'; startIndex: number; decision: CandidateDecision } | { kind: 'ambient' | 'unclear' };

const probability = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

/** Validate again at the trust boundary so a replacement evaluator also fails closed. */
export function confidenceGate(result: JevEvaluation, candidates: CandidateWindow[], directedThreshold: number, booleanThreshold: number): Gate {
  if (result.error || result.decisions.length !== candidates.length || candidates.length === 0) return { kind: 'unclear' };
  const seen = new Set<number>();
  for (const d of result.decisions) {
    if (seen.has(d.startIndex) || !candidates.some((c) => c.startIndex === d.startIndex)
      || !['directed', 'ambient', 'unclear'].includes(d.addressing)
      || ![d.directedProbability, d.ambientProbability, d.isDirectedProbability].every(probability)
      || d.directedProbability + d.ambientProbability > 1.001) return { kind: 'unclear' };
    seen.add(d.startIndex);
  }
  const directed = result.decisions.filter((d) => d.addressing === 'directed'
    && d.directedProbability >= directedThreshold && d.isDirectedProbability >= booleanThreshold)
    .sort((a, b) => a.startIndex - b.startIndex)[0];
  if (directed) return { kind: 'directed', startIndex: directed.startIndex, decision: directed };
  const wholeWindow = result.decisions.find((d) => d.startIndex === candidates[0]?.startIndex);
  if (wholeWindow?.addressing === 'ambient' && wholeWindow.ambientProbability >= directedThreshold) return { kind: 'ambient' };
  return { kind: 'unclear' };
}
