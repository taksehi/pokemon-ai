import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { BattleRunner, RequestPayload } from '../sim/battle-runner.js';
import { StateTracker } from '../battle/state-tracker.js';
import { BattleState } from '../battle/battle-state.js';
import { NeuralValueModel } from './model-artifact.js';
import { NeuralEngine } from '../strategy/neural-engine.js';
import { ModelRegistry, ActiveModelPointer } from './model-registry.js';

export interface StrategyPlayerController {
  name: string;
  decide(state: BattleState, request: RequestPayload, rawLines?: string[]): Promise<string> | string;
  getStats?(): { totalDecisions: number; fallbackCount: number; fallbackRate: number };
  resetStats?(): void;
}

export interface ModelEvalOptions {
  oldModelPath: string;
  newModelPath: string;
  numRounds?: number; // Each round plays 2 games (mirrored sides)
  thresholdWinRate?: number; // e.g. 52.0
  useWilsonGate?: boolean; // When true, requires Wilson score lower bound > 50%
  wilsonZ?: number; // z-score for Wilson confidence interval (default 1.96 for 95% CI)
  autoRaiseBattlesUntilConfident?: boolean; // Dynamically expands battle count if lower bound is inconclusive
  maxRounds?: number; // Maximum rounds cap when auto-expanding
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
  wilsonLowerBound: number;
  wilsonLowerBoundPercent: number;
  gateMethod: 'threshold' | 'wilson';
  decision: 'ACCEPT' | 'REJECT';
  activeModelPointerBefore: string;
  activeModelPointerAfter: string;
  seedPolicy: string;
  heldOutSeedRange: string;
  roundsPlayed: number;
}

export interface MatchupEvalOptions {
  player1: StrategyPlayerController;
  player2: StrategyPlayerController;
  numRounds?: number;
  formatid?: string;
  formats?: string[];
  seedBase?: number;
  useWilsonGate?: boolean;
  wilsonZ?: number;
  reportJsonPath?: string;
}

export interface MatchupComparisonReport {
  timestamp: string;
  formatid: string;
  formatsEvaluated: string[];
  p1Name: string;
  p2Name: string;
  totalBattles: number;
  p1Wins: number;
  p2Wins: number;
  draws: number;
  p1WinRate: number;
  p2WinRate: number;
  winRateDelta: number;
  wilsonLowerBound: number;
  wilsonLowerBoundPercent: number;
  decision: 'P1_DOMINANT' | 'P2_DOMINANT' | 'TIED';
  p1Stats?: { totalDecisions: number; fallbackCount: number; fallbackRate: number };
  p2Stats?: { totalDecisions: number; fallbackCount: number; fallbackRate: number };
  seedPolicy: string;
  heldOutSeedRange: string;
}

export class ModelEvaluator {
  /**
   * Wilson score interval lower bound for a binomial proportion.
   * Gives the conservative true win rate with statistical confidence z (default 1.96 for 95% CI).
   */
  public static wilson(wins: number, total: number, z: number = 1.96): number {
    if (total <= 0) return 0;
    const p = wins / total;
    const z2 = z * z;
    const denominator = 1 + z2 / total;
    const center = p + z2 / (2 * total);
    const spread = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
    return Math.max(0, (center - spread) / denominator);
  }

  /**
   * Plays a single game between two arbitrary strategy player controllers.
   */
  public static async playMatchupGame(
    p1: StrategyPlayerController,
    p2: StrategyPlayerController,
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
      p1Name: p1.name,
      p2Name: p2.name,
      seed,
      p2Controller: async (req, rawLines) => {
        p2Tracker.processLines(rawLines);
        p2Tracker.updateFromRequest(req);
        return await p2.decide(p2Tracker.state, req, rawLines);
      }
    });

    let winner: 'p1' | 'p2' | 'tie' = 'tie';

    while (true) {
      const actionable = await runner.getNextActionableRequest();
      if (!actionable) {
        for (const line of runner.accumulatedLines) {
          if (line.startsWith('|win|')) {
            const wName = line.split('|')[2]?.trim();
            if (wName === p1.name) winner = 'p1';
            else if (wName === p2.name) winner = 'p2';
          }
          if (line.startsWith('|tie|')) {
            winner = 'tie';
          }
        }
        break;
      }

      p1Tracker.processLines(actionable.rawLines);
      p1Tracker.updateFromRequest(actionable.request);

      const decision = await p1.decide(p1Tracker.state, actionable.request, actionable.rawLines);
      await runner.chooseP1(decision);
    }

    runner.destroy();
    return { winner, turns: p1Tracker.state.turn };
  }

  /**
   * Plays a single game between Model A (P1) and Model B (P2).
   */
  public static async playSingleGame(
    modelP1: NeuralValueModel,
    modelP2: NeuralValueModel,
    seed: [number, number, number, number],
    formatid: string = 'gen9randombattle'
  ): Promise<{ winner: 'p1' | 'p2' | 'tie'; turns: number }> {
    const p1Controller: StrategyPlayerController = {
      name: 'P1_Agent',
      decide: (state, req) => NeuralEngine.selectBestAction(modelP1, state, req).candidate.id
    };
    const p2Controller: StrategyPlayerController = {
      name: 'P2_Agent',
      decide: (state, req) => NeuralEngine.selectBestAction(modelP2, state, req).candidate.id
    };
    return this.playMatchupGame(p1Controller, p2Controller, seed, formatid);
  }

  /**
   * Evaluates any two strategy player controllers (e.g. Baseline vs JEV vs Ollama)
   * under a symmetrical, held-out fixed seed policy.
   */
  public static async evaluateMatchup(options: MatchupEvalOptions): Promise<MatchupComparisonReport> {
    const numRounds = options.numRounds ?? 10;
    const seedBase = options.seedBase ?? 750000;
    const wilsonZ = options.wilsonZ ?? 1.96;
    const formats = options.formats && options.formats.length > 0
      ? options.formats
      : options.formatid
      ? [options.formatid]
      : ['gen9randombattle'];
    const formatid = formats.length === 1 ? formats[0] : 'all-generations (gen1-9)';

    if (options.player1.resetStats) options.player1.resetStats();
    if (options.player2.resetStats) options.player2.resetStats();

    let p1Wins = 0;
    let p2Wins = 0;
    let draws = 0;

    for (let r = 0; r < numRounds; r++) {
      const activeFormat = formats[r % formats.length];
      const seedVal = seedBase + r * 100;
      const seed: [number, number, number, number] = [seedVal, seedVal + 1, seedVal + 2, seedVal + 3];

      // Game A: Player 1 = P1, Player 2 = P2
      const gameA = await this.playMatchupGame(options.player1, options.player2, seed, activeFormat);
      if (gameA.winner === 'p1') p1Wins++;
      else if (gameA.winner === 'p2') p2Wins++;
      else draws++;

      // Game B: Player 2 = P1, Player 1 = P2 (Mirrored sides for symmetry)
      const gameB = await this.playMatchupGame(options.player2, options.player1, seed, activeFormat);
      if (gameB.winner === 'p2') p1Wins++;
      else if (gameB.winner === 'p1') p2Wins++;
      else draws++;
    }

    const totalBattles = numRounds * 2;
    const p1WinRate = Number(((p1Wins / totalBattles) * 100).toFixed(1));
    const p2WinRate = Number(((p2Wins / totalBattles) * 100).toFixed(1));
    const winRateDelta = Number((p1WinRate - p2WinRate).toFixed(1));

    const effectiveWins = p1Wins + 0.5 * draws;
    const wilsonLower = Number(this.wilson(effectiveWins, totalBattles, wilsonZ).toFixed(4));
    const wilsonLowerPercent = Number((wilsonLower * 100).toFixed(1));

    let decision: 'P1_DOMINANT' | 'P2_DOMINANT' | 'TIED' = 'TIED';
    if (options.useWilsonGate ? wilsonLower > 0.50 : p1WinRate > p2WinRate) {
      decision = 'P1_DOMINANT';
    } else if (p2WinRate > p1WinRate) {
      decision = 'P2_DOMINANT';
    }

    const report: MatchupComparisonReport = {
      timestamp: new Date().toISOString(),
      formatid,
      formatsEvaluated: formats,
      p1Name: options.player1.name,
      p2Name: options.player2.name,
      totalBattles,
      p1Wins,
      p2Wins,
      draws,
      p1WinRate,
      p2WinRate,
      winRateDelta,
      wilsonLowerBound: wilsonLower,
      wilsonLowerBoundPercent: wilsonLowerPercent,
      decision,
      p1Stats: options.player1.getStats ? options.player1.getStats() : undefined,
      p2Stats: options.player2.getStats ? options.player2.getStats() : undefined,
      seedPolicy: 'Mirrored Pairwise Fixed-Seed (Loop 5 Compliant)',
      heldOutSeedRange: `${seedBase} - ${seedBase + (numRounds - 1) * 100}`
    };

    if (options.reportJsonPath) {
      const dir = path.dirname(options.reportJsonPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(options.reportJsonPath, JSON.stringify(report, null, 2), 'utf8');

      const mdPath = options.reportJsonPath.replace(/\.json$/, '.md');
      const mdContent = [
        `# Strategy Matchup Comparison Report`,
        ``,
        `- **Timestamp:** ${report.timestamp}`,
        `- **Matchup:** ${report.p1Name} vs. ${report.p2Name}`,
        `- **Format:** ${report.formatid}`,
        `- **Total Battles:** ${report.totalBattles}`,
        `- **${report.p1Name} Wins:** ${report.p1Wins} (${report.p1WinRate}%)`,
        `- **${report.p2Name} Wins:** ${report.p2Wins} (${report.p2WinRate}%)`,
        `- **Draws:** ${report.draws}`,
        `- **Win Rate Delta:** ${report.winRateDelta > 0 ? '+' : ''}${report.winRateDelta}%`,
        `- **Wilson 95% Lower Bound:** ${report.wilsonLowerBoundPercent}%`,
        `- **Decision:** **${report.decision}**`,
        report.p1Stats ? `- **${report.p1Name} Fallback Rate:** ${(report.p1Stats.fallbackRate * 100).toFixed(1)}% (${report.p1Stats.fallbackCount}/${report.p1Stats.totalDecisions})` : '',
        report.p2Stats ? `- **${report.p2Name} Fallback Rate:** ${(report.p2Stats.fallbackRate * 100).toFixed(1)}% (${report.p2Stats.fallbackCount}/${report.p2Stats.totalDecisions})` : '',
        ``
      ].filter(Boolean).join('\n');
      fs.writeFileSync(mdPath, mdContent, 'utf8');
    }

    return report;
  }

  /**
   * Runs held-out benchmark evaluation between old and new model under identical seed policy.
   * Can evaluate with standard threshold or statistical Wilson lower-bound gating (> 50%).
   */
  public static async evaluateModels(options: ModelEvalOptions): Promise<ModelComparisonReport> {
    const minRounds = options.numRounds ?? 10; // Total 2 * numRounds games (symmetrical P1/P2)
    const thresholdWinRate = options.thresholdWinRate ?? 52.0;
    const seedBase = options.seedBase ?? 750000; // Strictly held-out seeds
    const wilsonZ = options.wilsonZ ?? 1.96;
    const maxRounds = options.maxRounds ?? Math.max(minRounds * 3, 30);
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
    let roundsPlayed = 0;

    let continueBattling = true;
    while (continueBattling) {
      const r = roundsPlayed;
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

      roundsPlayed++;

      // Stop condition check
      if (roundsPlayed < minRounds) {
        continueBattling = true;
      } else if (options.autoRaiseBattlesUntilConfident && options.useWilsonGate && roundsPlayed < maxRounds) {
        const curTotal = roundsPlayed * 2;
        const curEffWins = newModelWins + 0.5 * draws;
        const curWilson = this.wilson(curEffWins, curTotal, wilsonZ);
        // Continue raising battle count if candidate is ahead but lower bound not yet over 50%
        if (newModelWins > oldModelWins && curWilson <= 0.50) {
          continueBattling = true;
        } else {
          continueBattling = false;
        }
      } else {
        continueBattling = false;
      }
    }

    const totalBattles = roundsPlayed * 2;
    const newModelWinRate = Number(((newModelWins / totalBattles) * 100).toFixed(1));
    const oldModelWinRate = Number(((oldModelWins / totalBattles) * 100).toFixed(1));
    const winRateDelta = Number((newModelWinRate - oldModelWinRate).toFixed(1));

    const effectiveWins = newModelWins + 0.5 * draws;
    const wilsonLowerBound = Number(this.wilson(effectiveWins, totalBattles, wilsonZ).toFixed(4));
    const wilsonLowerBoundPercent = Number((wilsonLowerBound * 100).toFixed(1));

    // Decision rule:
    // If useWilsonGate is true, require Wilson lower bound > 50% (0.50).
    // Otherwise, check empirical win rate against thresholdWinRate.
    const gateMethod = options.useWilsonGate ? 'wilson' : 'threshold';
    const isAccepted = options.useWilsonGate
      ? wilsonLowerBound > 0.50
      : newModelWinRate >= thresholdWinRate;
    const decision: 'ACCEPT' | 'REJECT' = isAccepted ? 'ACCEPT' : 'REJECT';

    // Update or verify active model pointer
    if (decision === 'ACCEPT') {
      const reason = options.useWilsonGate
        ? `Beat Wilson 95% lower bound threshold (>50%) with ${wilsonLowerBoundPercent}% (${newModelWinRate}% empirical)`
        : `Beat threshold ${thresholdWinRate}% with ${newModelWinRate}%`;
      ModelRegistry.setActivePointer(newVersion, options.newModelPath, reason);
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
      wilsonLowerBound,
      wilsonLowerBoundPercent,
      gateMethod,
      decision,
      activeModelPointerBefore: initialPointer.activeVersion,
      activeModelPointerAfter: finalPointer.activeVersion,
      seedPolicy: 'Mirrored Pairwise Fixed-Seed (Loop 5 Compliant)',
      heldOutSeedRange: `${seedBase} - ${seedBase + (roundsPlayed - 1) * 100}`,
      roundsPlayed
    };

    // Auto-write comparison report to file
    const reportPath = options.reportJsonPath ?? path.resolve(process.cwd(), 'data', 'model_eval_comparison.json');
    const dir = path.dirname(reportPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
      `- **Wilson 95% Lower Bound:** ${report.wilsonLowerBoundPercent}%`,
      `- **Gate Method:** ${report.gateMethod}`,
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
