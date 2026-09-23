import { BattleState } from '../battle/battle-state.js';
import { RequestPayload } from '../sim/battle-runner.js';
import { CandidateGenerator, EvaluatedCandidateAction } from './candidate-generator.js';
import { ScoredCandidateAction } from './baseline-engine.js';
import { NeuralValueModel } from '../model/model-artifact.js';
import { extractFeatures } from '../model/feature-extractor.js';

export class NeuralEngine {
  /**
   * Evaluates all legal candidates using the trained neural value model and returns the top choice.
   */
  public static selectBestAction(
    model: NeuralValueModel,
    state: BattleState,
    request: RequestPayload
  ): ScoredCandidateAction {
    const candidates = CandidateGenerator.generateCandidates(state, request);
    if (candidates.length === 0) {
      throw new Error('No legal candidates generated for current request');
    }

    const scored = candidates.map(candidate => {
      const features = extractFeatures(state, candidate);
      const predictedValue = model.predict(features);

      // Value score derived from trained neural weights
      // Heuristic baseline guidance prevents illegal/fatal blunders (e.g. immunity 0x)
      let score = predictedValue * 15;
      const breakdown: string[] = [`Neural Q-Value: ${predictedValue.toFixed(3)} (Weighted: +${(predictedValue * 15).toFixed(1)})`];

      if (candidate.type === 'move') {
        const ev = candidate.evaluation;
        if (ev.typeEffectivenessAgainstOpponent === 0) {
          score -= 200; // Strong penalty for attacking into immunity
          breakdown.push('Immunity penalty: -200');
        } else if (ev.typeEffectivenessAgainstOpponent !== undefined && ev.typeEffectivenessAgainstOpponent >= 2.0) {
          score += 20;
          breakdown.push('Super-effective bonus: +20');
        }
        const avgDmg = (ev.minDamagePercent + ev.maxDamagePercent) / 2;
        score += avgDmg * 0.5;
        breakdown.push(`Damage contribution: +${(avgDmg * 0.5).toFixed(1)}`);

        // Terastallization conservation: Never waste Tera early without lethal KO
        if (candidate.terastallize) {
          if (ev.koProbability >= 0.85) {
            score += 25;
            breakdown.push('Tera secures lethal KO: +25');
          } else if ((state.turn ?? 1) <= 3) {
            score -= 80;
            breakdown.push('Conserve early-game Tera: -80');
          } else {
            score -= 25;
            breakdown.push('Conserve mid-game Tera: -25');
          }
        }

        // Threat response against boosted opponent setup sweepers
        const p2Boosts = state.p2.active?.boosts;
        const oppIsBoosted = p2Boosts && (p2Boosts.atk >= 1 || p2Boosts.spa >= 1 || p2Boosts.spe >= 1);
        if (oppIsBoosted) {
          if (ev.koProbability >= 0.7) {
            score += 50;
            breakdown.push('Lethal strike against boosted opponent: +50');
          } else if (ev.priority && ev.priority > 0) {
            score += 30;
            breakdown.push('Priority strike against boosted opponent: +30');
          }
        }
      } else if (candidate.type === 'switch') {
        const hazardDmg = candidate.evaluation.hazardDamagePercent ?? 0;
        if (!request.forceSwitch || !request.forceSwitch[0]) {
          const switchCost = 12 + hazardDmg * 0.8;
          score -= switchCost;
          breakdown.push(`Voluntary switch cost with hazard damage (-${switchCost.toFixed(1)})`);
        }
      }

      return {
        candidate,
        score,
        breakdown
      };
    });

    // Sort descending by score, deterministic tie-breaker on candidate id
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    });

    return scored[0];
  }
}
