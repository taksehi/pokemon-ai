import { BattleState } from '../battle/battle-state.js';
import { RequestPayload } from '../sim/battle-runner.js';
import { CandidateGenerator, EvaluatedCandidateAction } from '../strategy/candidate-generator.js';
import { BaselineEngine, ScoredCandidateAction } from '../strategy/baseline-engine.js';
import { PromptCompiler } from './prompt-compiler.js';
import { DecisionSchema, AgentDecision } from './decision-schema.js';
import { LLMClient } from './llm-client.js';

export interface PlayerDecisionResult {
  candidate: EvaluatedCandidateAction;
  decision: AgentDecision | null;
  usedFallback: boolean;
  rationale: string;
  fallbackCount?: number;
  fallbackRate?: number;
}

export class AIStrategyPlayer {
  private llmClient: LLMClient;
  private timeoutMs: number;
  private totalDecisions: number = 0;
  private fallbackCount: number = 0;

  constructor(llmClient: LLMClient, options: { timeoutMs?: number } = {}) {
    this.llmClient = llmClient;
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  public getStats(): { totalDecisions: number; fallbackCount: number; fallbackRate: number } {
    const fallbackRate = this.totalDecisions > 0 ? Number((this.fallbackCount / this.totalDecisions).toFixed(4)) : 0;
    return {
      totalDecisions: this.totalDecisions,
      fallbackCount: this.fallbackCount,
      fallbackRate
    };
  }

  public resetStats(): void {
    this.totalDecisions = 0;
    this.fallbackCount = 0;
  }

  /**
   * Decides the next action using the AI model with guaranteed deterministic fallback.
   */
  public async decideAction(
    state: BattleState,
    request: RequestPayload
  ): Promise<PlayerDecisionResult> {
    this.totalDecisions++;
    const candidates = CandidateGenerator.generateCandidates(state, request);
    if (candidates.length === 0) {
      throw new Error('No legal candidate actions found in current state');
    }

    const prompt = PromptCompiler.compilePrompt(state, candidates);

    try {
      let validatedDecision: AgentDecision;

      if (this.llmClient.decide) {
        validatedDecision = await this.executeWithTimeout(
          () => this.llmClient.decide!(state, candidates),
          this.timeoutMs
        );
      } else {
        const prompt = PromptCompiler.compilePrompt(state, candidates);
        const rawResponse = await this.executeWithTimeout(
          () => this.llmClient.generate(prompt),
          this.timeoutMs
        );
        const cleanJson = this.sanitizeJsonString(rawResponse);
        const parsed = JSON.parse(cleanJson);
        validatedDecision = DecisionSchema.parse(parsed);
      }

      // Verify selected candidate exists in legal list
      const matchedCandidate = candidates.find(c => c.id === validatedDecision.selected_candidate_id);
      if (!matchedCandidate) {
        throw new Error(
          `AI hallucinated illegal candidate ID: "${validatedDecision.selected_candidate_id}". Legal candidates: [${candidates.map(c => c.id).join(', ')}]`
        );
      }

      return {
        candidate: matchedCandidate,
        decision: validatedDecision,
        usedFallback: false,
        rationale: validatedDecision.strategic_rationale,
        fallbackCount: this.fallbackCount,
        fallbackRate: this.totalDecisions > 0 ? Number((this.fallbackCount / this.totalDecisions).toFixed(4)) : 0
      };
    } catch (err: any) {
      this.fallbackCount++;
      const fallbackReason = err?.message || String(err);
      // Hard deterministic fallback
      const fallback: ScoredCandidateAction = BaselineEngine.selectBestAction(state, request);

      return {
        candidate: fallback.candidate,
        decision: null,
        usedFallback: true,
        rationale: `[SAFETY FALLBACK] ${fallbackReason} | Selected: ${fallback.candidate.name} (Score: ${fallback.score})`,
        fallbackCount: this.fallbackCount,
        fallbackRate: this.totalDecisions > 0 ? Number((this.fallbackCount / this.totalDecisions).toFixed(4)) : 0
      };
    }
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`AI inference timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private sanitizeJsonString(raw: string): string {
    let clean = raw.trim();
    if (clean.startsWith('```json')) {
      clean = clean.slice(7);
    } else if (clean.startsWith('```')) {
      clean = clean.slice(3);
    }
    if (clean.endsWith('```')) {
      clean = clean.slice(0, -3);
    }
    return clean.trim();
  }
}
