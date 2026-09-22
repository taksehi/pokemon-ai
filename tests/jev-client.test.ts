import { describe, it, expect } from 'vitest';
import { JevClient } from '../src/ai/jev-client.js';
import { AIStrategyPlayer } from '../src/ai/strategy-player.js';
import { StateTracker } from '../src/battle/state-tracker.js';
import { CandidateGenerator } from '../src/strategy/candidate-generator.js';
import { BattleRunner, RequestPayload } from '../src/sim/battle-runner.js';

describe('Loop 7: TypeSafe AI Jev System One Client', () => {
  const setupSyntheticBattle = () => {
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
    const candidates = CandidateGenerator.generateCandidates(tracker.state, syntheticRequest);
    return { tracker, request: syntheticRequest, candidates };
  };

  it('should formulate Jev System One questions with exact candidate criteria', async () => {
    const { tracker, candidates } = setupSyntheticBattle();

    let capturedPayload: any = null;

    const jev = new JevClient({
      transport: async payload => {
        capturedPayload = payload;
        return {
          answers: {
            action: {
              choice: 'move 1',
              confidence: 0.94,
              probabilities: { 'move 1': 0.85, 'move 2': 0.1, 'move 3': 0.05 }
            },
            opponent_switch: {
              probability: 0.75
            },
            win_con_preservation: {
              score: 'Critical Win Condition'
            }
          }
        };
      }
    });

    const decision = await jev.evaluate(tracker.state, candidates);

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.model).toBe('jev-latest');
    expect(capturedPayload.state.turn).toBe(1);
    expect(capturedPayload.state.our_active).toContain('Dragapult');
    expect(capturedPayload.questions.action.type).toBe('choice');
    expect(capturedPayload.questions.action.criteria['move 1']).toBeDefined();
    expect(capturedPayload.questions.opponent_switch.type).toBe('boolean');

    // Decision assertions
    expect(decision.selected_candidate_id).toBe('move 1');
    expect(decision.confidence).toBe(0.94);
    expect(decision.opponent_prediction).toContain('Opponent likely to switch');
    expect(decision.strategic_rationale).toContain('Critical Win Condition');
  });

  it('should seamlessly execute decisions through AIStrategyPlayer using Jev', async () => {
    const { tracker, request } = setupSyntheticBattle();

    const jev = new JevClient({
      transport: async () => ({
        answers: {
          action: {
            choice: 'move 1',
            confidence: 0.91
          },
          opponent_switch: {
            probability: 0.3
          }
        }
      })
    });

    const player = new AIStrategyPlayer(jev);
    const result = await player.decideAction(tracker.state, request);

    expect(result.usedFallback).toBe(false);
    expect(result.candidate.id).toBe('move 1');
    expect(result.candidate.choice).toBe('shadowball');
  });

  it('should automatically trigger deterministic fallback if Jev network call fails', async () => {
    const { tracker, request } = setupSyntheticBattle();

    const failingJev = new JevClient({
      transport: async () => {
        throw new Error('TypeSafe API 503 Service Unavailable');
      }
    });

    const player = new AIStrategyPlayer(failingJev);
    const result = await player.decideAction(tracker.state, request);

    expect(result.usedFallback).toBe(true);
    expect(result.rationale).toContain('[SAFETY FALLBACK]');
    expect(result.rationale).toContain('503 Service Unavailable');
    expect(result.candidate.id).toBe('move 1'); // Falls back to best heuristic candidate
  });

  it('should play a multi-turn in-memory battle powered by Jev System One', async () => {
    const runner = new BattleRunner();
    const tracker = new StateTracker('gen9randombattle');

    await runner.start({
      formatid: 'gen9randombattle',
      p1Name: 'Jev_Player',
      p2Name: 'Bot_Opponent',
      autoOpponent: true
    });

    const jev = new JevClient({
      transport: async payload => {
        // Pick first legal choice dynamically from criteria
        const choices = Object.keys(payload.questions.action.criteria);
        return {
          answers: {
            action: {
              choice: choices[0] || 'move 1',
              confidence: 0.88
            }
          }
        };
      }
    });

    const player = new AIStrategyPlayer(jev);

    for (let turn = 0; turn < 4; turn++) {
      const actionable = await runner.getNextActionableRequest();
      if (!actionable) break;

      tracker.processLines(actionable.rawLines);
      tracker.updateFromRequest(actionable.request);

      const result = await player.decideAction(tracker.state, actionable.request);
      expect(result.candidate.id).toBeDefined();

      await runner.chooseP1(result.candidate.id);
    }

    expect(tracker.state.turn).toBeGreaterThanOrEqual(2);
  });
});
