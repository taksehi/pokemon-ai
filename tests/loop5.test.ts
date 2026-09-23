import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { runDeterministicSeedComparison, runBaselineEvaluation } from '../src/loop5-runner.js';

describe('LOOP 5: Baseline Evaluation', () => {
  const testReportJson = path.resolve(process.cwd(), 'data', 'test_baseline_eval_report.json');
  const testReportMd = path.resolve(process.cwd(), 'data', 'test_baseline_eval_report.md');

  afterAll(() => {
    if (fs.existsSync(testReportJson)) try { fs.unlinkSync(testReportJson); } catch {}
    if (fs.existsSync(testReportMd)) try { fs.unlinkSync(testReportMd); } catch {}
  });

  it('should prove fixed seed produces byte-for-byte identical logs across 2 separate runs', async () => {
    const seedResult = await runDeterministicSeedComparison([77, 88, 99, 11]);

    expect(seedResult.identical).toBe(true);
    expect(seedResult.hash1).toBe(seedResult.hash2);
    expect(seedResult.log1).toBe(seedResult.log2);
  }, 20000);

  it('should run full baseline evaluation via one command and auto-record metrics to file', async () => {
    const report = await runBaselineEvaluation(20, testReportJson);

    expect(report.totalBattles).toBe(20);
    expect(report.wins + report.losses + report.draws).toBe(20);
    expect(report.winRatePercent).toBeGreaterThanOrEqual(0);
    expect(report.avgBattleLengthTurns).toBeGreaterThan(0);
    expect(report.topFailureTypes).toHaveLength(3);
    expect(report.seedReproducibilityVerified).toBe(true);
    expect(report.rulesSymmetryVerified).toBe(true);

    expect(fs.existsSync(testReportJson)).toBe(true);
    expect(fs.existsSync(testReportMd)).toBe(true);

    const savedJson = JSON.parse(fs.readFileSync(testReportJson, 'utf-8'));
    expect(savedJson.totalBattles).toBe(20);
    expect(savedJson.topFailureTypes).toHaveLength(3);
  }, 45000);
});
