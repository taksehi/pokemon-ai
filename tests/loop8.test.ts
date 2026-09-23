import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runLoop8AutonomousCycle } from '../src/loop8-runner.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { NeuralValueModel } from '../src/model/model-artifact.js';

describe('LOOP 8: Autonomous Training Cycle', () => {
  it('should run multiple iterations unattended and maintain unambiguous active model state', async () => {
    // Run 2 iterations with 2 battles and 1 eval round for fast test execution
    const summary = await runLoop8AutonomousCycle(2, 2, 1);

    expect(summary.passed).toBe(true);
    expect(summary.completedIterations).toBe(2);
    expect(summary.iterationResults.length).toBe(2);

    // Verify unique version IDs
    const v1 = summary.iterationResults[0].versionId;
    const v2 = summary.iterationResults[1].versionId;
    expect(v1).not.toBe(v2);

    // Verify active pointer is unambiguous
    const activePointer = ModelRegistry.getActivePointer();
    expect(activePointer.activeVersion).toBeTruthy();
    expect(fs.existsSync(activePointer.activeModelPath)).toBe(true);

    // Verify all prior models are still on disk and loadable
    for (const iter of summary.iterationResults) {
      expect(fs.existsSync(iter.modelPath)).toBe(true);
      const loaded = NeuralValueModel.loadFromFile(iter.modelPath);
      expect(loaded.metadata.version).toBe(iter.versionId);
    }
  }, 60000);
});
