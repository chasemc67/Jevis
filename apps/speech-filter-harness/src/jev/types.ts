export type Addressing = 'directed' | 'ambient' | 'unclear';

export interface CandidateWindow {
  startIndex: number;
  text: string;
}

export interface EvaluationInput {
  regionId: number;
  seq: number;
  fullTranscript: string;
  candidates: CandidateWindow[];
}

export interface CandidateDecision {
  startIndex: number;
  addressing: Addressing;
  directedProbability: number;
  ambientProbability: number;
  isDirectedProbability: number;
}

export interface JevEvaluation {
  decisions: CandidateDecision[];
  latencyMs: number;
  error?: string;
}

export interface JevEvaluator {
  evaluate(input: EvaluationInput, signal: AbortSignal): Promise<JevEvaluation>;
}
