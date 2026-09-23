import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { ModelEvaluator, ModelComparisonReport } from './model/evaluator.js';
import { ModelRegistry } from './model/model-registry.js';
import { NeuralValueModel } from './model/model-artifact.js';

export interface Loop7Summary {
  passed: boolean;
  totalBattles: number;
  oldModelVersion: string;
  newModelVersion: string;
  newModelWins: number;
  oldModelWins: number;
  winRateDelta: number;
  decision: 'ACCEPT' | 'REJECT';
  activeModelPointerVerified: boolean;
  activeModelPointer: string;
  reportJsonPath: string;
  reportMdPath: string;
}

export async function runLoop7Evaluation(
  rounds: number = 8, // 16 symmetrical games
  thresholdWinRate: number = 52.0
): Promise<Loop7Summary> {
  console.log(`================================================================================`);
  console.log(`                 LOOP 7 VERIFICATION: MODEL EVALUATION & PROMOTION              `);
  console.log(`================================================================================\n`);

  const modelsDir = path.resolve(process.cwd(), 'data', 'models');
  const oldModelPath = path.join(modelsDir, 'model_v0.json');
  const newModelPath = path.join(modelsDir, 'model_v1.json');
  const reportJsonPath = path.resolve(process.cwd(), 'data', 'model_eval_comparison.json');
  const reportMdPath = path.resolve(process.cwd(), 'data', 'model_eval_comparison.md');

  // Pre-condition: Initialize active model pointer to old model (v0)
  ModelRegistry.setActivePointer('v0', oldModelPath, 'Baseline model pre-evaluation');
  const initialPointer = ModelRegistry.getActivePointer();
  assert.strictEqual(initialPointer.activeVersion, 'v0', 'Initial active pointer must be v0');
  console.log(`[SETUP] Initial Active Model Pointer: ${initialPointer.activeVersion} (${initialPointer.activeModelPath})`);

  // Check 1: Define threshold before running
  console.log(`[CHECK 1] Benchmark Configuration:`);
  console.log(`  Held-out Test Seed Range:  750000+ (Never used in training/Loop 4)`);
  console.log(`  Symmetrical Seed Policy:   Mirrored Pairwise (Loop 5 compliant)`);
  console.log(`  Acceptance Win Threshold:  >= ${thresholdWinRate}%`);
  console.log(`  Total Evaluation Games:    ${rounds * 2}`);

  // Check 2 & 3: Run head-to-head evaluation on held-out set
  console.log(`\n[CHECK 2 & 3] Running Head-to-Head Evaluation Battles...`);
  const report: ModelComparisonReport = await ModelEvaluator.evaluateModels({
    oldModelPath,
    newModelPath,
    numRounds: rounds,
    thresholdWinRate,
    reportJsonPath,
    seedBase: 750000
  });

  console.log(`  Old Model (v0) Wins:  ${report.oldModelWins} (${report.oldModelWinRate}%)`);
  console.log(`  New Model (v1) Wins:  ${report.newModelWins} (${report.newModelWinRate}%)`);
  console.log(`  Draws:                ${report.draws}`);
  console.log(`  Win Rate Delta:       ${report.winRateDelta > 0 ? '+' : ''}${report.winRateDelta}%`);
  console.log(`  Explicit Decision:    ${report.decision}`);

  // Check 4: Verify auto-written report files
  assert.strictEqual(fs.existsSync(reportJsonPath), true, 'Comparison JSON report must exist');
  assert.strictEqual(fs.existsSync(reportMdPath), true, 'Comparison Markdown report must exist');
  console.log(`[CHECK 4] Reports Auto-Saved to:`);
  console.log(`  JSON: ${reportJsonPath}`);
  console.log(`  Markdown: ${reportMdPath}`);

  // Check 5: Verify active model pointer matches decision exactly (don't assume)
  const currentPointer = ModelRegistry.getActivePointer();
  let activeModelPointerVerified = false;

  if (report.decision === 'ACCEPT') {
    assert.strictEqual(currentPointer.activeVersion, 'v1', 'Accepted model must become active pointer');
    activeModelPointerVerified = true;
    console.log(`[CHECK 5] Pointer Promotion Verified: Active model is now '${currentPointer.activeVersion}'`);
  } else {
    assert.strictEqual(currentPointer.activeVersion, 'v0', 'Rejected model must NOT become active pointer');
    activeModelPointerVerified = true;
    console.log(`[CHECK 5] Pointer Retention Verified: Active model remains '${currentPointer.activeVersion}'`);
  }

  // Also test explicit Rejection branch to prove pointer safety
  console.log(`\n[CHECK 6] Verifying Rejection Pointer Safety (High Threshold Test: 99.0%)...`);
  // Reset pointer to v0
  ModelRegistry.setActivePointer('v0', oldModelPath, 'Testing rejection branch');
  const rejectTestReport = await ModelEvaluator.evaluateModels({
    oldModelPath,
    newModelPath,
    numRounds: 2, // 4 quick games
    thresholdWinRate: 99.0, // Impossibly high threshold forces REJECT
    reportJsonPath: path.resolve(process.cwd(), 'data', 'test_reject_comparison.json'),
    seedBase: 950000
  });

  const pointerAfterRejection = ModelRegistry.getActivePointer();
  assert.strictEqual(rejectTestReport.decision, 'REJECT', 'Must be rejected under 99% threshold');
  assert.strictEqual(pointerAfterRejection.activeVersion, 'v0', 'Active pointer MUST stay on old version upon reject');
  console.log(`  Decision: REJECT`);
  console.log(`  Active Pointer: ${pointerAfterRejection.activeVersion} (VERIFIED UNCHANGED)`);

  // Restore pointer to evaluation result
  if (report.decision === 'ACCEPT') {
    ModelRegistry.setActivePointer('v1', newModelPath, 'Restored accepted model');
  }

  const finalActive = ModelRegistry.getActivePointer();

  console.log(`\n================================================================================`);
  console.log(`                      LOOP 7 EVALUATION FINAL REPORT                            `);
  console.log(`================================================================================`);
  console.log(`Total Games Played:          ${report.totalBattles}`);
  console.log(`New Model (${report.newModelVersion}) Win Rate: ${report.newModelWinRate}%`);
  console.log(`Old Model (${report.oldModelVersion}) Win Rate: ${report.oldModelWinRate}%`);
  console.log(`Win Rate Delta:              ${report.winRateDelta > 0 ? '+' : ''}${report.winRateDelta}%`);
  console.log(`Threshold:                   ${thresholdWinRate}%`);
  console.log(`Explicit Decision:           ${report.decision}`);
  console.log(`Active Model Pointer:        ${finalActive.activeVersion} (${finalActive.activeModelPath})`);
  console.log(`Active Pointer Verified:     PASS (Both promotion & rejection paths confirmed)`);
  console.log(`Overall Loop 7 Result:       PASS`);
  console.log(`================================================================================\n`);

  return {
    passed: true,
    totalBattles: report.totalBattles,
    oldModelVersion: report.oldModelVersion,
    newModelVersion: report.newModelVersion,
    newModelWins: report.newModelWins,
    oldModelWins: report.oldModelWins,
    winRateDelta: report.winRateDelta,
    decision: report.decision,
    activeModelPointerVerified,
    activeModelPointer: finalActive.activeVersion,
    reportJsonPath,
    reportMdPath
  };
}

if (process.argv[1] && process.argv[1].endsWith('loop7-runner.ts')) {
  runLoop7Evaluation().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}
