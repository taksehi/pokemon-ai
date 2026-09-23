import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runLoop7Evaluation } from '../src/loop7-runner.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { ModelEvaluator } from '../src/model/evaluator.js';
import { NeuralValueModel } from '../src/model/model-artifact.js';

describe('LOOP 7: Model Evaluation & Promotion', () => {
  it('should run old vs new model evaluation on held-out seeds and enforce pointer safety', async () => {
    const summary = await runLoop7Evaluation(4, 50.0); // 8 fast games
    expect(summary.passed).toBe(true);
    expect(summary.totalBattles).toBe(8);
    expect(summary.activeModelPointerVerified).toBe(true);
    expect(fs.existsSync(summary.reportJsonPath)).toBe(true);
    expect(fs.existsSync(summary.reportMdPath)).toBe(true);
  });

  it('should ensure rejected model never steals active pointer', async () => {
    const modelsDir = path.resolve(process.cwd(), 'data', 'models');
    const oldModelPath = path.join(modelsDir, 'model_v0.json');
    const newModelPath = path.join(modelsDir, 'model_v1.json');

    ModelRegistry.setActivePointer('v0', oldModelPath);

    const report = await ModelEvaluator.evaluateModels({
      oldModelPath,
      newModelPath,
      numRounds: 1, // 2 games
      thresholdWinRate: 100.0, // Guaranteed rejection
      seedBase: 990000
    });

    expect(report.decision).toBe('REJECT');
    const activePointer = ModelRegistry.getActivePointer();
    expect(activePointer.activeVersion).toBe('v0');
  });
});
