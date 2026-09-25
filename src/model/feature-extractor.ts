import { BattleState } from '../battle/battle-state.js';
import { EvaluatedCandidateAction } from '../strategy/candidate-generator.js';

export const FEATURE_VECTOR_SIZE = 14;

/**
 * Extracts a normalized 14-dimensional feature vector for a (state, action) pair.
 */
export function extractFeatures(
  state: BattleState,
  actionStrOrCandidate: string | EvaluatedCandidateAction
): number[] {
  const p1Active = state.p1.active;
  const p2Active = state.p2.active;

  // 1. P1 Active HP fraction [0, 1]
  const p1Hp = p1Active ? Math.max(0, Math.min(1, p1Active.hpPercent / 100)) : 0;

  // 2. P2 Active HP fraction [0, 1]
  const p2Hp = p2Active ? Math.max(0, Math.min(1, p2Active.hpPercent / 100)) : 0;

  // 3. P1 Alive Pokémon ratio [0, 1]
  const p1AliveCount = state.p1.team.filter(p => !p.fainted && p.hpPercent > 0).length;
  const p1AliveRatio = p1AliveCount / 6;

  // 4. P2 Alive Pokémon ratio [0, 1]
  const p2AliveCount = state.p2.team.filter(p => !p.fainted && p.hpPercent > 0).length;
  const p2AliveRatio = p2AliveCount / 6;

  // Parse action info
  let isSwitch = 0;
  let isAttack = 0;
  let isTera = 0;
  let moveDamageEst = 0.5; // default moderate
  let typeEffectiveness = 1.0; // default neutral
  let isPriority = 0;

  if (typeof actionStrOrCandidate === 'string') {
    const act = actionStrOrCandidate.toLowerCase();
    if (act.startsWith('switch')) {
      isSwitch = 1;
    } else if (act.startsWith('move')) {
      isAttack = 1;
      if (act.includes('terastallize')) isTera = 1;
    }
  } else {
    if (actionStrOrCandidate.type === 'switch') {
      isSwitch = 1;
    } else {
      isAttack = 1;
      if (actionStrOrCandidate.terastallize) isTera = 1;
      const ev = actionStrOrCandidate.evaluation;
      moveDamageEst = Math.min(1.5, ((ev.minDamagePercent + ev.maxDamagePercent) / 2) / 100);
      if (ev.typeEffectivenessAgainstOpponent !== undefined) {
        typeEffectiveness = ev.typeEffectivenessAgainstOpponent;
      }
      if (ev.priority && ev.priority > 0) isPriority = 1;
    }
  }

  // 8. P1 Active net stat boosts normalized [-1, 1]
  let p1BoostNet = 0;
  if (p1Active?.boosts) {
    const b = p1Active.boosts;
    p1BoostNet = (b.atk + b.def + b.spa + b.spd + b.spe) / 30; // max +/- 30 across 5 stats
  }

  // 9. P2 Active net stat boosts normalized [-1, 1]
  let p2BoostNet = 0;
  if (p2Active?.boosts) {
    const b = p2Active.boosts;
    p2BoostNet = (b.atk + b.def + b.spa + b.spd + b.spe) / 30;
  }

  // 10. Turn number normalized [0, 1]
  const turnNormalized = Math.min(1, (state.turn || 1) / 50);

  // 11. P1 Hazard count normalized [0, 1]
  const p1Hazards = (state.field.p1Hazards.stealthRock ? 1 : 0) +
    state.field.p1Hazards.spikes +
    state.field.p1Hazards.toxicSpikes +
    (state.field.p1Hazards.stickyWeb ? 1 : 0);
  const p1HazardNorm = Math.min(1, p1Hazards / 6);

  // 12. P2 Hazard count normalized [0, 1]
  const p2Hazards = (state.field.p2Hazards.stealthRock ? 1 : 0) +
    state.field.p2Hazards.spikes +
    state.field.p2Hazards.toxicSpikes +
    (state.field.p2Hazards.stickyWeb ? 1 : 0);
  const p2HazardNorm = Math.min(1, p2Hazards / 6);

  // 13. Speed advantage estimate [-1, 1]
  let speedAdvantage = 0;
  const s1 = p1Active?.stats?.spe ?? 100;
  const s2 = (p2Active as any)?.stats?.spe ?? 100;
  if (s1 > s2) speedAdvantage = 1;
  else if (s2 > s1) speedAdvantage = -1;

  // 14. Normalized type effectiveness [0, 1] (0 to 4x mapped to 0 to 1)
  const normTypeEff = Math.min(1, typeEffectiveness / 4.0);

  return [
    p1Hp,             // 0
    p2Hp,             // 1
    p1AliveRatio,     // 2
    p2AliveRatio,     // 3
    isSwitch,         // 4
    isAttack,         // 5
    isTera,           // 6
    p1BoostNet,       // 7
    p2BoostNet,       // 8
    turnNormalized,   // 9
    p1HazardNorm,     // 10
    p2HazardNorm,     // 11
    speedAdvantage,   // 12
    normTypeEff       // 13
  ];
}
