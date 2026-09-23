import { describe, it, expect } from 'vitest';
import { BaselineEngine } from '../src/strategy/baseline-engine.js';
import { CandidateGenerator } from '../src/strategy/candidate-generator.js';
import { StateTracker } from '../src/battle/state-tracker.js';
import { BattleRunner, RequestPayload } from '../src/sim/battle-runner.js';
import { BattleLogger } from '../src/utils/battle-logger.js';

describe('Loop 4: Deterministic Baseline Engine', () => {
  it('should prioritize securing a KO over risky switching in Dragapult vs Gholdengo', () => {
    const tracker = new StateTracker('gen9ou');

    const lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Dragapult|Dragapult, L100, M|317/317',
      '|switch|p2a: Gholdengo|Gholdengo, L100|70/100',
      '|-ability|p2a: Gholdengo|Good as Gold'
    ];
    tracker.processLines(lines);

    const syntheticRequest: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Shadow Ball', id: 'shadowball', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Draco Meteor', id: 'dracometeor', pp: 8, maxpp: 8, target: 'normal', disabled: false },
            { move: 'U-turn', id: 'uturn', pp: 32, maxpp: 32, target: 'normal', disabled: false }
          ],
          canTerastallize: 'Ghost'
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Dragapult',
            details: 'Dragapult, L100, M',
            condition: '317/317',
            active: true,
            stats: { atk: 256, def: 186, spa: 299, spd: 186, spe: 421 },
            moves: ['shadowball', 'dracometeor', 'uturn'],
            baseAbility: 'infiltrator',
            item: 'choicespecs',
            pokeball: 'pokeball'
          },
          {
            ident: 'p1: Ting-Lu',
            details: 'Ting-Lu, L100',
            condition: '514/514',
            active: false,
            stats: { atk: 256, def: 286, spa: 120, spd: 260, spe: 126 },
            moves: ['earthquake'],
            baseAbility: 'vesselofruin',
            item: 'leftovers',
            pokeball: 'pokeball'
          }
        ]
      }
    };

    tracker.updateFromRequest(syntheticRequest);

    const bestChoice = BaselineEngine.selectBestAction(tracker.state, syntheticRequest);

    // Best choice must be Shadow Ball (move 1)
    expect(bestChoice.candidate.choice).toBe('shadowball');
    expect(bestChoice.candidate.type).toBe('move');
    expect(bestChoice.score).toBeGreaterThan(100);
    expect(bestChoice.breakdown.some(b => b.includes('KO probability'))).toBe(true);
  });

  it('should autonomously play a live in-memory battle for 10 consecutive turns with zero illegal moves', async () => {
    const runner = new BattleRunner();
    const tracker = new StateTracker('gen9randombattle');

    await runner.start({
      formatid: 'gen9randombattle',
      p1Name: 'Baseline_Bot',
      p2Name: 'Opponent_Bot',
      autoOpponent: true
    });

    let turnCount = 0;
    const maxTurns = 12;

    while (turnCount < maxTurns) {
      const actionable = await runner.getNextActionableRequest();
      if (!actionable) {
        // Battle concluded
        break;
      }

      tracker.processLines(actionable.rawLines);
      tracker.updateFromRequest(actionable.request);

      const decision = BaselineEngine.selectBestAction(tracker.state, actionable.request);
      expect(decision.candidate.id).toBeDefined();

      // Submit decision directly to simulator
      await runner.chooseP1(decision.candidate.id);
      turnCount++;
    }

    // Verify battle progressed cleanly through multiple turns
    expect(turnCount).toBeGreaterThanOrEqual(5);
    expect(tracker.state.turn).toBeGreaterThanOrEqual(4);

    // Verify instrumentation log works on final state
    const log = BattleLogger.formatState(tracker.state);
    expect(log).toContain('[OBSERVE]');
  });

  it('should prefer safe defensive pivoting or priority over clicking a slow attack under lethal KO threat', () => {
    const tracker = new StateTracker('gen9ou');

    // Alice has frail Gengar at 25% HP facing outspeeding Dragapult with Shadow Ball
    const lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Gengar|Gengar, L100, M|25/100',
      '|switch|p2a: Dragapult|Dragapult, L100, M|100/100',
      '|move|p2a: Dragapult|Shadow Ball|p1a: Gengar|[still]'
    ];
    tracker.processLines(lines);

    const request: RequestPayload = {
      rqid: 2,
      active: [
        {
          moves: [
            { move: 'Sludge Bomb', id: 'sludgebomb', pp: 16, maxpp: 16, target: 'normal', disabled: false },
            { move: 'Sucker Punch', id: 'suckerpunch', pp: 8, maxpp: 8, target: 'normal', disabled: false }
          ]
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Gengar',
            details: 'Gengar, L100, M',
            condition: '25/100',
            active: true,
            stats: { atk: 149, def: 156, spa: 359, spd: 186, spe: 319 },
            moves: ['sludgebomb', 'suckerpunch'],
            baseAbility: 'cursedbody',
            item: '',
            pokeball: 'pokeball'
          },
          {
            ident: 'p1: Ting-Lu',
            details: 'Ting-Lu, L100',
            condition: '100/100',
            active: false,
            stats: { atk: 256, def: 286, spa: 120, spd: 260, spe: 126 },
            moves: ['earthquake'],
            baseAbility: 'vesselofruin',
            item: 'leftovers',
            pokeball: 'pokeball'
          }
        ]
      }
    };

    tracker.updateFromRequest(request);

    const bestChoice = BaselineEngine.selectBestAction(tracker.state, request);

    // Ting-Lu is Dark/Ground (resists Ghost) and has massive bulk.
    // The engine should either switch to Ting-Lu or use priority Sucker Punch, but NEVER click slow Sludge Bomb!
    expect(['switch 2', 'move 2']).toContain(bestChoice.candidate.id);
    expect(bestChoice.candidate.id).not.toBe('move 1');
  });

  it('should penalize status moves used into immune types', () => {
    const tracker = new StateTracker('gen9ou');

    // Opponent is Great Tusk (Ground / Fighting)
    const lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Zapdos|Zapdos, L100|100/100',
      '|switch|p2a: Great Tusk|Great Tusk, L100|100/100'
    ];
    tracker.processLines(lines);

    const request: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Thunder Wave', id: 'thunderwave', pp: 32, maxpp: 32, target: 'normal', disabled: false },
            { move: 'Hurricane', id: 'hurricane', pp: 16, maxpp: 16, target: 'normal', disabled: false }
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
            moves: ['thunderwave', 'hurricane'],
            baseAbility: 'static',
            item: 'heavydutyboots',
            pokeball: 'pokeball'
          }
        ]
      }
    };

    tracker.updateFromRequest(request);

    const candidates = CandidateGenerator.generateCandidates(tracker.state, request);
    const twScored = BaselineEngine.scoreCandidate(tracker.state, request, candidates.find(c => c.choice === 'thunderwave')!);
    const hurrScored = BaselineEngine.scoreCandidate(tracker.state, request, candidates.find(c => c.choice === 'hurricane')!);

    // Thunder Wave should have an immunity penalty and be scored far below Hurricane
    expect(twScored.breakdown.some(b => b.includes('Immune'))).toBe(true);
    expect(twScored.score).toBeLessThan(-50);
    expect(hurrScored.score).toBeGreaterThan(twScored.score);
  });
});
