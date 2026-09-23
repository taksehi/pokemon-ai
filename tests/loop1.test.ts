import { describe, it, expect } from 'vitest';
import { runLoop1BattleClean, runLoop1Verification } from '../src/loop1-runner.js';

describe('LOOP 1: Single Automated Battle Verification', () => {
  it('should complete 1 battle start-to-finish with 100% legal actions and valid state diffs', async () => {
    const result = await runLoop1BattleClean(1, { verbose: false });

    expect(result.crashes).toBe(0);
    expect(result.retries).toBe(0);
    expect(result.totalTurns).toBeGreaterThan(0);
    expect(result.totalSteps).toBeGreaterThan(0);
    expect(result.allActionsLegal).toBe(true);
    expect(result.allStateDiffsValid).toBe(true);
    expect(result.unambiguousWinner).toBe(true);
    expect(['Loop1_Agent', 'Showdown_Sim', 'Tie']).toContain(result.winner);
    expect(result.passed).toBe(true);
  }, 25000);

  it('should verify 5 back-to-back battles with zero illegal actions, zero state diff errors, and zero retries', async () => {
    const summary = await runLoop1Verification(5);

    expect(summary.totalBattles).toBe(5);
    expect(summary.passedBattles).toBe(5);
    expect(summary.failedBattles).toBe(0);
    expect(summary.totalIllegalActions).toBe(0);
    expect(summary.totalStateDiffErrors).toBe(0);
    expect(summary.totalCrashes).toBe(0);
    expect(summary.totalRetries).toBe(0);
    expect(summary.allPass).toBe(true);
  }, 60000);
});
