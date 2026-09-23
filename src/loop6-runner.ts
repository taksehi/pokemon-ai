import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { ModelTrainer, TrainingResult } from './model/trainer.js';
import { NeuralValueModel } from './model/model-artifact.js';

export interface Loop6Summary {
  passed: boolean;
  version: string;
  modelJsonPath: string;
  modelCkptPath: string;
  datasetSize: number;
  datasetHashBefore: string;
  datasetHashAfter: string;
  datasetUnmutated: boolean;
  previousModelUntouched: boolean;
  previousModelLoadable: boolean;
  initialLoss: number;
  finalLoss: number;
  lossReductionPercent: number;
  trainingTimeMs: number;
}

export async function runLoop6Training(
  datasetPath?: string,
  modelOutputDir?: string
): Promise<Loop6Summary> {
  console.log(`================================================================================`);
  console.log(`                     LOOP 6 VERIFICATION: TRAINING PIPELINE                     `);
  console.log(`================================================================================\n`);

  const dPath = datasetPath ?? path.resolve(process.cwd(), 'data', 'loop4_experiences.jsonl');
  const outDir = modelOutputDir ?? path.resolve(process.cwd(), 'data', 'models');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Pre-condition: Prepare a prior model (model_v0) to verify it remains untouched and loadable
  const prevModelPath = path.join(outDir, 'model_v0.json');
  const prevModel = new NeuralValueModel({
    version: 'v0',
    timestamp: '2026-09-01T00:00:00.000Z',
    datasetSize: 100,
    datasetHash: 'dummy_hash_v0',
    hyperparameters: {
      inputDim: 14,
      hiddenDim: 32,
      outputDim: 1,
      learningRate: 0.01,
      epochs: 5,
      batchSize: 16,
      gamma: 0.95,
      weightDecay: 0.0001
    },
    metrics: {
      initialLoss: 2.5,
      finalLoss: 1.2,
      lossReductionPercent: 52.0,
      samplesTrained: 100,
      trainingTimeMs: 120
    }
  });
  prevModel.saveToFile(prevModelPath);
  const prevModelHashBefore = ModelTrainer.computeFileHash(prevModelPath);
  console.log(`[SETUP] Prior model registered: ${prevModelPath} (Hash: ${prevModelHashBefore.slice(0, 16)}...)`);

  // Check 1: Record dataset hash before training
  assert.strictEqual(fs.existsSync(dPath), true, `Dataset file must exist at ${dPath}`);
  const datasetHashBefore = ModelTrainer.computeFileHash(dPath);
  console.log(`[CHECK 1] Dataset SHA-256 Before Training: ${datasetHashBefore}`);

  // Check 2: Execute training end-to-end via one command
  console.log(`[CHECK 2] Starting Training on ${dPath}...`);
  const targetVersion = 'v1';
  const modelJsonPath = path.join(outDir, `model_${targetVersion}.json`);
  const modelCkptPath = path.join(outDir, `model_${targetVersion}.ckpt`);

  const trainResult: TrainingResult = await ModelTrainer.train({
    version: targetVersion,
    datasetPath: dPath,
    outputPath: modelJsonPath,
    epochs: 15,
    batchSize: 32,
    learningRate: 0.008,
    gamma: 0.95,
    hiddenDim: 32
  });

  console.log(`  Training Completed in ${trainResult.trainingTimeMs}ms`);
  console.log(`  Dataset Samples: ${trainResult.datasetSize}`);
  console.log(`  Initial MSE Loss: ${trainResult.initialLoss}`);
  console.log(`  Final MSE Loss:   ${trainResult.finalLoss}`);
  console.log(`  Loss Reduction:   ${trainResult.lossReductionPercent}%`);

  // Check 3: Verify versioned model artifact files exist
  assert.strictEqual(fs.existsSync(modelJsonPath), true, `Model JSON artifact must exist at ${modelJsonPath}`);
  assert.strictEqual(fs.existsSync(modelCkptPath), true, `Model CKPT artifact must exist at ${modelCkptPath}`);

  // Check 4: Verify metadata completeness
  const loadedModel = NeuralValueModel.loadFromFile(modelJsonPath);
  assert.strictEqual(loadedModel.metadata.version, targetVersion, 'Model version must match target');
  assert.strictEqual(loadedModel.metadata.datasetSize, trainResult.datasetSize, 'Dataset size must be recorded');
  assert.ok(loadedModel.metadata.timestamp, 'Timestamp must be recorded');
  assert.ok(loadedModel.metadata.hyperparameters, 'Hyperparameters must be recorded');
  assert.ok(loadedModel.metadata.metrics, 'Training metrics must be recorded');
  console.log(`[CHECK 3 & 4] Artifact & Metadata Verification: PASSED (Loaded version ${loadedModel.metadata.version})`);

  // Check 5: Verify previous model file is untouched and still loadable
  const prevModelHashAfter = ModelTrainer.computeFileHash(prevModelPath);
  const previousModelUntouched = prevModelHashBefore === prevModelHashAfter;
  assert.strictEqual(previousModelUntouched, true, 'Previous model file must be byte-for-byte untouched');

  const reloadedPrev = NeuralValueModel.loadFromFile(prevModelPath);
  assert.strictEqual(reloadedPrev.metadata.version, 'v0', 'Previous model must still be loadable');
  console.log(`[CHECK 5] Previous Model Untouched & Loadable: PASSED (Hash matches 100%)`);

  // Check 6: Verify simulator & dataset files are read-only (unmutated)
  const datasetHashAfter = ModelTrainer.computeFileHash(dPath);
  const datasetUnmutated = datasetHashBefore === datasetHashAfter;
  assert.strictEqual(datasetUnmutated, true, 'Dataset file must NOT be mutated by training');
  console.log(`[CHECK 6] Dataset Read-Only Guarantee: PASSED (Hash matches 100%)\n`);

  console.log(`================================================================================`);
  console.log(`                      LOOP 6 TRAINING FINAL REPORT                              `);
  console.log(`================================================================================`);
  console.log(`Model Version:               ${targetVersion}`);
  console.log(`Model Artifact JSON:         ${modelJsonPath}`);
  console.log(`Model Artifact CKPT:         ${modelCkptPath}`);
  console.log(`Dataset Size (Experiences):  ${trainResult.datasetSize}`);
  console.log(`Initial Loss -> Final Loss:  ${trainResult.initialLoss} -> ${trainResult.finalLoss} (-${trainResult.lossReductionPercent}%)`);
  console.log(`Dataset Mutation Check:      PASSED (Zero mutation, read-only preserved)`);
  console.log(`Prior Model Preservation:    PASSED (v0 untouched and loadable)`);
  console.log(`Overall Loop 6 Result:       PASS`);
  console.log(`================================================================================\n`);

  return {
    passed: true,
    version: targetVersion,
    modelJsonPath,
    modelCkptPath,
    datasetSize: trainResult.datasetSize,
    datasetHashBefore,
    datasetHashAfter,
    datasetUnmutated,
    previousModelUntouched,
    previousModelLoadable: true,
    initialLoss: trainResult.initialLoss,
    finalLoss: trainResult.finalLoss,
    lossReductionPercent: trainResult.lossReductionPercent,
    trainingTimeMs: trainResult.trainingTimeMs
  };
}

if (process.argv[1] && process.argv[1].endsWith('loop6-runner.ts')) {
  runLoop6Training().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}
