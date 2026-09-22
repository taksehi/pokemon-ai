import { BattleState } from '../battle/battle-state.js';
import { RequestPayload } from '../sim/battle-runner.js';
import { CandidateGenerator, EvaluatedCandidateAction } from './candidate-generator.js';

export interface ScoredCandidateAction {
  candidate: EvaluatedCandidateAction;
  score: number;
  breakdown: string[];
}

export class BaselineEngine {
  /**
   * Evaluates all candidates and returns the highest scoring action.
   */
  public static selectBestAction(
    state: BattleState,
    request: RequestPayload
  ): ScoredCandidateAction {
    const candidates = CandidateGenerator.generateCandidates(state, request);
    if (candidates.length === 0) {
      throw new Error('No legal candidates generated for current request');
    }

    const scored = candidates.map(candidate => this.scoreCandidate(state, request, candidate));
    scored.sort((a, b) => b.score - a.score);

    return scored[0];
  }

  /**
   * Scores a single candidate action based on deterministic competitive heuristics.
   */
  public static scoreCandidate(
    state: BattleState,
    request: RequestPayload,
    candidate: EvaluatedCandidateAction
  ): ScoredCandidateAction {
    let score = 0;
    const breakdown: string[] = [];

    const isForcedSwitch = Boolean(request.forceSwitch && request.forceSwitch[0]);

    if (candidate.type === 'move') {
      const evalData = candidate.evaluation;

      // 1. Base damage value (average of min & max)
      const avgDamage = (evalData.minDamagePercent + evalData.maxDamagePercent) / 2;
      score += avgDamage;
      breakdown.push(`Base damage: +${avgDamage.toFixed(1)}`);

      // 2. High KO bonus
      if (evalData.koProbability > 0) {
        const koBonus = evalData.koProbability * 80;
        score += koBonus;
        breakdown.push(`KO probability (${Math.round(evalData.koProbability * 100)}%): +${koBonus.toFixed(1)}`);

        // Extra bonus if we outspeed and guarantee KO (guaranteed safe turn)
        if (evalData.outspeeds === true && evalData.koProbability >= 0.95) {
          score += 40;
          breakdown.push(`Guaranteed safe outspeed KO: +40`);
        }
      }

      // 3. Priority move bonus
      if (evalData.priority > 0) {
        const prioBonus = evalData.priority * 15;
        score += prioBonus;
        breakdown.push(`Priority (+${evalData.priority}): +${prioBonus}`);
      }

      // 4. Utility / Setup moves
      const moveId = candidate.choice.toLowerCase();
      if (moveId === 'stealthrock' && !state.field.p2Hazards.stealthRock) {
        score += 35;
        breakdown.push(`Set Stealth Rock: +35`);
      }
      if (moveId === 'spikes' && state.field.p2Hazards.spikes < 3) {
        score += 20;
        breakdown.push(`Set Spikes: +20`);
      }
      if (['swordsdance', 'nastyplot', 'calmmind', 'quiverdance', 'dragondance'].includes(moveId)) {
        if (state.p1.active && state.p1.active.hpPercent > 70) {
          score += 30;
          breakdown.push(`Setup move with high HP: +30`);
        }
      }

      // 5. Terastallization penalty (conserve Tera unless it secures high damage / KO)
      if (candidate.terastallize) {
        if (evalData.koProbability > 0.5) {
          score += 15;
          breakdown.push(`Tera secures lethal KO: +15`);
        } else {
          score -= 20;
          breakdown.push(`Conserve Tera: -20`);
        }
      }
    } else if (candidate.type === 'switch') {
      const evalData = candidate.evaluation;

      if (isForcedSwitch) {
        // When forced to switch, score based on health and safety
        const benchMon = state.p1.team.find(
          p => p.species.toLowerCase().replace(/[^a-z0-9]/g, '') === candidate.choice
        );
        const hp = benchMon ? benchMon.hpPercent : 100;
        score += hp;
        breakdown.push(`Forced switch health: +${hp}`);

        score -= evalData.hazardDamagePercent * 1.2;
        breakdown.push(`Hazard penalty: -${(evalData.hazardDamagePercent * 1.2).toFixed(1)}`);
      } else {
        // Voluntary switch
        score -= 10; // switching costs a turn of tempo
        breakdown.push(`Tempo cost: -10`);

        // Hazard penalty
        score -= evalData.hazardDamagePercent * 1.5;
        breakdown.push(`Hazard penalty: -${(evalData.hazardDamagePercent * 1.5).toFixed(1)}`);

        if (evalData.switchInSafety === 'safe') {
          score += 15;
          breakdown.push(`Safe switch-in: +15`);
        } else if (evalData.switchInSafety === 'risky') {
          score -= 25;
          breakdown.push(`Risky switch-in: -25`);
        } else if (evalData.switchInSafety === 'fatal') {
          score -= 100;
          breakdown.push(`Fatal switch-in: -100`);
        }
      }
    }

    return {
      candidate,
      score: Math.round(score * 10) / 10,
      breakdown
    };
  }
}
