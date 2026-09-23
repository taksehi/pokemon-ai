import { Dex } from '@pkmn/sim';
import { BattleState } from '../battle/battle-state.js';
import { RequestPayload } from '../sim/battle-runner.js';
import { CandidateGenerator, EvaluatedCandidateAction } from './candidate-generator.js';

function getGenNumber(format?: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  if (!format) return 9;
  const match = format.match(/^gen(\d+)/i);
  const n = match ? parseInt(match[1], 10) : 9;
  return (n >= 1 && n <= 9 ? n : 9) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

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
    const p1Active = state.p1.active;
    const p2Active = state.p2.active;

    if (candidate.type === 'move') {
      const evalData = candidate.evaluation;

      // 1. Base damage value (average of min & max)
      const avgDamage = (evalData.minDamagePercent + evalData.maxDamagePercent) / 2;
      score += avgDamage;
      breakdown.push(`Base damage: +${avgDamage.toFixed(1)}`);

      // 2. Type effectiveness against current opponent
      if (evalData.typeEffectivenessAgainstOpponent !== undefined) {
        if (evalData.typeEffectivenessAgainstOpponent === 0) {
          score -= 150;
          breakdown.push(`Immune: Opponent is immune to ${candidate.name} (0x): -150`);
        } else if (evalData.typeEffectivenessAgainstOpponent >= 4.0) {
          score += 45;
          breakdown.push(`Double super-effective (4x): +45`);
        } else if (evalData.typeEffectivenessAgainstOpponent >= 2.0) {
          score += 25;
          breakdown.push(`Super-effective (2x): +25`);
        } else if (evalData.typeEffectivenessAgainstOpponent <= 0.25) {
          score -= 35;
          breakdown.push(`Double resisted (0.25x): -35`);
        } else if (evalData.typeEffectivenessAgainstOpponent <= 0.5) {
          score -= 20;
          breakdown.push(`Resisted (0.5x): -20`);
        }
      }

      // Active matchup context: penalize staying in with a weak attack if active matchup is unfavorable
      const activeMatchup = CandidateGenerator.evaluateActiveMatchup(state);
      if (
        activeMatchup.isUnfavorable &&
        evalData.maxDamagePercent < 35 &&
        (!evalData.typeEffectivenessAgainstOpponent || evalData.typeEffectivenessAgainstOpponent <= 1.0)
      ) {
        score -= 25;
        breakdown.push(`Unfavorable active matchup with weak offensive output: -25`);
      }

      // 3. High KO bonus
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

      // 4. Opponent Threat Response & Priority moves
      if (evalData.opponentThreatensKO) {
        if (evalData.priority > 0) {
          if (evalData.koProbability >= 0.8) {
            score += 60;
            breakdown.push(`Lethal priority move beats opponent before they KO us: +60`);
          } else if (evalData.maxDamagePercent >= 30) {
            score += 25;
            breakdown.push(`Priority move deals significant damage before fainting: +25`);
          } else {
            score += 10;
            breakdown.push(`Priority move deals minor chip damage before fainting: +10`);
          }
        } else if (evalData.outspeeds === true && evalData.koProbability >= 0.95) {
          // Outspeed KO already handled above
        } else {
          score -= 50;
          breakdown.push(`Imminent faint: slower attack may not execute: -50`);
        }
      } else if (evalData.priority > 0) {
        const prioBonus = evalData.priority * 15;
        score += prioBonus;
        breakdown.push(`Priority (+${evalData.priority}): +${prioBonus}`);
      }

      // 4. Utility / Setup moves & Status Immunities
      const moveId = candidate.choice.toLowerCase();
      if (moveId === 'stealthrock' && !state.field.p2Hazards.stealthRock) {
        score += 35;
        breakdown.push(`Set Stealth Rock: +35`);
      }
      if (moveId === 'spikes' && state.field.p2Hazards.spikes < 3) {
        score += 20;
        breakdown.push(`Set Spikes: +20`);
      }

      // Stat setup moves
      if (['swordsdance', 'nastyplot', 'calmmind', 'quiverdance', 'dragondance'].includes(moveId)) {
        if (evalData.opponentThreatensKO) {
          score -= 60;
          breakdown.push(`Cannot setup under lethal KO threat: -60`);
        } else if (p1Active) {
          const isAtkSetup = moveId === 'swordsdance' || moveId === 'dragondance';
          const isSpaSetup = moveId === 'nastyplot' || moveId === 'calmmind' || moveId === 'quiverdance';
          if ((isAtkSetup && p1Active.boosts.atk >= 4) || (isSpaSetup && p1Active.boosts.spa >= 4)) {
            score -= 60;
            breakdown.push(`Stat boost already saturated (>= +4): -60`);
          } else if (p1Active.hpPercent > 70) {
            score += 30;
            breakdown.push(`Setup move with high HP: +30`);
          }
        }
      }

      // Healing moves (essential across all gens, especially GSC Gen 2)
      if (['recover', 'roost', 'slackoff', 'softboiled', 'milkdrink', 'rest', 'synthesis', 'morningsun', 'moonlight', 'strengthsap', 'wish'].includes(moveId)) {
        if (p1Active) {
          if (evalData.opponentThreatensKO) {
            score -= 40;
            breakdown.push(`Healing insufficient against lethal attack: -40`);
          } else if (p1Active.hpPercent < 50) {
            score += 65;
            breakdown.push(`Critical recovery at low HP (<50%): +65`);
          } else if (p1Active.hpPercent < 75) {
            score += 30;
            breakdown.push(`Sustain recovery at medium HP (<75%): +30`);
          }
        }
      }

      // Crippling status affliction with type immunity checks
      if (['willowisp', 'thunderwave', 'toxic', 'glare', 'spore', 'sleeppowder', 'yawn'].includes(moveId)) {
        if (p2Active) {
          const genNum = getGenNumber(state.format);
          const dex = Dex.forGen(genNum);
          const oppSpecies = dex.species.get(p2Active.species);
          const oppTypes = p2Active.terastallized && p2Active.teraType
            ? [p2Active.teraType]
            : (oppSpecies?.types || []);

          if (p2Active.status) {
            score -= 50;
            breakdown.push(`Opponent already has status (${p2Active.status}): -50`);
          } else if (moveId === 'thunderwave' && (oppTypes.includes('Ground') || oppTypes.includes('Electric'))) {
            score -= 100;
            breakdown.push(`Immune: Ground/Electric immune to Thunder Wave: -100`);
          } else if (moveId === 'toxic' && (oppTypes.includes('Poison') || oppTypes.includes('Steel'))) {
            score -= 100;
            breakdown.push(`Immune: Poison/Steel immune to Toxic: -100`);
          } else if (moveId === 'willowisp' && oppTypes.includes('Fire')) {
            score -= 100;
            breakdown.push(`Immune: Fire type immune to burn: -100`);
          } else {
            score += 40;
            breakdown.push(`Inflict crippling status condition: +40`);
          }
        }
      }

      // Entry hazard removal
      if (['rapidspin', 'defog', 'mortalspin', 'courtchange'].includes(moveId)) {
        const hazardCount =
          (state.field.p1Hazards.stealthRock ? 1 : 0) +
          state.field.p1Hazards.spikes +
          state.field.p1Hazards.toxicSpikes;
        if (hazardCount > 0) {
          score += hazardCount * 25;
          breakdown.push(`Hazard removal (${hazardCount} hazards): +${hazardCount * 25}`);
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

      // Check if active Pokemon is threatened with lethal outspeed KO
      const activeIsThreatened = Boolean(
        p1Active &&
        p2Active &&
        CandidateGenerator.calculateOpponentThreat(
          state,
          p1Active.species,
          p1Active.level,
          p1Active.item,
          p1Active.ability,
          p1Active.boosts,
          undefined,
          p1Active.hpPercent
        ).opponentThreatensKO
      );

      if (isForcedSwitch) {
        // When forced to switch, evaluate health, type resistance, and offensive counter
        const benchMon = state.p1.team.find(
          p => p.species.toLowerCase().replace(/[^a-z0-9]/g, '') === candidate.choice
        );
        const hp = benchMon ? benchMon.hpPercent : 100;
        score += hp * 0.4;
        breakdown.push(`Forced switch health: +${(hp * 0.4).toFixed(1)}`);

        // Defensive resistance bonus
        if (evalData.typeResistanceAgainstOpponent !== undefined) {
          if (evalData.typeResistanceAgainstOpponent <= 0.5) {
            score += 35;
            breakdown.push(`Defensive resistance to opponent STAB (${evalData.typeResistanceAgainstOpponent}x): +35`);
          } else if (evalData.typeResistanceAgainstOpponent >= 1.5) {
            score -= 30;
            breakdown.push(`Weakness to opponent STAB (${evalData.typeResistanceAgainstOpponent}x): -30`);
          }
        }

        // Offensive counter bonus
        if (evalData.typeEffectivenessAgainstOpponent && evalData.typeEffectivenessAgainstOpponent >= 2.0) {
          score += 25;
          breakdown.push(`Super-effective counter matchup (${evalData.typeEffectivenessAgainstOpponent}x): +25`);
        }

        // Safety ratings
        if (evalData.switchInSafety === 'fatal') {
          score -= 100;
          breakdown.push(`Fatal switch-in: -100`);
        } else if (evalData.switchInSafety === 'risky') {
          score -= 30;
          breakdown.push(`Risky switch-in: -30`);
        } else if (evalData.switchInSafety === 'safe') {
          score += 20;
          breakdown.push(`Safe switch-in: +20`);
        }

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
          score += 20;
          breakdown.push(`Safe switch-in: +20`);
        } else if (evalData.switchInSafety === 'risky') {
          score -= 35;
          breakdown.push(`Risky switch-in: -35`);
        } else if (evalData.switchInSafety === 'fatal') {
          score -= 120;
          breakdown.push(`Fatal switch-in: -120`);
        }

        // Defensive resistance bonus
        if (evalData.typeResistanceAgainstOpponent !== undefined) {
          if (evalData.typeResistanceAgainstOpponent <= 0.5) {
            score += 30;
            breakdown.push(`Resists opponent STAB (${evalData.typeResistanceAgainstOpponent}x): +30`);
          } else if (evalData.typeResistanceAgainstOpponent >= 1.5) {
            score -= 35;
            breakdown.push(`Weak to opponent STAB (${evalData.typeResistanceAgainstOpponent}x): -35`);
          }
        }

        // Offensive counter bonus
        if (evalData.typeEffectivenessAgainstOpponent && evalData.typeEffectivenessAgainstOpponent >= 2.0) {
          score += 20;
          breakdown.push(`Offensive advantage (${evalData.typeEffectivenessAgainstOpponent}x): +20`);
        }

        // Pivoting away when active Pokemon faces imminent KO or unfavorable matchup
        const activeMatchup = CandidateGenerator.evaluateActiveMatchup(state);

        if (activeIsThreatened || activeMatchup.isUnfavorable) {
          if (evalData.switchInSafety === 'safe') {
            if (evalData.typeResistanceAgainstOpponent !== undefined && evalData.typeResistanceAgainstOpponent <= 0.75) {
              score += 55;
              breakdown.push(`Favorable defensive pivot: active mon has poor matchup, switch-in resists opponent STAB (${evalData.typeResistanceAgainstOpponent}x): +55`);
            } else if (evalData.typeEffectivenessAgainstOpponent && evalData.typeEffectivenessAgainstOpponent >= 2.0) {
              score += 50;
              breakdown.push(`Favorable offensive pivot: active mon has poor matchup, switch-in counters opponent (${evalData.typeEffectivenessAgainstOpponent}x): +50`);
            } else {
              score += 40;
              breakdown.push(`Defensive pivot saves active Pokémon from unfavorable matchup: +40`);
            }
          } else if (evalData.switchInSafety === 'risky') {
            if (evalData.typeResistanceAgainstOpponent !== undefined && evalData.typeResistanceAgainstOpponent <= 0.75) {
              score += 35;
              breakdown.push(`Resistance pivot saves team against unfavorable matchup (${evalData.typeResistanceAgainstOpponent}x): +35`);
            } else {
              score += 10;
              breakdown.push(`Emergency pivot under threat: +10`);
            }
          }
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
