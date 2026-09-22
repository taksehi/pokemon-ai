import { describe, it, expect } from 'vitest';
import { AIStrategyPlayer } from '../src/ai/strategy-player.js';
import { MockLLMClient } from '../src/ai/llm-client.js';
import { StateTracker } from '../src/battle/state-tracker.js';
import { BattleRunner, RequestPayload } from '../src/sim/battle-runner.js';

describe('Loop 5: AI Strategic Reasoning Layer & Safety Guard', () => {
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
            moves: ['shadowball', 'uturn'],
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
    return { tracker, request: syntheticRequest };
  };

  it('should accept valid structured JSON from AI and execute the chosen candidate', async () => {
    const { tracker, request } = setupSyntheticBattle();

    const mockClient = new MockLLMClient(prompt => {
      // Prompt should contain key information
      expect(prompt).toContain('Dragapult');
      expect(prompt).toContain('Gholdengo');
      expect(prompt).toContain('Shadow Ball');

      return JSON.stringify({
        selected_candidate_id: 'move 1',
        action_type: 'move',
        confidence: 0.95,
        opponent_prediction: 'Opponent will stay in or predict U-turn',
        strategic_rationale: 'Shadow Ball provides lethal damage and secures the KO.'
      });
    });

    const player = new AIStrategyPlayer(mockClient);
    const result = await player.decideAction(tracker.state, request);

    expect(result.usedFallback).toBe(false);
    expect(result.candidate.id).toBe('move 1');
    expect(result.candidate.choice).toBe('shadowball');
    expect(result.decision?.confidence).toBe(0.95);
  });

  it('should trigger deterministic fallback if AI hallucinates an illegal candidate ID', async () => {
    const { tracker, request } = setupSyntheticBattle();

    const mockClient = new MockLLMClient(() => {
      return JSON.stringify({
        selected_candidate_id: 'move 99', // Hallucinated move!
        action_type: 'move',
        confidence: 0.8,
        opponent_prediction: 'None',
        strategic_rationale: 'Invalid move'
      });
    });

    const player = new AIStrategyPlayer(mockClient);
    const result = await player.decideAction(tracker.state, request);

    expect(result.usedFallback).toBe(true);
    expect(result.rationale).toContain('[SAFETY FALLBACK]');
    expect(result.rationale).toContain('hallucinated illegal candidate ID');
    // Fallback chooses the best legal candidate deterministically
    expect(result.candidate.choice).toBe('shadowball');
  });

  it('should trigger deterministic fallback if AI inference times out', async () => {
    const { tracker, request } = setupSyntheticBattle();

    const hangingClient = new MockLLMClient(async () => {
      // Simulate slow cloud API or local GPU stall
      await new Promise(resolve => setTimeout(resolve, 200));
      return '{}';
    });

    // Timeout configured to 50ms
    const player = new AIStrategyPlayer(hangingClient, { timeoutMs: 50 });
    const result = await player.decideAction(tracker.state, request);

    expect(result.usedFallback).toBe(true);
    expect(result.rationale).toContain('timed out');
    expect(result.candidate.id).toBeDefined();
  });

  it('should play 5 turns in a live in-memory battle with AI decisions', async () => {
    const runner = new BattleRunner();
    const tracker = new StateTracker('gen9randombattle');

    await runner.start({
      formatid: 'gen9randombattle',
      p1Name: 'AI_Player',
      p2Name: 'Bot_Opponent',
      autoOpponent: true
    });

    // AI model that picks the candidate with highest damage or safest switch
    const mockClient = new MockLLMClient(prompt => {
      return JSON.stringify({
        selected_candidate_id: 'move 1',
        action_type: 'move',
        confidence: 0.85,
        opponent_prediction: 'Opponent attacks',
        strategic_rationale: 'Apply aggressive offensive pressure.'
      });
    });

    const player = new AIStrategyPlayer(mockClient);

    for (let turn = 0; turn < 5; turn++) {
      const actionable = await runner.getNextActionableRequest();
      if (!actionable) break;

      tracker.processLines(actionable.rawLines);
      tracker.updateFromRequest(actionable.request);

      const result = await player.decideAction(tracker.state, actionable.request);
      expect(result.candidate.id).toBeDefined();

      await runner.chooseP1(result.candidate.id);
    }

    expect(tracker.state.turn).toBeGreaterThanOrEqual(3);
  });
});
