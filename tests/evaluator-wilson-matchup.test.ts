import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { ModelEvaluator, StrategyPlayerController } from '../src/model/evaluator.js';
import { AIStrategyPlayer } from '../src/ai/strategy-player.js';
import { BaselineEngine } from '../src/strategy/baseline-engine.js';
import { StateTracker } from '../src/battle/state-tracker.js';
import { LLMClient } from '../src/ai/llm-client.js';

describe('Statistical Wilson Gate & Mode Matchups', () => {
  it('should accurately calculate Wilson lower bound confidence intervals', () => {
    // 0 battles
    expect(ModelEvaluator.wilson(0, 0)).toBe(0);

    // 10 out of 10 wins (100% win rate) has high confidence lower bound (> 0.50)
    const w10of10 = ModelEvaluator.wilson(10, 10, 1.96);
    expect(w10of10).toBeGreaterThan(0.70);

    // 5 out of 10 wins (50% win rate) has lower bound significantly under 0.50 due to small sample size
    const w5of10 = ModelEvaluator.wilson(5, 10, 1.96);
    expect(w5of10).toBeLessThan(0.30);
    expect(w5of10).toBeGreaterThan(0.15);

    // 55 out of 100 wins (55%) at 100 battles still has lower bound < 0.50
    const w55of100 = ModelEvaluator.wilson(55, 100, 1.96);
    expect(w55of100).toBeLessThan(0.50);

    // 600 out of 1000 wins (60%) at 1000 battles has lower bound > 0.50
    const w600of1000 = ModelEvaluator.wilson(600, 1000, 1.96);
    expect(w600of1000).toBeGreaterThan(0.55);
  });

  it('should accurately track fallback count and fallbackRate in AIStrategyPlayer', async () => {
    // Mock failing LLM client that triggers safety fallback
    const failingLlm: LLMClient = {
      generate: async () => { throw new Error('API Rate Limit or Network Failure'); }
    };

    const player = new AIStrategyPlayer(failingLlm, { timeoutMs: 100 });
    expect(player.getStats().totalDecisions).toBe(0);
    expect(player.getStats().fallbackCount).toBe(0);
    expect(player.getStats().fallbackRate).toBe(0);

    const tracker = new StateTracker('gen9randombattle');
    tracker.processLines([
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Dragapult|Dragapult, L100, M|317/317',
      '|switch|p2a: Gholdengo|Gholdengo, L100|70/100'
    ]);
    const dummyRequest = {
      rqid: 1,
      active: [{
        moves: [{ move: 'Shadow Ball', id: 'shadowball', pp: 24, maxpp: 24, target: 'normal', disabled: false }]
      }],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [{
          ident: 'p1: Dragapult',
          details: 'Dragapult, L100, M',
          condition: '317/317',
          active: true,
          stats: { atk: 256, def: 186, spa: 299, spd: 186, spe: 421 },
          moves: ['shadowball'],
          baseAbility: 'infiltrator',
          item: 'choicespecs',
          pokeball: 'pokeball'
        }]
      }
    };
    tracker.updateFromRequest(dummyRequest);

    const res = await player.decideAction(tracker.state, dummyRequest);
    expect(res.usedFallback).toBe(true);
    expect(res.fallbackCount).toBe(1);
    expect(res.fallbackRate).toBe(1.0);

    const stats = player.getStats();
    expect(stats.totalDecisions).toBe(1);
    expect(stats.fallbackCount).toBe(1);
    expect(stats.fallbackRate).toBe(1.0);

    player.resetStats();
    expect(player.getStats().totalDecisions).toBe(0);
    expect(player.getStats().fallbackCount).toBe(0);
  });

  it('should run a head-to-head matchup evaluation between two strategy controllers on held-out seeds', async () => {
    const reportPath = path.resolve(process.cwd(), 'data', 'test_matchup_report.json');

    const baselinePlayer1: StrategyPlayerController = {
      name: 'Baseline_Alpha',
      decide: (state, req) => BaselineEngine.selectBestAction(state, req).candidate.id,
      getStats: () => ({ totalDecisions: 10, fallbackCount: 0, fallbackRate: 0 })
    };

    const baselinePlayer2: StrategyPlayerController = {
      name: 'Baseline_Beta',
      decide: (state, req) => BaselineEngine.selectBestAction(state, req).candidate.id,
      getStats: () => ({ totalDecisions: 10, fallbackCount: 0, fallbackRate: 0 })
    };

    const report = await ModelEvaluator.evaluateMatchup({
      player1: baselinePlayer1,
      player2: baselinePlayer2,
      numRounds: 1, // 2 games
      seedBase: 780000,
      reportJsonPath: reportPath
    });

    expect(report.totalBattles).toBe(2);
    expect(report.p1Name).toBe('Baseline_Alpha');
    expect(report.p2Name).toBe('Baseline_Beta');
    expect(report.heldOutSeedRange).toContain('780000');
    expect(report.wilsonLowerBoundPercent).toBeDefined();
    expect(fs.existsSync(reportPath)).toBe(true);

    // Clean up
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    const mdPath = reportPath.replace(/\.json$/, '.md');
    if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
  }, 30000);
});
