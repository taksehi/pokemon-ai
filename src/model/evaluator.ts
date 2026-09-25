import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { BattleRunner } from '../sim/battle-runner.js';
import { StateTracker } from '../battle/state-tracker.js';
import { NeuralValueModel } from './model-artifact.js';
import { NeuralEngine } from '../strategy/neural-engine.js';
import { ModelRegistry, ActiveModelPointer } from './model-registry.js';

export interface ModelEvalOptions {
  oldModelPath: string;
  newModelPath: string;
  numRounds?: number; // Each round plays 2 games (mirrored sides)
  thresholdWinRate?: number; // e.g. 52.0
  reportJsonPath?: string;
  seedBase?: number;
  formatid?: string;
  formats?: string[];
  outputComparisonDir?: string;
}

export interface ModelComparisonReport {
  timestamp: string;
  formatid: string;
  formatsEvaluated?: string[];
  oldModelVersion: string;
  oldModelPath: string;
  newModelVersion: string;
  newModelPath: string;
  totalBattles: number;
  newModelWins: number;
  oldModelWins: number;
  draws: number;
  newModelWinRate: number;
  oldModelWinRate: number;
  winRateDelta: number;
  thresholdWinRate: number;
  decision: 'ACCEPT' | 'REJECT';
  activeModelPointerBefore: string;
  activeModelPointerAfter: string;
  seedPolicy: string;
  heldOutSeedRange: string;
}

export class ModelEvaluator {
  /**
   * Plays a single game between Model A (P1) and Model B (P2).
   */
  public static async playSingleGame(
    modelP1: NeuralValueModel,
    modelP2: NeuralValueModel,
    seed: [number, number, number, number],
    formatid: string = 'gen9randombattle'
  ): Promise<{ winner: 'p1' | 'p2' | 'tie'; turns: number }> {
    const runner = new BattleRunner();
    const p1Tracker = new StateTracker(formatid);
    p1Tracker.playerSlot = 'p1';

    const p2Tracker = new StateTracker(formatid);
    p2Tracker.playerSlot = 'p2';

    await runner.start({
      formatid,
      p1Name: 'P1_Agent',
      p2Name: 'P2_Agent',
      seed,
      p2Controller: async (req, rawLines) => {
        p2Tracker.processLines(rawLines);
        p2Tracker.updateFromRequest(req);
        const decision = NeuralEngine.selectBestAction(modelP2, p2Tracker.state, req);
        return decision.candidate.id;
      }
    });

    let winner: 'p1' | 'p2' | 'tie' = 'tie';

    while (true) {
      const actionable = await runner.getNextActionableRequest();
      if (!actionable) {
        for (const line of runner.accumulatedLines) {
          if (line.startsWith('|win|')) {
            const wName = line.split('|')[2]?.trim();
            if (wName === 'P1_Agent') winner = 'p1';
            else if (wName === 'P2_Agent') winner = 'p2';
          }
          if (line.startsWith('|tie|')) {
            winner = 'tie';
          }
        }
        break;
      }

      p1Tracker.processLines(actionable.rawLines);
      p1Tracker.updateFromRequest(actionable.request);

      const decision = NeuralEngine.selectBestAction(modelP1, p1Tracker.state, actionable.request);
      await runner.chooseP1(decision.candidate.id);
    }

    runner.destroy();
    return { winner, turns: p1Tracker.state.turn };
  }

  /**
   * Runs held-out benchmark evaluation between old and new model under identical seed policy.
   */
  public static async evaluateModels(options: ModelEvalOptions): Promise<ModelComparisonReport> {
    const numRounds = options.numRounds ?? 10; // Total 2 * numRounds games (symmetrical P1/P2)
    const thresholdWinRate = options.thresholdWinRate ?? 52.0;
    const seedBase = options.seedBase ?? 750000; // Strictly held-out seeds
    const formats = options.formats && options.formats.length > 0
      ? options.formats
      : options.formatid
      ? [options.formatid]
      : ['gen9randombattle'];
    const formatid = formats.length === 1 ? formats[0] : 'all-generations (gen1-9)';

    const oldModel = NeuralValueModel.loadFromFile(options.oldModelPath);
    const newModel = NeuralValueModel.loadFromFile(options.newModelPath);

    const oldVersion = oldModel.metadata.version;
    const newVersion = newModel.metadata.version;

    // Check pointer before evaluation
    const initialPointer = ModelRegistry.getActivePointer();

    let newModelWins = 0;
    let oldModelWins = 0;
    let draws = 0;

    for (let r = 0; r < numRounds; r++) {
      const activeFormat = formats[r % formats.length];
      const seedVal = seedBase + r * 100;
      const seed: [number, number, number, number] = [seedVal, seedVal + 1, seedVal + 2, seedVal + 3];

      // Game A: New Model = P1, Old Model = P2
      const gameA = await this.playSingleGame(newModel, oldModel, seed, activeFormat);
      if (gameA.winner === 'p1') newModelWins++;
      else if (gameA.winner === 'p2') oldModelWins++;
      else draws++;

      // Game B: Old Model = P1, New Model = P2 (Mirrored for strict fairness)
      const gameB = await this.playSingleGame(oldModel, newModel, seed, activeFormat);
      if (gameB.winner === 'p2') newModelWins++;
      else if (gameB.winner === 'p1') oldModelWins++;
      else draws++;
    }

    const totalBattles = numRounds * 2;
    const newModelWinRate = Number(((newModelWins / totalBattles) * 100).toFixed(1));
    const oldModelWinRate = Number(((oldModelWins / totalBattles) * 100).toFixed(1));
    const winRateDelta = Number((newModelWinRate - oldModelWinRate).toFixed(1));

    // Explicit Accept/Reject decision
    const decision: 'ACCEPT' | 'REJECT' = newModelWinRate >= thresholdWinRate ? 'ACCEPT' : 'REJECT';

    // Update or verify active model pointer
    if (decision === 'ACCEPT') {
      ModelRegistry.setActivePointer(newVersion, options.newModelPath, `Beat threshold ${thresholdWinRate}% with ${newModelWinRate}%`);
    } else {
      // Must verify pointer STAYS on old version, do not assume
      assert.strictEqual(
        initialPointer.activeVersion,
        oldVersion,
        `Expected active pointer before rejection to be ${oldVersion}`
      );
    }

    const finalPointer = ModelRegistry.getActivePointer();

    const report: ModelComparisonReport = {
      timestamp: new Date().toISOString(),
      formatid,
      formatsEvaluated: formats,
      oldModelVersion: oldVersion,
      oldModelPath: options.oldModelPath,
      newModelVersion: newVersion,
      newModelPath: options.newModelPath,
      totalBattles,
      newModelWins,
      oldModelWins,
      draws,
      newModelWinRate,
      oldModelWinRate,
      winRateDelta,
      thresholdWinRate,
      decision,
      activeModelPointerBefore: initialPointer.activeVersion,
      activeModelPointerAfter: finalPointer.activeVersion,
      seedPolicy: 'Mirrored Pairwise Fixed-Seed (Loop 5 Compliant)',
      heldOutSeedRange: `${seedBase} - ${seedBase + (numRounds - 1) * 100}`
    };

    // Auto-write comparison report to file
    const reportPath = options.reportJsonPath ?? path.resolve(process.cwd(), 'data', 'model_eval_comparison.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    const mdPath = reportPath.replace(/\.json$/, '.md');
    const mdContent = [
      `# Model Evaluation & Head-to-Head Comparison Report`,
      ``,
      `- **Timestamp:** ${report.timestamp}`,
      `- **Seed Policy:** ${report.seedPolicy}`,
      `- **Held-Out Seed Range:** ${report.heldOutSeedRange}`,
      `- **Total Battles:** ${report.totalBattles}`,
      `- **Old Model (${report.oldModelVersion}):** ${report.oldModelWins} wins (${report.oldModelWinRate}%)`,
      `- **New Model (${report.newModelVersion}):** ${report.newModelWins} wins (${report.newModelWinRate}%)`,
      `- **Draws:** ${report.draws}`,
      `- **Win Rate Delta:** ${report.winRateDelta > 0 ? '+' : ''}${report.winRateDelta}%`,
      `- **Acceptance Threshold:** >${report.thresholdWinRate}%`,
      `- **Decision:** **${report.decision}**`,
      `- **Active Model Pointer (Before):** ${report.activeModelPointerBefore}`,
      `- **Active Model Pointer (After):** **${report.activeModelPointerAfter}**`,
      ``
    ].join('\n');
    fs.writeFileSync(mdPath, mdContent, 'utf8');

    return report;
  }
}
