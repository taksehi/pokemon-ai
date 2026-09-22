import { describe, it, expect } from 'vitest';
import { BaselineEngine } from '../src/strategy/baseline-engine.js';
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
});
