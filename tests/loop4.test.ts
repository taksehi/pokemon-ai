import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { run100AutonomousBattles } from '../src/loop4-runner.js';

describe('LOOP 4: Multiple Autonomous Battles (100 Battles Unattended)', () => {
  const testSavePath = path.resolve(process.cwd(), 'data', 'test_loop4_experiences.json');

  afterAll(() => {
    if (fs.existsSync(testSavePath)) {
      try {
        fs.unlinkSync(testSavePath);
      } catch {}
    }
  });

  it('should run 100 consecutive battles with zero leaks, 100/100 valid results, and full schema compliance', async () => {
    const summary = await run100AutonomousBattles({
      battleCount: 100,
      verboseInterval: 25,
      experienceSavePath: testSavePath
    });

    expect(summary.totalBattles).toBe(100);
    expect(summary.completedBattles).toBe(100);
    expect(summary.tallySum).toBe(100);
    expect(summary.wins + summary.losses + summary.draws).toBe(100);
    expect(summary.allLoop1CriteriaMet).toBe(true);
    expect(summary.allExperiencesSchemaValid).toBe(true);
    expect(summary.totalExperiencesCollected).toBe(summary.totalSteps);
    expect(summary.memoryLeakDetected).toBe(false);
    expect(summary.memoryGrowthPercent).toBeLessThanOrEqual(20.0);
    expect(summary.allPass).toBe(true);
  }, 120000); // 120s timeout
});
