import fs from 'node:fs';
import path from 'node:path';
import { NeuralValueModel } from './model-artifact.js';

export interface ActiveModelPointer {
  activeVersion: string;
  activeModelPath: string;
  updatedAt: string;
  reason?: string;
}

export class ModelRegistry {
  private static registryPath = path.resolve(process.cwd(), 'data', 'models', 'active_model.json');

  public static setRegistryPath(customPath: string): void {
    this.registryPath = customPath;
  }

  public static getRegistryPath(): string {
    return this.registryPath;
  }

  /**
   * Initializes active model pointer if it doesn't already exist.
   */
  public static ensureInitialized(defaultVersion: string = 'v0', defaultPath?: string): ActiveModelPointer {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.registryPath)) {
      const p = defaultPath ?? path.join(dir, `model_${defaultVersion}.json`);
      const pointer: ActiveModelPointer = {
        activeVersion: defaultVersion,
        activeModelPath: p,
        updatedAt: new Date().toISOString(),
        reason: 'Initial setup'
      };
      fs.writeFileSync(this.registryPath, JSON.stringify(pointer, null, 2), 'utf8');
      return pointer;
    }

    return this.getActivePointer();
  }

  public static getActivePointer(): ActiveModelPointer {
    if (!fs.existsSync(this.registryPath)) {
      return this.ensureInitialized();
    }
    const raw = fs.readFileSync(this.registryPath, 'utf8');
    return JSON.parse(raw);
  }

  public static getActiveModel(): { version: string; modelPath: string; model: NeuralValueModel } {
    const pointer = this.getActivePointer();
    const model = NeuralValueModel.loadFromFile(pointer.activeModelPath);
    return {
      version: pointer.activeVersion,
      modelPath: pointer.activeModelPath,
      model
    };
  }

  public static setActivePointer(version: string, modelPath: string, reason?: string): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const pointer: ActiveModelPointer = {
      activeVersion: version,
      activeModelPath: modelPath,
      updatedAt: new Date().toISOString(),
      reason: reason ?? 'Model evaluation promotion'
    };
    fs.writeFileSync(this.registryPath, JSON.stringify(pointer, null, 2), 'utf8');
  }
}
