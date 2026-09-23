import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { BattleRunner } from '../sim/battle-runner.js';
import { StateTracker } from '../battle/state-tracker.js';
import { ExperienceValidator, RawExperienceRecord } from '../experience/experience-record.js';
import { NeuralValueModel } from '../model/model-artifact.js';
import { NeuralEngine } from '../strategy/neural-engine.js';
import { ModelTrainer } from '../model/trainer.js';
import { ModelEvaluator, ModelComparisonReport } from '../model/evaluator.js';
import { ModelRegistry, ActiveModelPointer } from '../model/model-registry.js';
import { cloneBattleState } from '../battle/battle-state.js';
import { CandidateGenerator } from '../strategy/candidate-generator.js';

export interface CycleIterationResult {
  iteration: number;
  versionId: string;
  battlesAttempted: number;
  battlesSucceeded: number;
  battlesFailed: number;
  experiencesCollected: number;
  modelTrained: boolean;
  modelPath: string;
  evalReport: ModelComparisonReport | null;
  promoted: boolean;
  activeModelVersion: string;
  error?: string;
}

export interface AutonomousCycleSummary {
  passed: boolean;
  totalIterations: number;
  completedIterations: number;
  iterationResults: CycleIterationResult[];
  finalActiveModelVersion: string;
  allArtifactsRetrievable: boolean;
  unambiguousActiveAnswer: string;
}

export class AutonomousTrainingCycle {
  /**
   * Executes N iterations of the autonomous training cycle unattended.
   * Chain: Run Battles -> Collect -> Train -> Evaluate -> Compare -> Keep Better -> Repeat.
   */
  public static async runCycle(options: {
    iterations: number;
    battlesPerIter?: number;
    evalRoundsPerIter?: number;
    thresholdWinRate?: number;
    outputDir?: string;
  }): Promise<AutonomousCycleSummary> {
    const N = options.iterations;
    const battlesPerIter = options.battlesPerIter ?? 5;
    const evalRounds = options.evalRoundsPerIter ?? 3; // 6 games per eval
    const thresholdWinRate = options.thresholdWinRate ?? 50.0;
    const baseDir = options.outputDir ?? path.resolve(process.cwd(), 'data', 'cycles');

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    const iterationResults: CycleIterationResult[] = [];

    for (let iter = 1; iter <= N; iter++) {
      const versionId = `v_iter_${iter}_${Date.now()}`;
      console.log(`\n--------------------------------------------------------------------------------`);
      console.log(`>>> STARTING AUTONOMOUS CYCLE ITERATION ${iter}/${N} [Version: ${versionId}]`);
      console.log(`--------------------------------------------------------------------------------`);

      let currentActive = ModelRegistry.getActivePointer();
      let activeModel = NeuralValueModel.loadFromFile(currentActive.activeModelPath);
      console.log(`  Active Model at Start: ${currentActive.activeVersion} (${currentActive.activeModelPath})`);

      const iterResult: CycleIterationResult = {
        iteration: iter,
        versionId,
        battlesAttempted: 0,
        battlesSucceeded: 0,
        battlesFailed: 0,
        experiencesCollected: 0,
        modelTrained: false,
        modelPath: '',
        evalReport: null,
        promoted: false,
        activeModelVersion: currentActive.activeVersion
      };

      const iterExpPath = path.join(baseDir, `iter_${iter}_experiences.jsonl`);
      const expStream = fs.createWriteStream(iterExpPath, { flags: 'w', encoding: 'utf8' });

      // STEP 1: Run Battles & Collect Experiences (with error isolation)
      console.log(`  [Step 1] Running ${battlesPerIter} Self-Play / Opponent Battles...`);
      for (let b = 1; b <= battlesPerIter; b++) {
        iterResult.battlesAttempted++;
        try {
          // Fault tolerance test: purposefully test error catching on simulated glitch or run normally
          const seedBase = 300000 + iter * 1000 + b * 10;
          const seed: [number, number, number, number] = [seedBase, seedBase + 1, seedBase + 2, seedBase + 3];

          const runner = new BattleRunner();
          const tracker = new StateTracker('gen9randombattle');

          await runner.start({
            formatid: 'gen9randombattle',
            p1Name: `Agent_${iter}`,
            p2Name: 'Showdown_Bot',
            seed,
            autoOpponent: true
          });

          let turnCount = 0;
          while (true) {
            const actionable = await runner.getNextActionableRequest();
            if (!actionable) break;

            const stateBefore = cloneBattleState(tracker.state);
            tracker.processLines(actionable.rawLines);
            tracker.updateFromRequest(actionable.request);

            const candidates = CandidateGenerator.generateCandidates(tracker.state, actionable.request);
            const decision = NeuralEngine.selectBestAction(activeModel, tracker.state, actionable.request);

            // Calculate step reward
            const p1Hp = tracker.state.p1.active?.hpPercent ?? 100;
            const p2Hp = tracker.state.p2.active?.hpPercent ?? 100;
            const stepReward = Number(((100 - p2Hp) * 0.05 - (100 - p1Hp) * 0.03).toFixed(2));

            const record: RawExperienceRecord = {
              battleId: `cycle_${iter}_b${b}`,
              turn: tracker.state.turn,
              step: ++turnCount,
              state: stateBefore,
              available_actions: candidates,
              selected_action: decision.candidate.id,
              result: {
                rawLines: actionable.rawLines.slice(-5),
                terminal: false
              },
              reward: stepReward,
              next_state: cloneBattleState(tracker.state)
            };

            const val = ExperienceValidator.validateRecord(record);
            if (val.valid) {
              expStream.write(JSON.stringify(record) + '\n');
              iterResult.experiencesCollected++;
            }

            await runner.chooseP1(decision.candidate.id);
          }

          runner.destroy();
          iterResult.battlesSucceeded++;
        } catch (err: any) {
          // Error isolation: Log + skip + continue cycle
          console.warn(`  [FAULT TOLERANCE] Battle ${b} encountered error (skipping): ${err.message}`);
          iterResult.battlesFailed++;
        }
      }

      await new Promise<void>(resolve => expStream.end(() => resolve()));
      console.log(`  [Step 1 Complete] Battles: ${iterResult.battlesSucceeded}/${iterResult.battlesAttempted} succeeded, Experiences: ${iterResult.experiencesCollected}`);

      // STEP 2: Train Model Artifact (with error isolation)
      console.log(`  [Step 2] Training Model Artifact for Version ${versionId}...`);
      const modelOutDir = path.resolve(process.cwd(), 'data', 'models');
      const newModelPath = path.join(modelOutDir, `model_${versionId}.json`);

      try {
        await ModelTrainer.train({
          version: versionId,
          datasetPath: iterExpPath,
          outputPath: newModelPath,
          epochs: 8,
          batchSize: 16,
          learningRate: 0.005,
          hiddenDim: 32
        });

        iterResult.modelTrained = true;
        iterResult.modelPath = newModelPath;
        console.log(`  [Step 2 Complete] Model trained successfully: ${newModelPath}`);
      } catch (trainErr: any) {
        // Error isolation: Log + skip + continue
        console.warn(`  [FAULT TOLERANCE] Training error on iteration ${iter}: ${trainErr.message}`);
        iterResult.error = trainErr.message;
        iterationResults.push(iterResult);
        continue;
      }

      // STEP 3: Evaluate & Compare against active model
      console.log(`  [Step 3] Evaluating Candidate Model ${versionId} against Active ${currentActive.activeVersion}...`);
      const evalReportPath = path.join(baseDir, `eval_${versionId}.json`);

      const evalReport = await ModelEvaluator.evaluateModels({
        oldModelPath: currentActive.activeModelPath,
        newModelPath,
        numRounds: evalRounds,
        thresholdWinRate,
        reportJsonPath: evalReportPath,
        seedBase: 800000 + iter * 500
      });

      iterResult.evalReport = evalReport;

      // STEP 4: Keep Better
      if (evalReport.decision === 'ACCEPT') {
        iterResult.promoted = true;
        iterResult.activeModelVersion = versionId;
        console.log(`  [Step 4] Candidate ${versionId} ACCEPTED! Promoted to active model.`);
      } else {
        iterResult.promoted = false;
        iterResult.activeModelVersion = currentActive.activeVersion;
        console.log(`  [Step 4] Candidate ${versionId} REJECTED. Active model retained as ${currentActive.activeVersion}.`);
      }

      // Save iteration record
      const iterReportPath = path.join(baseDir, `iteration_${iter}_report.json`);
      fs.writeFileSync(iterReportPath, JSON.stringify(iterResult, null, 2), 'utf8');

      iterationResults.push(iterResult);
    }

    const finalActive = ModelRegistry.getActivePointer();

    // Verify all prior models + eval reports remain on disk and retrievable
    let allArtifactsRetrievable = true;
    for (const res of iterationResults) {
      if (res.modelPath && !fs.existsSync(res.modelPath)) allArtifactsRetrievable = false;
      const rPath = path.join(baseDir, `iteration_${res.iteration}_report.json`);
      if (!fs.existsSync(rPath)) allArtifactsRetrievable = false;
    }

    const summary: AutonomousCycleSummary = {
      passed: iterationResults.length === N && allArtifactsRetrievable,
      totalIterations: N,
      completedIterations: iterationResults.length,
      iterationResults,
      finalActiveModelVersion: finalActive.activeVersion,
      allArtifactsRetrievable,
      unambiguousActiveAnswer: `Active model version is unambiguously '${finalActive.activeVersion}' located at ${finalActive.activeModelPath}`
    };

    const cycleSummaryPath = path.join(baseDir, 'full_cycle_summary.json');
    fs.writeFileSync(cycleSummaryPath, JSON.stringify(summary, null, 2), 'utf8');

    return summary;
  }
}
