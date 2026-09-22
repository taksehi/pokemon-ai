import { BattleState } from '../battle/battle-state.js';

export class BattleLogger {
  /**
   * Formats a BattleState into an instrumented diagnostic log string.
   */
  public static formatState(state: BattleState): string {
    const p1Active = state.p1.active;
    const p2Active = state.p2.active;

    const lines: string[] = [
      `============================================================`,
      `[OBSERVE] Turn: ${state.turn} | Format: ${state.format}`,
      `[FIELD] Weather: ${state.field.weather || 'None'} | Terrain: ${state.field.terrain || 'None'}`,
      `[HAZARDS] Our: ${JSON.stringify(state.field.p1Hazards)} | Opp: ${JSON.stringify(state.field.p2Hazards)}`,
      `------------------------------------------------------------`,
      `[OUR ACTIVE] ${p1Active ? `${p1Active.species} (HP: ${p1Active.hpPercent}%, ${p1Active.currentHp}/${p1Active.maxHp})` : 'None'}`,
      p1Active ? `   Status: ${p1Active.status || 'Healthy'} | Item: ${p1Active.item || 'Unknown'} | Ability: ${p1Active.ability || 'Unknown'}` : '',
      p1Active ? `   Moves: ${p1Active.moves.map(m => `${m.name} (${m.pp}/${m.maxpp})`).join(', ')}` : '',
      `[OPPONENT ACTIVE] ${p2Active ? `${p2Active.species} (HP: ~${p2Active.hpPercent}%)` : 'None'}`,
      p2Active ? `   Status: ${p2Active.status || 'Healthy'} | Item: ${p2Active.revealedItem || 'Unknown'} | Ability: ${p2Active.revealedAbility || 'Unknown'}` : '',
      p2Active ? `   Revealed Moves: [${p2Active.revealedMoves.join(', ')}]` : '',
      `============================================================`
    ];

    return lines.filter(Boolean).join('\n');
  }
}
