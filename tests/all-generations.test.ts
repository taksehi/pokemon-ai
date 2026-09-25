import { describe, it, expect } from 'vitest';
import { BattleRunner } from '../src/sim/battle-runner.js';
import { StateTracker } from '../src/battle/state-tracker.js';
import { CandidateGenerator } from '../src/strategy/candidate-generator.js';
import { BaselineEngine } from '../src/strategy/baseline-engine.js';
import { NeuralEngine } from '../src/strategy/neural-engine.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { NeuralValueModel } from '../src/model/model-artifact.js';
import { ALL_GEN_FORMATS } from '../src/train-all-gens.js';

describe('All-Generations (Gen 1-9) Random Battle Integration & Heuristics', () => {
  it('should run a complete battle to conclusion in all 9 generations (Gen 1 to Gen 9)', async () => {
    for (const formatid of ALL_GEN_FORMATS) {
      const runner = new BattleRunner();
      const tracker = new StateTracker(formatid);

      await runner.start({
        formatid,
        p1Name: 'Agent_P1',
        p2Name: 'Bot_P2',
        autoOpponent: true
      });

      let decisions = 0;
      let winner = 'Unknown';

      while (true) {
        const actionable = await runner.getNextActionableRequest();
        if (!actionable) {
          for (const line of runner.accumulatedLines) {
            if (line.startsWith('|win|')) winner = line.split('|')[2]?.trim() || 'Unknown';
            if (line.startsWith('|tie|')) winner = 'Tie';
          }
          break;
        }

        tracker.processLines(actionable.rawLines);
        tracker.updateFromRequest(actionable.request);

        const candidates = CandidateGenerator.generateCandidates(tracker.state, actionable.request);
        expect(candidates.length).toBeGreaterThan(0);

        const decision = BaselineEngine.selectBestAction(tracker.state, actionable.request);
        expect(decision.candidate.id).toBeTruthy();
        expect(decision.score).toBeDefined();

        decisions++;
        await runner.chooseP1(decision.candidate.id);
      }

      runner.destroy();
      expect(decisions).toBeGreaterThan(0);
      expect(['Agent_P1', 'Bot_P2', 'Tie']).toContain(winner);
    }
  }, 40000);

  it('should execute NeuralEngine evaluations across all 9 generations with active model', () => {
    const pointer = ModelRegistry.getActivePointer();
    const model = NeuralValueModel.loadFromFile(pointer.activeModelPath);

    for (const formatid of ALL_GEN_FORMATS) {
      const tracker = new StateTracker(formatid);
      // Mock request payload
      const mockReq: any = {
        active: [{
          moves: [
            { move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35, target: 'normal', disabled: false },
            { move: 'Quick Attack', id: 'quickattack', pp: 30, maxpp: 30, target: 'normal', disabled: false }
          ]
        }],
        side: {
          pokemon: [{
            ident: 'p1: Pikachu',
            details: 'Pikachu, L50',
            condition: '100/100',
            active: true,
            stats: { atk: 55, def: 40, spa: 50, spd: 50, spe: 90 },
            moves: ['tackle', 'quickattack'],
            baseAbility: 'static',
            item: '',
            pokeball: 'pokeball'
          }]
        }
      };

      tracker.updateFromRequest(mockReq);
      const decision = NeuralEngine.selectBestAction(model, tracker.state, mockReq);
      expect(decision.candidate).toBeDefined();
      expect(['move 1', 'move 2']).toContain(decision.candidate.id);
    }
  });

  it('should apply Gen 1 specific mechanics (Hyper Beam KO no-recharge bonus)', () => {
    const tracker = new StateTracker('gen1randombattle');
    tracker.state.p1.active = {
      ident: 'p1: Tauros',
      species: 'Tauros',
      level: 100,
      gender: '',
      currentHp: 100,
      maxHp: 100,
      hpPercent: 100,
      status: null,
      types: ['Normal'],
      item: null,
      ability: null,
      stats: { atk: 100, def: 95, spa: 70, spd: 70, spe: 110 },
      boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
      moves: [{ id: 'hyperbeam', name: 'Hyper Beam', pp: 5, maxpp: 5, disabled: false }],
      fainted: false,
      active: true,
      teraType: null,
      terastallized: false
    };
    tracker.state.p2.active = {
      ident: 'p2: Alakazam',
      species: 'Alakazam',
      level: 100,
      gender: '',
      hpPercent: 15,
      status: null,
      fainted: false,
      active: true,
      revealedMoves: ['psychic'],
      revealedAbility: null,
      revealedItem: null,
      teraType: null,
      terastallized: false,
      boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 }
    };

    const mockReq: any = {
      active: [{
        moves: [{ move: 'Hyper Beam', id: 'hyperbeam', pp: 5, maxpp: 5, target: 'normal', disabled: false }]
      }],
      side: {
        pokemon: [{
          ident: 'p1: Tauros',
          details: 'Tauros, L100',
          condition: '100/100',
          active: true,
          stats: { atk: 100, def: 95, spa: 70, spd: 70, spe: 110 },
          moves: ['hyperbeam']
        }]
      }
    };

    const scored = BaselineEngine.scoreCandidate(tracker.state, mockReq, {
      id: 'move 1',
      type: 'move',
      choice: 'hyperbeam',
      name: 'Hyper Beam',
      slot: 1,
      evaluation: {
        minDamagePercent: 60,
        maxDamagePercent: 80,
        koProbability: 1.0,
        outspeeds: false,
        priority: 0,
        hazardDamagePercent: 0,
        description: 'Hyper Beam'
      }
    });

    expect(scored.breakdown.some(b => b.includes('Gen 1 Hyper Beam lethal strike'))).toBe(true);
  });
});
