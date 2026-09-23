import { describe, it, expect } from 'vitest';
import { StateTracker } from '../src/battle/state-tracker.js';
import { CandidateGenerator } from '../src/strategy/candidate-generator.js';
import { BaselineEngine } from '../src/strategy/baseline-engine.js';
import { RequestPayload } from '../src/sim/battle-runner.js';

describe('Matchup Reaction & State Transition Scenarios', () => {
  it('1. Opponent switching into a different type: recalculates type matchup and detects immunity', () => {
    const tracker = new StateTracker('gen9ou');

    // Turn 1: Opponent has Water-type Dondozo active
    const t1Lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Zapdos|Zapdos, L100|100/100',
      '|switch|p2a: Dondozo|Dondozo, L100, M|100/100'
    ];
    tracker.processLines(t1Lines);

    const requestT1: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Thunderbolt', id: 'thunderbolt', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Heat Wave', id: 'heatwave', pp: 16, maxpp: 16, target: 'allAdjacentFoes', disabled: false }
          ]
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Zapdos',
            details: 'Zapdos, L100',
            condition: '100/100',
            active: true,
            stats: { atk: 194, def: 206, spa: 349, spd: 216, spe: 299 },
            moves: ['thunderbolt', 'heatwave'],
            baseAbility: 'static',
            item: 'heavydutyboots',
            pokeball: 'pokeball'
          }
        ]
      }
    };
    tracker.updateFromRequest(requestT1);

    // Verify against Dondozo: Thunderbolt is 2x super-effective
    const candidatesT1 = CandidateGenerator.generateCandidates(tracker.state, requestT1);
    const tbT1 = candidatesT1.find(c => c.choice === 'thunderbolt')!;
    expect(tbT1.evaluation.typeEffectivenessAgainstOpponent).toBe(2);
    expect(tbT1.evaluation.minDamagePercent).toBeGreaterThan(50);

    // Now opponent switches to Ground-type Great Tusk
    const t2Lines = [
      '|switch|p2a: Great Tusk|Great Tusk, L100|100/100',
      '|turn|2'
    ];
    tracker.processLines(t2Lines);

    const requestT2: RequestPayload = {
      ...requestT1,
      rqid: 2
    };
    tracker.updateFromRequest(requestT2);

    // Verify state tracker immediately updated opponent to Great Tusk
    expect(tracker.state.p2.active?.species).toBe('Great Tusk');

    // Verify candidate generator re-evaluated against the new opponent:
    // Thunderbolt must be evaluated as IMMUNE (0x effectiveness, 0 damage)
    const candidatesT2 = CandidateGenerator.generateCandidates(tracker.state, requestT2);
    const tbT2 = candidatesT2.find(c => c.choice === 'thunderbolt')!;
    expect(tbT2.evaluation.typeEffectivenessAgainstOpponent).toBe(0);
    expect(tbT2.evaluation.minDamagePercent).toBe(0);
    expect(tbT2.evaluation.maxDamagePercent).toBe(0);
    expect(tbT2.evaluation.description).toContain('Immune');
  });

  it('2. Bot changing its move after the matchup changes: switches from fire to water when opponent switches', () => {
    const tracker = new StateTracker('gen9ou');

    // Turn 1: Opponent is Steel/Grass Ferrothorn
    const t1Lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Greninja|Greninja, L100, M|100/100',
      '|switch|p2a: Ferrothorn|Ferrothorn, L100, M|100/100'
    ];
    tracker.processLines(t1Lines);

    const request: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Hydro Pump', id: 'hydropump', pp: 8, maxpp: 8, target: 'normal', disabled: false },
            { move: 'Ice Beam', id: 'icebeam', pp: 16, maxpp: 16, target: 'normal', disabled: false },
            { move: 'Dark Pulse', id: 'darkpulse', pp: 24, maxpp: 24, target: 'normal', disabled: false }
          ]
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Greninja',
            details: 'Greninja, L100, M',
            condition: '100/100',
            active: true,
            stats: { atk: 226, def: 170, spa: 305, spd: 178, spe: 377 },
            moves: ['hydropump', 'icebeam', 'darkpulse'],
            baseAbility: 'protean',
            item: 'lifeorb',
            pokeball: 'pokeball'
          }
        ]
      }
    };
    tracker.updateFromRequest(request);

    // Against Ferrothorn (Grass/Steel), Hydro Pump is double resisted (0.25x),
    // while Dark Pulse deals neutral damage and Ice Beam is neutral (1x).
    const decisionT1 = BaselineEngine.selectBestAction(tracker.state, request);
    expect(decisionT1.candidate.choice).not.toBe('hydropump');
    expect(['darkpulse', 'icebeam']).toContain(decisionT1.candidate.choice);

    // Now opponent switches to Fire-type Chi-Yu
    const t2Lines = [
      '|switch|p2a: Chi-Yu|Chi-Yu, L100|100/100',
      '|-ability|p2a: Chi-Yu|Beads of Ruin',
      '|turn|2'
    ];
    tracker.processLines(t2Lines);
    tracker.updateFromRequest({ ...request, rqid: 2 });

    // Against Chi-Yu (Dark/Fire), Hydro Pump is 2x super-effective and deals massive damage
    const decisionT2 = BaselineEngine.selectBestAction(tracker.state, { ...request, rqid: 2 });
    expect(decisionT2.candidate.choice).toBe('hydropump');
    expect(decisionT2.candidate.evaluation.typeEffectivenessAgainstOpponent).toBe(2);
  });

  it('3. Bot switching when its current Pokémon has a poor matchup', () => {
    const tracker = new StateTracker('gen9ou');

    // Bot has frail Raichu facing bulky Ground-type Great Tusk
    const lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Raichu|Raichu, L100, M|100/100',
      '|switch|p2a: Great Tusk|Great Tusk, L100|100/100'
    ];
    tracker.processLines(lines);

    const request: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Thunderbolt', id: 'thunderbolt', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Volt Switch', id: 'voltswitch', pp: 32, maxpp: 32, target: 'normal', disabled: false },
            { move: 'Quick Attack', id: 'quickattack', pp: 48, maxpp: 48, target: 'normal', disabled: false }
          ]
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Raichu',
            details: 'Raichu, L100, M',
            condition: '100/100',
            active: true,
            stats: { atk: 216, def: 146, spa: 216, spd: 196, spe: 319 },
            moves: ['thunderbolt', 'voltswitch', 'quickattack'],
            baseAbility: 'lightningrod',
            item: '',
            pokeball: 'pokeball'
          },
          {
            ident: 'p1: Corviknight',
            details: 'Corviknight, L100, F',
            condition: '100/100',
            active: false,
            stats: { atk: 210, def: 305, spa: 120, spd: 206, spe: 170 },
            moves: ['bravebird', 'roost', 'defog', 'uturn'],
            baseAbility: 'pressure',
            item: 'leftovers',
            pokeball: 'pokeball'
          }
        ]
      }
    };
    tracker.updateFromRequest(request);

    // Corviknight is Flying/Steel (immune to Ground STAB and resists Fighting).
    // Raichu has only Electric moves (immune) and weak Quick Attack, while Great Tusk threatens an OHKO.
    const bestAction = BaselineEngine.selectBestAction(tracker.state, request);

    // Engine must choose to switch to Corviknight!
    expect(bestAction.candidate.type).toBe('switch');
    expect(bestAction.candidate.choice).toBe('corviknight');
    expect(bestAction.breakdown.some(b => b.includes('pivot'))).toBe(true);
  });

  it('4. Bot still being allowed to repeat a move when it genuinely remains the best option', () => {
    const tracker = new StateTracker('gen9ou');

    // Turn 1: Dragapult vs weakened Gholdengo
    const t1Lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Dragapult|Dragapult, L100, M|100/100',
      '|switch|p2a: Gholdengo|Gholdengo, L100|80/100'
    ];
    tracker.processLines(t1Lines);

    const request: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Shadow Ball', id: 'shadowball', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Flamethrower', id: 'flamethrower', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'U-turn', id: 'uturn', pp: 32, maxpp: 32, target: 'normal', disabled: false }
          ]
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Dragapult',
            details: 'Dragapult, L100, M',
            condition: '100/100',
            active: true,
            stats: { atk: 256, def: 186, spa: 299, spd: 186, spe: 421 },
            moves: ['shadowball', 'flamethrower', 'uturn'],
            baseAbility: 'infiltrator',
            item: 'choicespecs',
            pokeball: 'pokeball'
          }
        ]
      }
    };
    tracker.updateFromRequest(request);

    // Turn 1 action selection
    const decisionT1 = BaselineEngine.selectBestAction(tracker.state, request);
    expect(decisionT1.candidate.choice).toBe('shadowball');

    // Turn 2: Opponent took damage, survived at 25% HP, and stayed in
    const t2Lines = [
      '|-damage|p2a: Gholdengo|25/100',
      '|turn|2'
    ];
    tracker.processLines(t2Lines);
    tracker.updateFromRequest({ ...request, rqid: 2 });

    // Turn 2 action selection: Shadow Ball remains super-effective and now guarantees the KO
    const decisionT2 = BaselineEngine.selectBestAction(tracker.state, { ...request, rqid: 2 });
    expect(decisionT2.candidate.choice).toBe('shadowball');
    expect(decisionT2.candidate.id).toBe(decisionT1.candidate.id);
  });
});
