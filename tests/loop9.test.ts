import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runLoop9SelfImprovementMonitoring } from '../src/loop9-runner.js';
import { FailureCategorizer } from '../src/monitoring/failure-categorizer.js';

describe('LOOP 9: Self-Improvement Monitoring', () => {
  it('should categorize failures, produce diffable cross-cycle report, and feed back into training', async () => {
    const summary = await runLoop9SelfImprovementMonitoring();

    expect(summary.passed).toBe(true);
    expect(summary.diffReport.categoryDiffs.length).toBe(6);
    expect(fs.existsSync(summary.reportJsonPath)).toBe(true);
    expect(fs.existsSync(summary.reportMdPath)).toBe(true);
    expect(summary.targetedCasesCount).toBeGreaterThan(0);
    expect(summary.fedBackIntoTraining).toBe(true);

    // Verify diffable trends
    for (const diff of summary.diffReport.categoryDiffs) {
      expect(['DECREASING', 'INCREASING', 'UNCHANGED']).toContain(diff.trend);
      expect(typeof diff.delta).toBe('number');
    }
  });

  it('should correctly detect missed KOs when lethal attack is skipped', () => {
    const fakeState: any = {
      turn: 1,
      format: 'gen9randombattle',
      field: { p1Hazards: {}, p2Hazards: {} },
      p1: { active: { species: 'Pikachu', hpPercent: 100, stats: { spe: 100 } }, team: [] },
      p2: { active: { species: 'Squirtle', hpPercent: 20, stats: { spe: 80 } }, team: [] }
    };

    const lethalCandidate: any = {
      id: 'move 1',
      name: 'Thunderbolt',
      type: 'move',
      choice: 'move 1',
      slot: 1,
      evaluation: {
        minDamagePercent: 45,
        maxDamagePercent: 60,
        koProbability: 1.0,
        outspeeds: true,
        priority: 0,
        hazardDamagePercent: 0,
        description: 'Lethal Thunderbolt'
      }
    };

    const weakCandidate: any = {
      id: 'move 2',
      name: 'Quick Attack',
      type: 'move',
      choice: 'move 2',
      slot: 2,
      evaluation: {
        minDamagePercent: 10,
        maxDamagePercent: 15,
        koProbability: 0.0,
        outspeeds: true,
        priority: 1,
        hazardDamagePercent: 0,
        description: 'Weak Quick Attack'
      }
    };

    const exp: any = {
      battleId: 'test_b1',
      turn: 1,
      step: 1,
      state: fakeState,
      available_actions: [lethalCandidate, weakCandidate],
      selected_action: 'move 2', // Chose weak attack instead of lethal KO
      result: { rawLines: [], terminal: false },
      reward: 0.5,
      next_state: fakeState
    };

    const report = FailureCategorizer.analyzeExperiences([exp], 'test_cycle');
    expect(report.categoryCounts.missed_kos).toBe(1);
    expect(report.incidents[0].category).toBe('missed_kos');
    expect(report.incidents[0].recommendedAction).toBe('move 1');

    // Auto-convert to targeted cases
    const targeted = FailureCategorizer.autoConvertFailuresToTrainingCases(report, [exp]);
    expect(targeted.length).toBe(1);
    expect(targeted[0].correctAction).toBe('move 1');
    expect(targeted[0].penalizedAction).toBe('move 2');
  });
});
