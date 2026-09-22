import { Dex } from '@pkmn/sim';
import { Generations, Pokemon as CalcPokemon, Move as CalcMove, calculate } from '@smogon/calc';
import { BattleState, BoostTable } from '../battle/battle-state.js';
import { RequestPayload } from '../sim/battle-runner.js';

const gen9 = Generations.get(9);
const dexGen9 = Dex.forGen(9);

export interface CandidateEvaluation {
  minDamagePercent: number;
  maxDamagePercent: number;
  koProbability: number;
  outspeeds: boolean | 'speed_tie' | 'unknown';
  priority: number;
  hazardDamagePercent: number;
  switchInSafety?: 'safe' | 'risky' | 'fatal';
  description: string;
}

export interface EvaluatedCandidateAction {
  id: string; // e.g. "move 1", "move 1 terastallize", "switch 3"
  type: 'move' | 'switch';
  choice: string; // e.g. "shadowball" or "gholdengo"
  name: string; // e.g. "Shadow Ball" or "Gholdengo"
  slot: number; // 1-based index
  terastallize?: boolean;
  evaluation: CandidateEvaluation;
}

export class CandidateGenerator {
  /**
   * Generates all legal candidate actions from the current state and request payload,
   * annotating each action with deterministic calculations.
   */
  public static generateCandidates(
    state: BattleState,
    request: RequestPayload
  ): EvaluatedCandidateAction[] {
    const candidates: EvaluatedCandidateAction[] = [];

    // 1. Generate Move Candidates (if active and not forced to switch)
    if (request.active && request.active[0] && !request.forceSwitch) {
      const activeInfo = request.active[0];
      const moves = activeInfo.moves;
      const canTera = Boolean(activeInfo.canTerastallize);

      moves.forEach((m, idx) => {
        const slot = idx + 1;
        // If move is disabled or out of PP, it is illegal
        if (m.disabled || m.pp === 0) return;

        // Normal move candidate
        const normalEval = this.evaluateMove(state, m.id, false);
        candidates.push({
          id: `move ${slot}`,
          type: 'move',
          choice: m.id,
          name: m.move,
          slot,
          terastallize: false,
          evaluation: normalEval
        });

        // Terastallize move candidate (if available)
        if (canTera) {
          const teraEval = this.evaluateMove(state, m.id, true);
          candidates.push({
            id: `move ${slot} terastallize`,
            type: 'move',
            choice: m.id,
            name: `${m.move} [Terastallize]`,
            slot,
            terastallize: true,
            evaluation: teraEval
          });
        }
      });
    }

    // 2. Generate Switch Candidates
    if (request.side && request.side.pokemon) {
      request.side.pokemon.forEach((p, idx) => {
        const slot = idx + 1;
        // Cannot switch into currently active Pokémon or fainted Pokémon
        if (p.active) return;
        if (p.condition.endsWith(' fnt') || p.condition === '0 fnt') return;

        const switchEval = this.evaluateSwitch(state, p.ident, slot);
        const speciesName = p.details.split(',')[0].trim();

        candidates.push({
          id: `switch ${slot}`,
          type: 'switch',
          choice: speciesName.toLowerCase().replace(/[^a-z0-9]/g, ''),
          name: speciesName,
          slot,
          evaluation: switchEval
        });
      });
    }

    return candidates;
  }

  private static evaluateMove(
    state: BattleState,
    moveId: string,
    isTerastallizing: boolean
  ): CandidateEvaluation {
    const p1Active = state.p1.active;
    const p2Active = state.p2.active;

    const dexMove = dexGen9.moves.get(moveId);
    const priority = dexMove?.priority ?? 0;

    let minDamagePercent = 0;
    let maxDamagePercent = 0;
    let koProbability = 0;
    let outspeeds: boolean | 'speed_tie' | 'unknown' = 'unknown';

    if (!p1Active || !p2Active) {
      return {
        minDamagePercent,
        maxDamagePercent,
        koProbability,
        outspeeds,
        priority,
        hazardDamagePercent: 0,
        description: `${dexMove?.name || moveId} (No active opponent)`
      };
    }

    // Speed calculation
    const p1Speed = this.calculateEffectiveSpeed(p1Active.stats.spe, p1Active.boosts.spe);
    // In random battles or standard formats, approximate opponent speed
    const oppBaseSpeed = dexGen9.species.get(p2Active.species)?.baseStats.spe || 100;
    const oppApproxSpeed = this.calculateEffectiveSpeed(
      Math.floor(((2 * oppBaseSpeed + 31 + 21) * p2Active.level) / 100 + 5),
      p2Active.boosts.spe
    );

    if (priority > 0) {
      outspeeds = true;
    } else if (priority < 0) {
      outspeeds = false;
    } else {
      if (p1Speed > oppApproxSpeed) outspeeds = true;
      else if (p1Speed < oppApproxSpeed) outspeeds = false;
      else outspeeds = 'speed_tie';
    }

    // Damage calculation if damaging move
    if (dexMove && dexMove.category !== 'Status' && (dexMove.basePower > 0 || dexMove.basePowerCallback)) {
      try {
        const attackerItem = p1Active.item ? dexGen9.items.get(p1Active.item)?.name || p1Active.item : undefined;
        const attackerAbility = p1Active.ability ? dexGen9.abilities.get(p1Active.ability)?.name || p1Active.ability : undefined;

        const defenderItem = p2Active.revealedItem ? dexGen9.items.get(p2Active.revealedItem)?.name || p2Active.revealedItem : undefined;
        const defenderAbility = p2Active.revealedAbility ? dexGen9.abilities.get(p2Active.revealedAbility)?.name || p2Active.revealedAbility : undefined;

        const attacker = new CalcPokemon(gen9, p1Active.species, {
          level: p1Active.level,
          item: attackerItem,
          ability: attackerAbility,
          boosts: {
            atk: p1Active.boosts.atk,
            def: p1Active.boosts.def,
            spa: p1Active.boosts.spa,
            spd: p1Active.boosts.spd,
            spe: p1Active.boosts.spe
          },
          teraType: isTerastallizing && p1Active.teraType ? (p1Active.teraType as any) : undefined
        });

        const defender = new CalcPokemon(gen9, p2Active.species, {
          level: p2Active.level,
          item: defenderItem,
          ability: defenderAbility,
          boosts: {
            atk: p2Active.boosts.atk,
            def: p2Active.boosts.def,
            spa: p2Active.boosts.spa,
            spd: p2Active.boosts.spd,
            spe: p2Active.boosts.spe
          },
          teraType: p2Active.terastallized && p2Active.teraType ? (p2Active.teraType as any) : undefined
        });

        const calcMove = new CalcMove(gen9, dexMove.name);
        const result = calculate(gen9, attacker, defender, calcMove);

        const range = result.range();
        const defenderMaxHp = defender.maxHP();

        minDamagePercent = Math.round((range[0] / defenderMaxHp) * 1000) / 10;
        maxDamagePercent = Math.round((range[1] / defenderMaxHp) * 1000) / 10;

        // Calculate KO chance against current remaining HP percentage
        const remainingHpAbs = Math.ceil((p2Active.hpPercent / 100) * defenderMaxHp);
        const damageRolls: number[] = Array.isArray(result.damage)
          ? (result.damage as number[])
          : [result.damage as number];

        const koRollCount = damageRolls.filter(d => typeof d === 'number' && d >= remainingHpAbs).length;
        koProbability = Math.round((koRollCount / damageRolls.length) * 100) / 100;
      } catch (err) {
        // Fallback for custom or unmapped moves
        minDamagePercent = 0;
        maxDamagePercent = 0;
      }
    }

    const speedDesc = outspeeds === true ? 'We outspeed' : outspeeds === false ? 'Slower' : 'Speed tie';
    const damageDesc =
      maxDamagePercent > 0
        ? `${minDamagePercent}% - ${maxDamagePercent}% (KO chance: ${Math.round(koProbability * 100)}%)`
        : 'Status / 0 dmg';

    return {
      minDamagePercent,
      maxDamagePercent,
      koProbability,
      outspeeds,
      priority,
      hazardDamagePercent: 0,
      description: `${dexMove?.name || moveId}: ${damageDesc} [${speedDesc}]`
    };
  }

  private static evaluateSwitch(
    state: BattleState,
    ident: string,
    slot: number
  ): CandidateEvaluation {
    const p1Mon = state.p1.team.find(p => p.ident === ident || p.species === ident.split(':').pop()?.trim());
    const hazards = state.field.p1Hazards;

    let hazardDamagePercent = 0;

    if (p1Mon) {
      const hasBoots = p1Mon.item === 'heavydutyboots';
      if (!hasBoots) {
        // Stealth Rock calculation based on Rock effectiveness
        if (hazards.stealthRock) {
          const rockEffectiveness = this.getRockEffectiveness(p1Mon.species);
          hazardDamagePercent += 12.5 * rockEffectiveness;
        }
        // Spikes calculation
        if (hazards.spikes > 0) {
          const isGrounded = this.isGrounded(p1Mon.species);
          if (isGrounded) {
            const spikeDmg = hazards.spikes === 1 ? 12.5 : hazards.spikes === 2 ? 16.6 : 25;
            hazardDamagePercent += spikeDmg;
          }
        }
      }
    }

    hazardDamagePercent = Math.round(hazardDamagePercent * 10) / 10;

    let switchInSafety: 'safe' | 'risky' | 'fatal' = 'safe';
    if (hazardDamagePercent >= (p1Mon ? p1Mon.hpPercent : 100)) {
      switchInSafety = 'fatal';
    } else if (hazardDamagePercent > 25) {
      switchInSafety = 'risky';
    }

    return {
      minDamagePercent: 0,
      maxDamagePercent: 0,
      koProbability: 0,
      outspeeds: 'unknown',
      priority: 0,
      hazardDamagePercent,
      switchInSafety,
      description: `Switch into ${p1Mon?.species || ident} (Hazards: -${hazardDamagePercent}%, Safety: ${switchInSafety})`
    };
  }

  private static calculateEffectiveSpeed(baseSpeed: number, boost: number): number {
    const multiplier =
      boost > 0
        ? (2 + boost) / 2
        : boost < 0
        ? 2 / (2 - boost)
        : 1;
    return Math.floor(baseSpeed * multiplier);
  }

  private static getRockEffectiveness(speciesName: string): number {
    const species = dexGen9.species.get(speciesName);
    if (!species) return 1.0;

    let mult = 1.0;
    for (const type of species.types) {
      const typeData = dexGen9.types.get(type);
      if (typeData && typeData.damageTaken) {
        // In Showdown damageTaken: 1 = weak (2x), 2 = resist (0.5x), 3 = immune (0x), 0 = neutral (1x)
        const dt = typeData.damageTaken['Rock'];
        if (dt === 1) mult *= 2;
        else if (dt === 2) mult *= 0.5;
        else if (dt === 3) mult *= 0;
      }
    }
    return mult;
  }

  private static isGrounded(speciesName: string): boolean {
    const species = dexGen9.species.get(speciesName);
    if (!species) return true;
    if (species.types.includes('Flying')) return false;
    return true;
  }
}
