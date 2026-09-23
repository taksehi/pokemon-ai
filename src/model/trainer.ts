import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { extractFeatures, FEATURE_VECTOR_SIZE } from './feature-extractor.js';
import { NeuralValueModel, ModelWeights, ModelMetadata } from './model-artifact.js';

export interface TrainingOptions {
  version: string;
  datasetPath: string;
  outputPath: string;
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  gamma?: number;
  hiddenDim?: number;
}

export interface TrainingResult {
  version: string;
  model: NeuralValueModel;
  modelPath: string;
  datasetSize: number;
  datasetHash: string;
  initialLoss: number;
  finalLoss: number;
  lossReductionPercent: number;
  trainingTimeMs: number;
}

interface TrainingSample {
  features: number[];
  target: number;
}

export class ModelTrainer {
  /**
   * Reads dataset (.jsonl), verifies read-only access (no mutation), computes dataset hash,
   * trains the neural value model with backpropagation, and outputs the versioned artifact.
   */
  public static async train(options: TrainingOptions): Promise<TrainingResult> {
    const startTime = Date.now();
    const epochs = options.epochs ?? 12;
    const batchSize = options.batchSize ?? 32;
    const learningRate = options.learningRate ?? 0.005;
    const gamma = options.gamma ?? 0.95;
    const hiddenDim = options.hiddenDim ?? 32;

    if (!fs.existsSync(options.datasetPath)) {
      throw new Error(`Dataset file not found: ${options.datasetPath}`);
    }

    // 1. Verify dataset integrity & read-only guarantee: capture SHA-256 before training
    const initialHash = this.computeFileHash(options.datasetPath);

    // 2. Load and parse experiences
    const samples = await this.loadDataset(options.datasetPath, gamma);
    if (samples.length === 0) {
      throw new Error(`No valid training samples could be extracted from ${options.datasetPath}`);
    }

    // 3. Initialize model
    const inputDim = FEATURE_VECTOR_SIZE;
    const model = new NeuralValueModel(
      {
        version: options.version,
        timestamp: new Date().toISOString(),
        datasetSize: samples.length,
        datasetHash: initialHash,
        hyperparameters: {
          inputDim,
          hiddenDim,
          outputDim: 1,
          learningRate,
          epochs,
          batchSize,
          gamma,
          weightDecay: 0.0001
        },
        metrics: {
          initialLoss: 0,
          finalLoss: 0,
          lossReductionPercent: 0,
          samplesTrained: samples.length,
          trainingTimeMs: 0
        }
      }
    );

    // 4. Compute Initial Loss
    const initialLoss = this.evaluateLoss(model, samples);

    // 5. Training with mini-batch SGD + Momentum
    const weights = model.weights;
    const momentumW1 = weights.W1.map(row => row.map(() => 0));
    const momentumb1 = weights.b1.map(() => 0);
    const momentumW2 = weights.W2.map(row => row.map(() => 0));
    const momentumb2 = weights.b2.map(() => 0);
    const beta = 0.9; // momentum factor

    for (let ep = 0; ep < epochs; ep++) {
      // Shuffle samples per epoch
      this.shuffle(samples);

      for (let b = 0; b < samples.length; b += batchSize) {
        const batch = samples.slice(b, b + batchSize);
        const gradW1 = weights.W1.map(row => row.map(() => 0));
        const gradb1 = weights.b1.map(() => 0);
        const gradW2 = weights.W2.map(row => row.map(() => 0));
        const gradb2 = weights.b2.map(() => 0);

        for (const sample of batch) {
          const { output, hidden } = model.forward(sample.features);
          // MSE Loss: (output - target)^2 -> dLoss/dOutput = 2 * (output - target)
          const error = output - sample.target;
          const dOutput = 2 * Math.max(-10, Math.min(10, error)); // Gradient clipping

          // Gradients for Layer 2: output = Hidden * W2 + b2
          gradb2[0] += dOutput;
          for (let j = 0; j < hiddenDim; j++) {
            gradW2[j][0] += dOutput * hidden[j];
          }

          // Backpropagation into Layer 1 (ReLU derivative)
          for (let j = 0; j < hiddenDim; j++) {
            if (hidden[j] > 0) { // ReLU active
              const dHidden_j = dOutput * weights.W2[j][0];
              gradb1[j] += dHidden_j;
              for (let i = 0; i < inputDim; i++) {
                gradW1[i][j] += dHidden_j * sample.features[i];
              }
            }
          }
        }

        // Apply average gradients with momentum
        const N = batch.length;
        // Layer 2
        for (let j = 0; j < hiddenDim; j++) {
          momentumW2[j][0] = beta * momentumW2[j][0] + (1 - beta) * (gradW2[j][0] / N);
          weights.W2[j][0] -= learningRate * momentumW2[j][0];
        }
        momentumb2[0] = beta * momentumb2[0] + (1 - beta) * (gradb2[0] / N);
        weights.b2[0] -= learningRate * momentumb2[0];

        // Layer 1
        for (let i = 0; i < inputDim; i++) {
          for (let j = 0; j < hiddenDim; j++) {
            momentumW1[i][j] = beta * momentumW1[i][j] + (1 - beta) * (gradW1[i][j] / N);
            weights.W1[i][j] -= learningRate * momentumW1[i][j];
          }
        }
        for (let j = 0; j < hiddenDim; j++) {
          momentumb1[j] = beta * momentumb1[j] + (1 - beta) * (gradb1[j] / N);
          weights.b1[j] -= learningRate * momentumb1[j];
        }
      }
    }

    // 6. Compute Final Loss
    const finalLoss = this.evaluateLoss(model, samples);
    const lossReduction = initialLoss > 0
      ? Math.max(0, ((initialLoss - finalLoss) / initialLoss) * 100)
      : 0;

    const trainingTimeMs = Date.now() - startTime;
    model.metadata.metrics = {
      initialLoss,
      finalLoss,
      lossReductionPercent: Number(lossReduction.toFixed(2)),
      samplesTrained: samples.length,
      trainingTimeMs
    };

    // 7. Verify dataset was strictly read-only and unmutated
    const postHash = this.computeFileHash(options.datasetPath);
    if (initialHash !== postHash) {
      throw new Error(`CRITICAL INTEGRITY VIOLATION: Dataset ${options.datasetPath} was modified during training!`);
    }

    // 8. Save the versioned artifact
    model.saveToFile(options.outputPath);

    return {
      version: options.version,
      model,
      modelPath: options.outputPath,
      datasetSize: samples.length,
      datasetHash: initialHash,
      initialLoss,
      finalLoss,
      lossReductionPercent: Number(lossReduction.toFixed(2)),
      trainingTimeMs
    };
  }

  /**
   * Computes SHA-256 hash of a file on disk.
   */
  public static computeFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Evaluates Mean Squared Error (MSE) loss across samples.
   */
  private static evaluateLoss(model: NeuralValueModel, samples: TrainingSample[]): number {
    let totalLoss = 0;
    for (const sample of samples) {
      const pred = model.predict(sample.features);
      const diff = pred - sample.target;
      totalLoss += diff * diff;
    }
    return Number((totalLoss / samples.length).toFixed(4));
  }

  /**
   * Parses JSONL experiences and constructs training samples.
   */
  private static async loadDataset(filePath: string, gamma: number): Promise<TrainingSample[]> {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    // Group experiences by battleId to compute discounted returns
    const battles: Record<string, any[]> = {};

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed);
        const bId = record.battleId || 'default';
        if (!battles[bId]) battles[bId] = [];
        battles[bId].push(record);
      } catch {
        // Skip malformed lines if any
      }
    }

    const samples: TrainingSample[] = [];

    for (const bId of Object.keys(battles)) {
      const recs = battles[bId];
      // Compute discounted Monte Carlo return G_t for each step: G_t = sum_{k=0} gamma^k * r_{t+k}
      let runningReturn = 0;
      const returns: number[] = new Array(recs.length).fill(0);
      for (let i = recs.length - 1; i >= 0; i--) {
        const r = typeof recs[i].reward === 'number' ? recs[i].reward : 0;
        runningReturn = r + gamma * runningReturn;
        returns[i] = runningReturn;
      }

      for (let i = 0; i < recs.length; i++) {
        const rec = recs[i];
        if (!rec.state) continue;
        const actionStr = rec.selected_action || rec.selectedAction || 'move 1';
        const features = extractFeatures(rec.state, actionStr);
        // Normalize target to reasonable range [-10, 10]
        const target = Math.max(-10, Math.min(10, returns[i]));
        samples.push({ features, target });
      }
    }

    return samples;
  }

  private static shuffle<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}
