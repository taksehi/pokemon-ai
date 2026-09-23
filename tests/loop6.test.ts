import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runLoop6Training } from '../src/loop6-runner.js';
import { NeuralValueModel } from '../src/model/model-artifact.js';
import { extractFeatures, FEATURE_VECTOR_SIZE } from '../src/model/feature-extractor.js';
import { StateTracker } from '../src/battle/state-tracker.js';

describe('LOOP 6: Training Pipeline', () => {
  it('should extract correct feature vectors of size 14', () => {
    const tracker = new StateTracker('gen9randombattle');
    const features = extractFeatures(tracker.state, 'move 1');
    expect(features.length).toBe(FEATURE_VECTOR_SIZE);
    expect(features[0]).toBeGreaterThanOrEqual(0);
    expect(features[0]).toBeLessThanOrEqual(1);
    expect(features[5]).toBe(1); // isAttack
    expect(features[4]).toBe(0); // isSwitch
  });

  it('should run end-to-end training and meet all Loop 6 criteria', async () => {
    const testOutDir = path.resolve(process.cwd(), 'data', 'test_models');
    const result = await runLoop6Training(undefined, testOutDir);

    expect(result.passed).toBe(true);
    expect(result.datasetUnmutated).toBe(true);
    expect(result.previousModelUntouched).toBe(true);
    expect(result.previousModelLoadable).toBe(true);
    expect(result.datasetSize).toBeGreaterThan(0);
    expect(result.finalLoss).toBeLessThan(result.initialLoss);

    // Verify model artifact can perform inference
    const model = NeuralValueModel.loadFromFile(result.modelJsonPath);
    const dummyFeatures = new Array(FEATURE_VECTOR_SIZE).fill(0.5);
    const score = model.predict(dummyFeatures);
    expect(typeof score).toBe('number');
    expect(Number.isNaN(score)).toBe(false);

    // Clean up test models
    if (fs.existsSync(testOutDir)) {
      fs.rmSync(testOutDir, { recursive: true, force: true });
    }
  });
});
