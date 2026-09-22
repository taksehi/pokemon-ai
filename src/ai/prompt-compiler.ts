import { BattleState } from '../battle/battle-state.js';
import { EvaluatedCandidateAction } from '../strategy/candidate-generator.js';

export class PromptCompiler {
  /**
   * Compiles the battle state and evaluated legal candidates into a strategic prompt.
   */
  public static compilePrompt(
    state: BattleState,
    candidates: EvaluatedCandidateAction[]
  ): string {
    const p1Active = state.p1.active;
    const p2Active = state.p2.active;

    const sections: string[] = [];

    // System Header
    sections.push(
      `You are an expert competitive Pokémon Showdown AI playing ${state.format}.`,
      `Select the optimal action for this turn based on strategic positioning, risk evaluation, and win conditions.`,
      `All damage calculations, speed comparisons, and hazard penalties have already been calculated deterministically below. Do NOT recalculate numbers. Choose the strategically superior candidate.`
    );

    // Battle Context
    sections.push(
      `=== BATTLE CONTEXT ===`,
      `Turn: ${state.turn} | Weather: ${state.field.weather || 'None'} | Terrain: ${state.field.terrain || 'None'}`,
      `Our Hazards: ${this.formatHazards(state.field.p1Hazards)}`,
      `Opponent Hazards: ${this.formatHazards(state.field.p2Hazards)}`
    );

    // Our Active
    sections.push(
      `=== OUR ACTIVE POKÉMON ===`,
      p1Active
        ? [
            `Species: ${p1Active.species} | HP: ${p1Active.hpPercent}% (${p1Active.currentHp}/${p1Active.maxHp})`,
            `Status: ${p1Active.status || 'Healthy'} | Item: ${p1Active.item || 'Unknown'} | Ability: ${p1Active.ability || 'Unknown'}`,
            `Tera Type: ${p1Active.teraType || 'Unknown'} (Terastallized: ${p1Active.terastallized ? 'Yes' : 'No'})`,
            `Stat Boosts: ${this.formatBoosts(p1Active.boosts)}`
          ].join('\n')
        : 'None (Forced Switch)'
    );

    // Opponent Active
    sections.push(
      `=== OPPONENT ACTIVE POKÉMON ===`,
      p2Active
        ? [
            `Species: ${p2Active.species} | HP: ~${p2Active.hpPercent}%`,
            `Status: ${p2Active.status || 'Healthy'} | Revealed Item: ${p2Active.revealedItem || 'Unknown'} | Revealed Ability: ${p2Active.revealedAbility || 'Unknown'}`,
            `Revealed Moves: [${p2Active.revealedMoves.join(', ') || 'None yet'}]`,
            `Stat Boosts: ${this.formatBoosts(p2Active.boosts)}`
          ].join('\n')
        : 'None'
    );

    // Our Remaining Team
    const bench = state.p1.team.filter(p => !p.active);
    sections.push(
      `=== OUR BENCH (${bench.filter(p => !p.fainted).length} alive) ===`,
      bench
        .map(
          p =>
            `- ${p.species}: HP ${p.hpPercent}% (${p.currentHp}/${p.maxHp})${p.fainted ? ' [FAINTED]' : ''} | Item: ${p.item || 'Unknown'}`
        )
        .join('\n') || 'None'
    );

    // Opponent Revealed Team
    const oppBench = state.p2.team.filter(p => !p.active);
    if (oppBench.length > 0) {
      sections.push(
        `=== OPPONENT REVEALED BENCH ===`,
        oppBench
          .map(
            p =>
              `- ${p.species}: HP ~${p.hpPercent}%${p.fainted ? ' [FAINTED]' : ''} | Moves: [${p.revealedMoves.join(', ')}]`
          )
          .join('\n')
      );
    }

    // Legal Candidate Actions
    sections.push(`=== LEGAL CANDIDATE ACTIONS ===`);
    candidates.forEach((c, idx) => {
      const evalData = c.evaluation;
      let details = '';
      if (c.type === 'move') {
        details = [
          `Damage: ${evalData.minDamagePercent}% - ${evalData.maxDamagePercent}%`,
          `KO Chance: ${Math.round(evalData.koProbability * 100)}%`,
          `Speed: ${evalData.outspeeds === true ? 'Faster' : evalData.outspeeds === false ? 'Slower' : 'Speed tie'}`,
          evalData.priority !== 0 ? `Priority: ${evalData.priority}` : ''
        ]
          .filter(Boolean)
          .join(' | ');
      } else {
        details = [
          `Hazard Damage on Entry: -${evalData.hazardDamagePercent}%`,
          `Safety: ${evalData.switchInSafety || 'safe'}`
        ].join(' | ');
      }

      sections.push(`Candidate ${idx + 1} [ID: "${c.id}"]: ${c.name} (${c.type.toUpperCase()})\n   Calculations: ${details}`);
    });

    // Output Instructions
    sections.push(
      `=== OUTPUT REQUIREMENTS ===`,
      `Respond with a single raw JSON object matching this schema without markdown fences:`,
      `{`,
      `  "selected_candidate_id": "<exact candidate id, e.g. 'move 1' or 'switch 2'>",`,
      `  "action_type": "<'move' or 'switch'>",`,
      `  "confidence": <number between 0.0 and 1.0>,`,
      `  "opponent_prediction": "<brief expectation of what opponent will do>",`,
      `  "strategic_rationale": "<strategic explanation of why this candidate is best>"`
      ,`}`
    );

    return sections.join('\n\n');
  }

  private static formatHazards(h: { stealthRock: boolean; spikes: number; toxicSpikes: number; stickyWeb: boolean }): string {
    const list: string[] = [];
    if (h.stealthRock) list.push('Stealth Rock');
    if (h.spikes > 0) list.push(`Spikes (${h.spikes})`);
    if (h.toxicSpikes > 0) list.push(`Toxic Spikes (${h.toxicSpikes})`);
    if (h.stickyWeb) list.push('Sticky Web');
    return list.length > 0 ? list.join(', ') : 'None';
  }

  private static formatBoosts(b: { atk: number; def: number; spa: number; spd: number; spe: number }): string {
    const parts: string[] = [];
    if (b.atk) parts.push(`Atk ${b.atk > 0 ? '+' : ''}${b.atk}`);
    if (b.def) parts.push(`Def ${b.def > 0 ? '+' : ''}${b.def}`);
    if (b.spa) parts.push(`SpA ${b.spa > 0 ? '+' : ''}${b.spa}`);
    if (b.spd) parts.push(`SpD ${b.spd > 0 ? '+' : ''}${b.spd}`);
    if (b.spe) parts.push(`Spe ${b.spe > 0 ? '+' : ''}${b.spe}`);
    return parts.length > 0 ? parts.join(', ') : 'Neutral';
  }
}
