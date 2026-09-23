import { describe, it, expect } from 'vitest';
import {
  runScenario1,
  runScenario2,
  runScenario3,
  runDeterminismCheck,
  runLoop2Verification
} from '../src/loop2-runner.js';

describe('LOOP 2: Correct Decision Re-evaluation', () => {
  it('Scenario 1: should detect opponent switch to Dondozo same-turn and recalculate matchup against Water wall', () => {
    const res = runScenario1();

    expect(res.sameTurnDetected).toBe(true);
    expect(res.beforeOpponent).toBe('Rillaboom');
    expect(res.afterOpponent).toBe('Dondozo');
    expect(res.beforeMatchup.primaryMoveEffectiveness).toBe(2.0); // Pyro Ball vs Grass
    expect(res.afterMatchup.primaryMoveEffectiveness).toBe(0.5);  // Pyro Ball vs Water
    expect(res.beforeMatchup.isUnfavorable).toBe(false);
    expect(res.afterMatchup.isUnfavorable).toBe(true);
    expect(res.matchupRecalculated).toBe(true);
    expect(res.passed).toBe(true);
  });

  it('Scenario 2: should detect opponent switch to Urshifu same-turn and recalculate threat against lethal Fighting counter', () => {
    const res = runScenario2();

    expect(res.sameTurnDetected).toBe(true);
    expect(res.beforeOpponent).toBe('Pidgeot');
    expect(res.afterOpponent).toBe('Urshifu-Rapid-Strike');
    expect(res.beforeMatchup.isUnfavorable).toBe(false);
    expect(res.afterMatchup.isUnfavorable).toBe(true);
    expect(res.afterMatchup.defensiveMultiplier).toBeGreaterThanOrEqual(2.0);
    expect(res.afterMatchup.maxIncomingDamagePercent).toBeGreaterThanOrEqual(70);
    expect(res.matchupRecalculated).toBe(true);
    expect(res.passed).toBe(true);
  });

  it('Scenario 3: should detect opponent switch to Great Tusk same-turn and update damage from super-effective to 0x immunity', () => {
    const res = runScenario3();

    expect(res.sameTurnDetected).toBe(true);
    expect(res.beforeOpponent).toBe('Corviknight');
    expect(res.afterOpponent).toBe('Great Tusk');
    expect(res.beforeMatchup.primaryMoveEffectiveness).toBe(2.0); // Electric vs Flying
    expect(res.afterMatchup.primaryMoveEffectiveness).toBe(0.0);  // Electric vs Ground (Immune)
    expect(res.afterMatchup.primaryMoveDamageRange?.[1]).toBe(0);
    expect(res.beforeMatchup.topAction).toBe('move 1');           // Electro Drift
    expect(res.afterMatchup.topAction).not.toBe('move 1');       // Re-evaluated to non-immune move
    expect(res.matchupRecalculated).toBe(true);
    expect(res.passed).toBe(true);
  });

  it('Determinism Check: identical state reached two different ways must produce identical decision and score', () => {
    const res = runDeterminismCheck();

    expect(res.identicalStateReached).toBe(true);
    expect(res.decisionAId).toBe(res.decisionBId);
    expect(res.scoreA).toBe(res.scoreB);
    expect(res.breakdownIdentical).toBe(true);
    expect(res.passed).toBe(true);
  });

  it('Full Loop 2 Verification: all 3 scenarios, determinism check, and dynamic recomputation pass', () => {
    const summary = runLoop2Verification();

    expect(summary.scenarios).toHaveLength(3);
    expect(summary.scenarios.every(s => s.passed)).toBe(true);
    expect(summary.determinismCheck.passed).toBe(true);
    expect(summary.noCachedDecisionsVerified).toBe(true);
    expect(summary.allPass).toBe(true);
  });
});
