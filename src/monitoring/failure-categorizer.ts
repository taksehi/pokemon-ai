import fs from 'node:fs';
import path from 'node:path';
import { RawExperienceRecord } from '../experience/experience-record.js';
import { EvaluatedCandidateAction } from '../strategy/candidate-generator.js';

export type FailureCategory =
  | 'repeated_move_mistakes'
  | 'bad_switches'
  | 'missed_kos'
  | 'bad_type_matchup_calls'
  | 'unnecessary_switches'
  | 'losses_to_predictable_patterns';

export interface FailureIncident {
  category: FailureCategory;
  battleId: string;
  turn: number;
  description: string;
  selectedAction: string;
  recommendedAction?: string;
  severity: 'low' | 'medium' | 'high';
}

export interface CycleFailureReport {
  cycleId: string;
  timestamp: string;
  totalExperiencesAnalyzed: number;
  totalFailuresDetected: number;
  categoryCounts: Record<FailureCategory, number>;
  incidents: FailureIncident[];
}

export interface CategoryDiff {
  category: FailureCategory;
  previousCount: number;
  currentCount: number;
  delta: number;
  trend: 'DECREASING' | 'INCREASING' | 'UNCHANGED';
  percentageChange: number;
}

export interface DiffableFailureReport {
  baselineCycleId: string;
  comparedCycleId: string;
  timestamp: string;
  totalFailuresBaseline: number;
  totalFailuresCompared: number;
  totalDelta: number;
  overallTrend: 'IMPROVED' | 'REGRESSED' | 'UNCHANGED';
  categoryDiffs: CategoryDiff[];
}

export interface TargetedTrainingCase {
  id: string;
  sourceCategory: FailureCategory;
  battleId: string;
  turn: number;
  state: any;
  correctAction: string;
  penalizedAction: string;
  targetReward: number;
  penaltyReward: number;
}

export class FailureCategorizer {
  /**
   * Automatically analyzes battle experiences and categorizes tactical mistakes.
   */
  public static analyzeExperiences(
    experiences: RawExperienceRecord[],
    cycleId: string = 'cycle'
  ): CycleFailureReport {
    const categoryCounts: Record<FailureCategory, number> = {
      repeated_move_mistakes: 0,
      bad_switches: 0,
      missed_kos: 0,
      bad_type_matchup_calls: 0,
      unnecessary_switches: 0,
      losses_to_predictable_patterns: 0
    };

    const incidents: FailureIncident[] = [];
    const moveHistoryPerBattle: Record<string, string[]> = {};

    for (let i = 0; i < experiences.length; i++) {
      const exp = experiences[i];
      const selected = exp.selected_action || '';
      const bId = exp.battleId || 'unknown';

      if (!moveHistoryPerBattle[bId]) moveHistoryPerBattle[bId] = [];
      moveHistoryPerBattle[bId].push(selected);

      const available = (exp.available_actions as EvaluatedCandidateAction[]) || [];
      const state = exp.state;
      const p1Active = state?.p1?.active;
      const p2Active = state?.p2?.active;

      // 1. MISSED KOS
      // Check if an available attack had 100% KO probability, but AI didn't use a KO move
      const lethalMove = available.find(
        a => a.type === 'move' && (a.evaluation.koProbability >= 1.0 || (p2Active && a.evaluation.minDamagePercent >= p2Active.hpPercent))
      );
      if (lethalMove && selected !== lethalMove.id) {
        // Did the selected action also achieve a KO?
        const chosenCandidate = available.find(a => a.id === selected);
        const chosenKO = chosenCandidate && chosenCandidate.type === 'move' && chosenCandidate.evaluation.koProbability >= 1.0;
        if (!chosenKO) {
          categoryCounts.missed_kos++;
          incidents.push({
            category: 'missed_kos',
            battleId: bId,
            turn: exp.turn,
            description: `Missed lethal KO: Opponent HP is ${p2Active?.hpPercent}%, ${lethalMove.name} guarantees KO but ${selected} was selected`,
            selectedAction: selected,
            recommendedAction: lethalMove.id,
            severity: 'high'
          });
        }
      }

      // 2. BAD TYPE MATCHUP CALLS
      // Attacking with 0x (immune) or 0.25x/0.5x when a 2x/4x super-effective move was available
      const chosenCand = available.find(a => a.id === selected);
      if (chosenCand && chosenCand.type === 'move') {
        const chosenEff = chosenCand.evaluation.typeEffectivenessAgainstOpponent ?? 1.0;
        const superMove = available.find(
          a => a.type === 'move' && (a.evaluation.typeEffectivenessAgainstOpponent ?? 1.0) >= 2.0
        );

        if (chosenEff === 0) {
          categoryCounts.bad_type_matchup_calls++;
          incidents.push({
            category: 'bad_type_matchup_calls',
            battleId: bId,
            turn: exp.turn,
            description: `Immunity Blunder: Selected ${chosenCand.name} (0x effectiveness) against ${p2Active?.species}`,
            selectedAction: selected,
            recommendedAction: superMove?.id,
            severity: 'high'
          });
        } else if (chosenEff < 1.0 && superMove) {
          categoryCounts.bad_type_matchup_calls++;
          incidents.push({
            category: 'bad_type_matchup_calls',
            battleId: bId,
            turn: exp.turn,
            description: `Resisted Attack Blunder: Selected ${chosenCand.name} (${chosenEff}x) while super-effective ${superMove.name} (${superMove.evaluation.typeEffectivenessAgainstOpponent}x) was available`,
            selectedAction: selected,
            recommendedAction: superMove.id,
            severity: 'medium'
          });
        }
      }

      // 3. BAD SWITCHES
      // Switching in a Pokémon that is fatal / takes massive damage or faints immediately
      if (chosenCand && chosenCand.type === 'switch') {
        if (chosenCand.evaluation.switchInSafety === 'fatal' || (chosenCand.evaluation.incomingMaxDamagePercent ?? 0) >= 75) {
          categoryCounts.bad_switches++;
          incidents.push({
            category: 'bad_switches',
            battleId: bId,
            turn: exp.turn,
            description: `Fatal Switch-in: Switched to slot ${chosenCand.slot} under fatal incoming pressure (expected damage: ${chosenCand.evaluation.incomingMaxDamagePercent}%)`,
            selectedAction: selected,
            severity: 'high'
          });
        }
      }

      // 4. UNNECESSARY SWITCHES
      // Switching when active has >85% HP, positive type/speed advantage, and opponent is threatening little
      if (chosenCand && chosenCand.type === 'switch' && !exp.result.terminal) {
        if (p1Active && p1Active.hpPercent >= 85 && (chosenCand.evaluation.hazardDamagePercent > 12)) {
          categoryCounts.unnecessary_switches++;
          incidents.push({
            category: 'unnecessary_switches',
            battleId: bId,
            turn: exp.turn,
            description: `Unnecessary Switch: Active ${p1Active.species} was at ${p1Active.hpPercent}% HP; switch suffered heavy hazard damage (${chosenCand.evaluation.hazardDamagePercent}%)`,
            selectedAction: selected,
            severity: 'low'
          });
        }
      }

      // 5. REPEATED MOVE MISTAKES
      // Using the exact same ineffective move 3+ turns in a row while opponent HP doesn't drop
      const recentMoves = moveHistoryPerBattle[bId].slice(-3);
      if (recentMoves.length === 3 && recentMoves.every(m => m === selected) && selected.startsWith('move')) {
        if (exp.reward <= 0) {
          categoryCounts.repeated_move_mistakes++;
          incidents.push({
            category: 'repeated_move_mistakes',
            battleId: bId,
            turn: exp.turn,
            description: `Repeated Move Ineffectiveness: AI repeated '${selected}' 3 consecutive turns without positive reward`,
            selectedAction: selected,
            severity: 'medium'
          });
        }
      }

      // 6. LOSSES TO PREDICTABLE PATTERNS
      // Active fainted while opponent has stat boosts >= +3
      if (p1Active?.fainted && p2Active?.boosts && (p2Active.boosts.atk >= 2 || p2Active.boosts.spa >= 2)) {
        categoryCounts.losses_to_predictable_patterns++;
        incidents.push({
          category: 'losses_to_predictable_patterns',
          battleId: bId,
          turn: exp.turn,
          description: `Setup Sweeper Loss: Fainted to boosted opponent (+${p2Active.boosts.atk || p2Active.boosts.spa} stat boost)`,
          selectedAction: selected,
          severity: 'medium'
        });
      }
    }

    const totalFailuresDetected = Object.values(categoryCounts).reduce((a, b) => a + b, 0);

    return {
      cycleId,
      timestamp: new Date().toISOString(),
      totalExperiencesAnalyzed: experiences.length,
      totalFailuresDetected,
      categoryCounts,
      incidents
    };
  }

  /**
   * Generates a diffable report comparing failure rates across two cycles.
   */
  public static compareCycleFailures(
    baseline: CycleFailureReport,
    compared: CycleFailureReport
  ): DiffableFailureReport {
    const categories: FailureCategory[] = [
      'repeated_move_mistakes',
      'bad_switches',
      'missed_kos',
      'bad_type_matchup_calls',
      'unnecessary_switches',
      'losses_to_predictable_patterns'
    ];

    const categoryDiffs: CategoryDiff[] = categories.map(cat => {
      const prev = baseline.categoryCounts[cat] || 0;
      const curr = compared.categoryCounts[cat] || 0;
      const delta = curr - prev;

      let trend: 'DECREASING' | 'INCREASING' | 'UNCHANGED' = 'UNCHANGED';
      if (delta < 0) trend = 'DECREASING';
      else if (delta > 0) trend = 'INCREASING';

      const pct = prev > 0 ? Number(((delta / prev) * 100).toFixed(1)) : (curr > 0 ? 100 : 0);

      return {
        category: cat,
        previousCount: prev,
        currentCount: curr,
        delta,
        trend,
        percentageChange: pct
      };
    });

    const totalDelta = compared.totalFailuresDetected - baseline.totalFailuresDetected;
    let overallTrend: 'IMPROVED' | 'REGRESSED' | 'UNCHANGED' = 'UNCHANGED';
    if (totalDelta < 0) overallTrend = 'IMPROVED';
    else if (totalDelta > 0) overallTrend = 'REGRESSED';

    return {
      baselineCycleId: baseline.cycleId,
      comparedCycleId: compared.cycleId,
      timestamp: new Date().toISOString(),
      totalFailuresBaseline: baseline.totalFailuresDetected,
      totalFailuresCompared: compared.totalFailuresDetected,
      totalDelta,
      overallTrend,
      categoryDiffs
    };
  }

  /**
   * Auto-converts categorized failures into new targeted training cases with counterfactual rewards.
   */
  public static autoConvertFailuresToTrainingCases(
    report: CycleFailureReport,
    experiences: RawExperienceRecord[]
  ): TargetedTrainingCase[] {
    const targetedCases: TargetedTrainingCase[] = [];

    for (const incident of report.incidents) {
      if (incident.category === 'missed_kos' || incident.category === 'bad_type_matchup_calls') {
        const matchingExp = experiences.find(
          e => e.battleId === incident.battleId && e.turn === incident.turn
        );

        if (matchingExp && incident.recommendedAction) {
          targetedCases.push({
            id: `case_${incident.category}_b${incident.battleId}_t${incident.turn}`,
            sourceCategory: incident.category,
            battleId: incident.battleId,
            turn: incident.turn,
            state: matchingExp.state,
            correctAction: incident.recommendedAction,
            penalizedAction: incident.selectedAction,
            targetReward: 5.0,  // Positive counterfactual reinforcement
            penaltyReward: -5.0 // Negative penalty
          });
        }
      }
    }

    return targetedCases;
  }
}
