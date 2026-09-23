import { Dex } from '@pkmn/sim';
import { Generations, Pokemon as CalcPokemon, Move as CalcMove, calculate } from '@smogon/calc';
import { BattleState, BoostTable } from '../battle/battle-state.js';
import { RequestPayload } from '../sim/battle-runner.js';

function getGenNumber(format?: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  if (!format) return 9;
  const match = format.match(/^gen(\d+)/i);
  const n = match ? parseInt(match[1], 10) : 9;
  return (n >= 1 && n <= 9 ? n : 9) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface CandidateEvaluation {
  minDamagePercent: number;
  maxDamagePercent: number;
  koProbability: number;
  outspeeds: boolean | 'speed_tie' | 'unknown';
  priority: number;
  hazardDamagePercent: number;
  switchInSafety?: 'safe' | 'risky' | 'fatal';
  description: string;
  incomingMaxDamagePercent?: number;
  opponentThreatensKO?: boolean;
  typeEffectivenessAgainstOpponent?: number;
  typeResistanceAgainstOpponent?: number;
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

        // Terastallized variant (if mechanic is available in current gen and active pokemon can tera)
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

    // 2. Generate Switch Candidates (if forced or optional switches are legal)
    if (request.side && request.side.pokemon) {
      request.side.pokemon.forEach((p, idx) => {
        const slot = idx + 1;
        // Can't switch into currently active Pokémon or fainted Pokémon
        if (p.active || p.condition.endsWith('fnt') || p.condition === '0 fnt') return;

        const switchEval = this.evaluateSwitch(state, p.ident);
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

    const genNum = getGenNumber(state.format);
    const gen = Generations.get(genNum);
    const dex = Dex.forGen(genNum);

    const dexMove = dex.moves.get(moveId);
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
        incomingMaxDamagePercent: 0,
        opponentThreatensKO: false,
        description: `${dexMove?.name || moveId} (No active opponent)`
      };
    }

    // Speed calculation
    const p1Speed = this.calculateEffectiveSpeed(p1Active.stats.spe, p1Active.boosts.spe);
    // In random battles or standard formats, approximate opponent speed
    const oppBaseSpeed = dex.species.get(p2Active.species)?.baseStats.spe || 100;
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
        const attackerItem = p1Active.item ? dex.items.get(p1Active.item)?.name || p1Active.item : undefined;
        const attackerAbility = p1Active.ability ? dex.abilities.get(p1Active.ability)?.name || p1Active.ability : undefined;

        const defenderItem = p2Active.revealedItem ? dex.items.get(p2Active.revealedItem)?.name || p2Active.revealedItem : undefined;
        const defenderAbility = p2Active.revealedAbility ? dex.abilities.get(p2Active.revealedAbility)?.name || p2Active.revealedAbility : undefined;

        const attacker = new CalcPokemon(gen, p1Active.species, {
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

        const defender = new CalcPokemon(gen, p2Active.species, {
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

        const calcMove = new CalcMove(gen, dexMove.name);
        const result = calculate(gen, attacker, defender, calcMove);

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

    // Symmetrical calculation: Calculate opponent threat against our active Pokemon
    const incomingThreat = this.calculateOpponentThreat(
      state,
      p1Active.species,
      p1Active.level,
      p1Active.item,
      p1Active.ability,
      p1Active.boosts,
      isTerastallizing && p1Active.teraType ? p1Active.teraType : undefined,
      p1Active.hpPercent
    );

    const speedDesc = outspeeds === true ? 'We outspeed' : outspeeds === false ? 'Slower' : 'Speed tie';
    const damageDesc =
      maxDamagePercent > 0
        ? `Damage: ${minDamagePercent}%-${maxDamagePercent}% (KO: ${Math.round(koProbability * 100)}%)`
        : 'Status move';
    const threatDesc = incomingThreat.opponentThreatensKO
      ? ' | Imminent KO threat!'
      : incomingThreat.maxIncomingDamagePercent > 0
      ? ` | Threat: ${incomingThreat.maxIncomingDamagePercent}%`
      : '';

    return {
      minDamagePercent,
      maxDamagePercent,
      koProbability,
      outspeeds,
      priority,
      hazardDamagePercent: 0,
      incomingMaxDamagePercent: incomingThreat.maxIncomingDamagePercent,
      opponentThreatensKO: incomingThreat.opponentThreatensKO,
      description: `${dexMove?.name || moveId} | ${damageDesc} | ${speedDesc} (Pri: ${priority})${threatDesc}`
    };
  }

  private static evaluateSwitch(
    state: BattleState,
    ident: string
  ): CandidateEvaluation {
    const hazards = state.field.p1Hazards;
    const p1Mon = state.p1.team.find(p => p.ident === ident);
    const genNum = getGenNumber(state.format);
    const dex = Dex.forGen(genNum);

    let hazardDamagePercent = 0;

    if (p1Mon) {
      const hasBoots = p1Mon.item === 'heavydutyboots';
      if (!hasBoots) {
        // Stealth Rock calculation based on Rock effectiveness
        if (hazards.stealthRock) {
          const rockEffectiveness = this.getRockEffectiveness(p1Mon.species, dex);
          hazardDamagePercent += 12.5 * rockEffectiveness;
        }
        // Spikes calculation (Gen 2: 1 layer = 12.5%; Gen 3+: 1=12.5%, 2=16.6%, 3=25%)
        if (hazards.spikes > 0) {
          const isGrounded = this.isGrounded(p1Mon.species, dex);
          if (isGrounded) {
            const spikeDmg = genNum === 2 ? 12.5 : (hazards.spikes === 1 ? 12.5 : hazards.spikes === 2 ? 16.6 : 25);
            hazardDamagePercent += spikeDmg;
          }
        }
      }
    }

    hazardDamagePercent = Math.round(hazardDamagePercent * 10) / 10;
    const remainingHp = p1Mon ? p1Mon.hpPercent : 100;

    // Calculate incoming opponent threat against this specific switch-in
    const incomingThreat = p1Mon
      ? this.calculateOpponentThreat(
          state,
          p1Mon.species,
          100,
          p1Mon.item,
          p1Mon.baseAbility,
          undefined,
          undefined,
          remainingHp
        )
      : { maxIncomingDamagePercent: 0, koProbability: 0, opponentThreatensKO: false };

    // Compute defensive and offensive type effectiveness against opponent
    let defensiveMultiplier = 1.0;
    let offensiveEffectiveness = 1.0;

    if (p1Mon && state.p2.active) {
      const switchInSpecies = dex.species.get(p1Mon.species);
      const switchInTypes = switchInSpecies?.types || ['Normal'];
      const oppSpecies = dex.species.get(state.p2.active.species);
      const oppTypes = oppSpecies?.types || ['Normal'];

      // Defensive: How does switch-in resist opponent's STAB types?
      let totalDefMult = 0;
      for (const ot of oppTypes) {
        totalDefMult += this.getTypeEffectiveness(ot, switchInTypes, dex);
      }
      defensiveMultiplier = Math.round((totalDefMult / oppTypes.length) * 100) / 100;

      // Offensive: Can switch-in hit opponent with super-effective STAB?
      let maxOffMult = 1.0;
      for (const st of switchInTypes) {
        const offMult = this.getTypeEffectiveness(st, oppTypes, dex);
        if (offMult > maxOffMult) maxOffMult = offMult;
      }
      offensiveEffectiveness = maxOffMult;
    }

    // Determine comprehensive switch-in safety (Hazards + Incoming attack)
    const totalSwitchDmg = hazardDamagePercent + incomingThreat.maxIncomingDamagePercent;
    let switchInSafety: 'safe' | 'risky' | 'fatal' = 'safe';

    if (hazardDamagePercent >= remainingHp || totalSwitchDmg >= remainingHp || incomingThreat.koProbability >= 0.8) {
      switchInSafety = 'fatal';
    } else if (totalSwitchDmg > 50 || incomingThreat.maxIncomingDamagePercent > 40 || defensiveMultiplier > 1.2) {
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
      incomingMaxDamagePercent: incomingThreat.maxIncomingDamagePercent,
      opponentThreatensKO: incomingThreat.opponentThreatensKO,
      typeEffectivenessAgainstOpponent: offensiveEffectiveness,
      typeResistanceAgainstOpponent: defensiveMultiplier,
      description: `Switch into ${p1Mon?.species || ident} (Hazards: -${hazardDamagePercent}%, Hit: -${incomingThreat.maxIncomingDamagePercent}%, Resist: ${defensiveMultiplier}x, Safety: ${switchInSafety})`
    };
  }

  public static calculateOpponentThreat(
    state: BattleState,
    targetSpecies: string,
    targetLevel: number = 100,
    targetItem?: string,
    targetAbility?: string,
    targetBoosts?: BoostTable,
    targetTeraType?: string,
    targetCurrentHpPercent: number = 100
  ): { maxIncomingDamagePercent: number; koProbability: number; opponentThreatensKO: boolean } {
    const p2Active = state.p2.active;
    if (!p2Active) {
      return { maxIncomingDamagePercent: 0, koProbability: 0, opponentThreatensKO: false };
    }

    const genNum = getGenNumber(state.format);
    const gen = Generations.get(genNum);
    const dex = Dex.forGen(genNum);

    const targetSpeciesData = dex.species.get(targetSpecies);
    if (!targetSpeciesData) {
      return { maxIncomingDamagePercent: 0, koProbability: 0, opponentThreatensKO: false };
    }

    // Build defender instance
    const defenderItem = targetItem ? dex.items.get(targetItem)?.name || targetItem : undefined;
    const defenderAbility = targetAbility ? dex.abilities.get(targetAbility)?.name || targetAbility : undefined;

    let defender: CalcPokemon;
    try {
      defender = new CalcPokemon(gen, targetSpecies, {
        level: targetLevel,
        item: defenderItem,
        ability: defenderAbility,
        boosts: targetBoosts
          ? {
              atk: targetBoosts.atk,
              def: targetBoosts.def,
              spa: targetBoosts.spa,
              spd: targetBoosts.spd,
              spe: targetBoosts.spe
            }
          : undefined,
        teraType: targetTeraType as any
      });
    } catch {
      return { maxIncomingDamagePercent: 0, koProbability: 0, opponentThreatensKO: false };
    }

    // Build attacker instance
    const attackerItem = p2Active.revealedItem ? dex.items.get(p2Active.revealedItem)?.name || p2Active.revealedItem : undefined;
    const attackerAbility = p2Active.revealedAbility ? dex.abilities.get(p2Active.revealedAbility)?.name || p2Active.revealedAbility : undefined;

    let attacker: CalcPokemon;
    try {
      attacker = new CalcPokemon(gen, p2Active.species, {
        level: p2Active.level,
        item: attackerItem,
        ability: attackerAbility,
        boosts: {
          atk: p2Active.boosts.atk,
          def: p2Active.boosts.def,
          spa: p2Active.boosts.spa,
          spd: p2Active.boosts.spd,
          spe: p2Active.boosts.spe
        },
        teraType: p2Active.terastallized && p2Active.teraType ? (p2Active.teraType as any) : undefined
      });
    } catch {
      return { maxIncomingDamagePercent: 0, koProbability: 0, opponentThreatensKO: false };
    }

    // Determine opponent candidate moves to evaluate
    const movesToEvaluate: string[] = [];
    if (p2Active.moves && p2Active.moves.length > 0) {
      for (const m of p2Active.moves) {
        const moveData = dex.moves.get(m);
        if (moveData && moveData.category !== 'Status') {
          movesToEvaluate.push(moveData.name);
        }
      }
    }

    // If opponent has fewer than 2 revealed damaging moves, test standard STAB attacks
    if (movesToEvaluate.length < 2) {
      const oppSpecies = dex.species.get(p2Active.species);
      const types = oppSpecies?.types || ['Normal'];
      const defaultStabs: Record<string, string> = {
        Normal: 'Body Slam',
        Fire: 'Flamethrower',
        Water: 'Surf',
        Electric: 'Thunderbolt',
        Grass: 'Energy Ball',
        Ice: 'Ice Beam',
        Fighting: 'Close Combat',
        Poison: 'Sludge Bomb',
        Ground: 'Earthquake',
        Flying: 'Air Slash',
        Psychic: 'Psychic',
        Bug: 'Bug Buzz',
        Rock: 'Stone Edge',
        Ghost: 'Shadow Ball',
        Dragon: 'Dragon Pulse',
        Steel: 'Iron Head',
        Dark: 'Dark Pulse',
        Fairy: 'Moonblast'
      };

      for (const t of types) {
        const defaultMove = defaultStabs[t];
        if (defaultMove && !movesToEvaluate.includes(defaultMove)) {
          movesToEvaluate.push(defaultMove);
        }
      }
    }

    let maxIncomingDamagePercent = 0;
    let koProbability = 0;
    const defenderMaxHp = defender.maxHP();
    const remainingHpAbs = Math.ceil((targetCurrentHpPercent / 100) * defenderMaxHp);

    for (const moveName of movesToEvaluate) {
      try {
        const calcMove = new CalcMove(gen, moveName);
        const result = calculate(gen, attacker, defender, calcMove);
        const range = result.range();
        const maxDmgPct = Math.round((range[1] / defenderMaxHp) * 1000) / 10;
        if (maxDmgPct > maxIncomingDamagePercent) {
          maxIncomingDamagePercent = maxDmgPct;
        }

        const damageRolls: number[] = Array.isArray(result.damage)
          ? (result.damage as number[])
          : [result.damage as number];
        const koRollCount = damageRolls.filter(d => typeof d === 'number' && d >= remainingHpAbs).length;
        const moveKoProb = Math.round((koRollCount / damageRolls.length) * 100) / 100;
        if (moveKoProb > koProbability) {
          koProbability = moveKoProb;
        }
      } catch {
        // Ignore unmapped custom moves
      }
    }

    // Speed comparison
    const targetSpe = targetBoosts
      ? this.calculateEffectiveSpeed(targetSpeciesData.baseStats.spe, targetBoosts.spe)
      : targetSpeciesData.baseStats.spe;
    const oppBaseSpeed = dex.species.get(p2Active.species)?.baseStats.spe || 100;
    const oppSpe = this.calculateEffectiveSpeed(
      Math.floor(((2 * oppBaseSpeed + 31 + 21) * p2Active.level) / 100 + 5),
      p2Active.boosts.spe
    );
    const opponentOutspeeds = oppSpe >= targetSpe;
    const opponentThreatensKO =
      opponentOutspeeds && (koProbability >= 0.85 || maxIncomingDamagePercent >= targetCurrentHpPercent);

    return {
      maxIncomingDamagePercent,
      koProbability,
      opponentThreatensKO
    };
  }

  public static getTypeEffectiveness(
    attackType: string,
    defenderTypes: string[],
    dex: ReturnType<typeof Dex.forGen>
  ): number {
    let mult = 1.0;
    for (const defType of defenderTypes) {
      const typeData = dex.types.get(defType);
      if (typeData && typeData.damageTaken) {
        // Showdown damageTaken values: 1 = weak (2x), 2 = resist (0.5x), 3 = immune (0x), 0 = neutral (1x)
        const dt = typeData.damageTaken[attackType];
        if (dt === 1) mult *= 2;
        else if (dt === 2) mult *= 0.5;
        else if (dt === 3) mult *= 0;
      }
    }
    return mult;
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

  private static getRockEffectiveness(speciesName: string, dex: ReturnType<typeof Dex.forGen>): number {
    const species = dex.species.get(speciesName);
    if (!species) return 1.0;

    let mult = 1.0;
    for (const type of species.types) {
      const typeData = dex.types.get(type);
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

  private static isGrounded(speciesName: string, dex: ReturnType<typeof Dex.forGen>): boolean {
    const species = dex.species.get(speciesName);
    if (!species) return true;
    if (species.types.includes('Flying')) return false;
    return true;
  }
}

