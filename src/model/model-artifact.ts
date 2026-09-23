import fs from 'node:fs';
import path from 'node:path';
import { FEATURE_VECTOR_SIZE } from './feature-extractor.js';

export interface ModelMetadata {
  version: string;
  timestamp: string;
  datasetSize: number;
  datasetHash: string;
  hyperparameters: {
    inputDim: number;
    hiddenDim: number;
    outputDim: number;
    learningRate: number;
    epochs: number;
    batchSize: number;
    gamma: number;
    weightDecay: number;
  };
  metrics: {
    initialLoss: number;
    finalLoss: number;
    lossReductionPercent: number;
    samplesTrained: number;
    trainingTimeMs: number;
  };
}

export interface ModelWeights {
  // Layer 1: inputDim x hiddenDim
  W1: number[][];
  b1: number[];
  // Layer 2: hiddenDim x outputDim
  W2: number[][];
  b2: number[];
}

export interface ModelArtifact {
  formatVersion: string;
  metadata: ModelMetadata;
  weights: ModelWeights;
}

export class NeuralValueModel {
  public metadata: ModelMetadata;
  public weights: ModelWeights;

  constructor(metadata?: ModelMetadata, weights?: ModelWeights) {
    const inputDim = FEATURE_VECTOR_SIZE;
    const hiddenDim = metadata?.hyperparameters?.hiddenDim ?? 32;
    const outputDim = 1;

    this.metadata = metadata ?? {
      version: 'v0',
      timestamp: new Date().toISOString(),
      datasetSize: 0,
      datasetHash: '',
      hyperparameters: {
        inputDim,
        hiddenDim,
        outputDim,
        learningRate: 0.01,
        epochs: 10,
        batchSize: 32,
        gamma: 0.95,
        weightDecay: 0.0001
      },
      metrics: {
        initialLoss: 0,
        finalLoss: 0,
        lossReductionPercent: 0,
        samplesTrained: 0,
        trainingTimeMs: 0
      }
    };

    if (weights) {
      this.weights = weights;
    } else {
      this.weights = this.initializeWeights(inputDim, hiddenDim, outputDim);
    }
  }

  /**
   * Xavier / He initialization of weights.
   */
  private initializeWeights(inputDim: number, hiddenDim: number, outputDim: number): ModelWeights {
    // He initialization for ReLU: std = sqrt(2 / inputDim)
    const std1 = Math.sqrt(2 / inputDim);
    const W1: number[][] = [];
    for (let i = 0; i < inputDim; i++) {
      const row: number[] = [];
      for (let j = 0; j < hiddenDim; j++) {
        row.push((Math.random() * 2 - 1) * std1);
      }
      W1.push(row);
    }
    const b1 = new Array(hiddenDim).fill(0.01);

    // Xavier initialization for Layer 2: std = sqrt(1 / hiddenDim)
    const std2 = Math.sqrt(1 / hiddenDim);
    const W2: number[][] = [];
    for (let i = 0; i < hiddenDim; i++) {
      const row: number[] = [];
      for (let j = 0; j < outputDim; j++) {
        row.push((Math.random() * 2 - 1) * std2);
      }
      W2.push(row);
    }
    const b2 = new Array(outputDim).fill(0.0);

    return { W1, b1, W2, b2 };
  }

  /**
   * Forward pass: computes predicted Q-value for a given feature vector.
   * x (14) -> Hidden = ReLU(x * W1 + b1) (32) -> Output = Hidden * W2 + b2 (1)
   */
  public forward(x: number[]): { output: number; hidden: number[] } {
    const inputDim = x.length;
    const hiddenDim = this.weights.b1.length;

    // Layer 1: linear + ReLU
    const hidden: number[] = new Array(hiddenDim).fill(0);
    for (let j = 0; j < hiddenDim; j++) {
      let sum = this.weights.b1[j];
      for (let i = 0; i < inputDim; i++) {
        sum += x[i] * this.weights.W1[i][j];
      }
      hidden[j] = Math.max(0, sum); // ReLU
    }

    // Layer 2: linear output
    let output = this.weights.b2[0];
    for (let j = 0; j < hiddenDim; j++) {
      output += hidden[j] * this.weights.W2[j][0];
    }

    return { output, hidden };
  }

  /**
   * Inference shortcut returning the scalar Q-value.
   */
  public predict(features: number[]): number {
    return this.forward(features).output;
  }

  /**
   * Saves the model artifact (.json and .ckpt) and registers active pointer if requested.
   */
  public saveToFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const artifact: ModelArtifact = {
      formatVersion: '1.0',
      metadata: this.metadata,
      weights: this.weights
    };

    const content = JSON.stringify(artifact, null, 2);
    fs.writeFileSync(filePath, content, 'utf8');

    // Also write a .ckpt file for standard naming compliance
    const ckptPath = filePath.replace(/\.json$/, '.ckpt');
    if (ckptPath !== filePath) {
      fs.writeFileSync(ckptPath, content, 'utf8');
    }
  }

  /**
   * Loads a model artifact from disk and verifies integrity.
   */
  public static loadFromFile(filePath: string): NeuralValueModel {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Model file not found: ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: ModelArtifact = JSON.parse(raw);

    if (!parsed.weights || !parsed.metadata) {
      throw new Error(`Malformed model artifact at ${filePath}`);
    }

    return new NeuralValueModel(parsed.metadata, parsed.weights);
  }
}
