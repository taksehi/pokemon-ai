import { BattleState } from './battle-state.js';
import { EvaluatedCandidateAction } from '../strategy/candidate-generator.js';

export interface StateDiffReport {
  turn: number;
  action: string;
  isActionLegal: boolean;
  legalActionsCount: number;
  isValid: boolean;
  errors: string[];
  diffs: string[];
}

export class StateDiffValidator {
  /**
   * Validates action legality and simulator state transitions before and after simulator execution.
   */
  public static validateTurnTransition(
    turn: number,
    stateBefore: BattleState,
    stateAfter: BattleState,
    chosenActionId: string,
    availableActions: EvaluatedCandidateAction[],
    rawLines: string[]
  ): StateDiffReport {
    const errors: string[] = [];
    const diffs: string[] = [];

    // 1. Action Legality: Chosen action MUST be present in availableActions
    const isActionLegal = availableActions.some(a => a.id === chosenActionId);
    if (!isActionLegal) {
      errors.push(
        `Illegal action chosen: "${chosenActionId}". Available legal actions: [${availableActions.map(a => a.id).join(', ')}]`
      );
    }

    // 2. Simulator Protocol Errors: rawLines must not contain |error|
    for (const line of rawLines) {
      if (line.startsWith('|error|')) {
        errors.push(`Simulator protocol error: ${line}`);
      }
    }

    // 3. Turn Progression: Monotonically non-decreasing
    if (stateAfter.turn < stateBefore.turn) {
      errors.push(`Turn decreased from ${stateBefore.turn} to ${stateAfter.turn}`);
    } else if (stateAfter.turn > stateBefore.turn) {
      diffs.push(`Turn: ${stateBefore.turn} -> ${stateAfter.turn}`);
    }

    // 4. Invariants Check: HP and status bounds
    for (const [sideName, side] of [['P1', stateAfter.p1], ['P2', stateAfter.p2]] as const) {
      if (side.active) {
        if (side.active.hpPercent < 0 || side.active.hpPercent > 100) {
          errors.push(`${sideName} active ${side.active.species} invalid HP: ${side.active.hpPercent}%`);
        }
        if (side.active.fainted && side.active.hpPercent !== 0) {
          errors.push(
            `${sideName} active ${side.active.species} marked fainted with non-zero HP (${side.active.hpPercent}%)`
          );
        }
      }
    }

    // 5. State Diffs: Active Pokémon HP, Status, Switches
    if (stateBefore.p1.active && stateAfter.p1.active) {
      const b = stateBefore.p1.active;
      const a = stateAfter.p1.active;
      if (b.species === a.species) {
        if (b.hpPercent !== a.hpPercent) {
          diffs.push(`P1 ${a.species} HP: ${b.hpPercent}% -> ${a.hpPercent}%`);
        }
        if (b.status !== a.status) {
          diffs.push(`P1 ${a.species} status: ${b.status || 'healthy'} -> ${a.status || 'healthy'}`);
        }
      } else {
        diffs.push(`P1 switched: ${b.species} -> ${a.species} (${a.hpPercent}%)`);
      }
    } else if (!stateBefore.p1.active && stateAfter.p1.active) {
      diffs.push(`P1 sent out: ${stateAfter.p1.active.species} (${stateAfter.p1.active.hpPercent}%)`);
    }

    if (stateBefore.p2.active && stateAfter.p2.active) {
      const b = stateBefore.p2.active;
      const a = stateAfter.p2.active;
      if (b.species === a.species) {
        if (b.hpPercent !== a.hpPercent) {
          diffs.push(`P2 ${a.species} HP: ${b.hpPercent}% -> ${a.hpPercent}%`);
        }
        if (b.status !== a.status) {
          diffs.push(`P2 ${a.species} status: ${b.status || 'healthy'} -> ${a.status || 'healthy'}`);
        }
      } else {
        diffs.push(`P2 switched: ${b.species} -> ${a.species} (${a.hpPercent}%)`);
      }
    } else if (!stateBefore.p2.active && stateAfter.p2.active) {
      diffs.push(`P2 sent out: ${stateAfter.p2.active.species} (${stateAfter.p2.active.hpPercent}%)`);
    }

    // Field & Hazard Diffs
    if (stateBefore.field.weather !== stateAfter.field.weather) {
      diffs.push(`Weather: ${stateBefore.field.weather || 'None'} -> ${stateAfter.field.weather || 'None'}`);
    }
    if (stateBefore.field.terrain !== stateAfter.field.terrain) {
      diffs.push(`Terrain: ${stateBefore.field.terrain || 'None'} -> ${stateAfter.field.terrain || 'None'}`);
    }
    if (stateBefore.field.p1Hazards.stealthRock !== stateAfter.field.p1Hazards.stealthRock) {
      diffs.push(`P1 Stealth Rock: ${stateAfter.field.p1Hazards.stealthRock ? 'Active' : 'Cleared'}`);
    }
    if (stateBefore.field.p2Hazards.stealthRock !== stateAfter.field.p2Hazards.stealthRock) {
      diffs.push(`P2 Stealth Rock: ${stateAfter.field.p2Hazards.stealthRock ? 'Active' : 'Cleared'}`);
    }
    if (stateBefore.field.p1Hazards.spikes !== stateAfter.field.p1Hazards.spikes) {
      diffs.push(`P1 Spikes: ${stateBefore.field.p1Hazards.spikes} -> ${stateAfter.field.p1Hazards.spikes}`);
    }
    if (stateBefore.field.p2Hazards.spikes !== stateAfter.field.p2Hazards.spikes) {
      diffs.push(`P2 Spikes: ${stateBefore.field.p2Hazards.spikes} -> ${stateAfter.field.p2Hazards.spikes}`);
    }

    // Protocol event consistency checks (evaluate against the final event of each type in the turn)
    const lastWeatherLine = [...rawLines].reverse().find(l => l.trim().startsWith('|-weather|'));
    if (lastWeatherLine) {
      const parts = lastWeatherLine.trim().split('|').slice(1);
      const expected = parts[1] === 'none' ? null : parts[1];
      if (stateAfter.field.weather !== expected) {
        errors.push(`Weather state mismatch: expected ${expected}, got ${stateAfter.field.weather}`);
      }
    }

    const lastTerrainLine = [...rawLines].reverse().find(
      l => l.trim().startsWith('|-fieldstart|') || l.trim().startsWith('|-fieldend|')
    );
    if (lastTerrainLine) {
      const trimmed = lastTerrainLine.trim();
      if (trimmed.startsWith('|-fieldstart|')) {
        const parts = trimmed.split('|').slice(1);
        if (parts[1]?.includes('Terrain')) {
          const expected = parts[1].replace('move: ', '');
          if (stateAfter.field.terrain !== expected) {
            errors.push(`Terrain state mismatch: expected ${expected}, got ${stateAfter.field.terrain}`);
          }
        }
      } else if (trimmed.startsWith('|-fieldend|')) {
        const parts = trimmed.split('|').slice(1);
        if (parts[1]?.includes('Terrain')) {
          if (stateAfter.field.terrain !== null) {
            errors.push(`Terrain state mismatch: expected null, got ${stateAfter.field.terrain}`);
          }
        }
      }
    }


    return {
      turn,
      action: chosenActionId,
      isActionLegal,
      legalActionsCount: availableActions.length,
      isValid: errors.length === 0,
      errors,
      diffs
    };
  }
}
