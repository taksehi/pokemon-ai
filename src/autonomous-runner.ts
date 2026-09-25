import fs from 'node:fs';
import path from 'node:path';
import { BattleRunner } from './sim/battle-runner.js';
import { StateTracker } from './battle/state-tracker.js';
import { CandidateGenerator } from './strategy/candidate-generator.js';
import { ExperienceValidator, RawExperienceRecord } from './experience/experience-record.js';
import { NeuralValueModel } from './model/model-artifact.js';
import { NeuralEngine } from './strategy/neural-engine.js';
import { ModelTrainer } from './model/trainer.js';
import { ModelEvaluator } from './model/evaluator.js';
import { ModelRegistry } from './model/model-registry.js';
import { FailureCategorizer, CycleFailureReport } from './monitoring/failure-categorizer.js';
import { cloneBattleState } from './battle/battle-state.js';

export const ALL_GEN_RANDOM_BATTLE_FORMATS = [
  'gen1randombattle',
  'gen2randombattle',
  'gen3randombattle',
  'gen4randombattle',
  'gen5randombattle',
  'gen6randombattle',
  'gen7randombattle',
  'gen8randombattle',
  'gen9randombattle'
];

export interface AutonomousRunConfig {
  targetTotalBattles: number;
  battlesPerCycle: number;
  evalRoundsPerCycle: number;
  thresholdWinRate: number;
  outputDir: string;
  formats?: string[];
}

export async function runContinuousAutonomousTraining(
  customConfig?: Partial<AutonomousRunConfig>
): Promise<void> {
  const formats = customConfig?.formats ?? ALL_GEN_RANDOM_BATTLE_FORMATS;
  const config: AutonomousRunConfig = {
    targetTotalBattles: customConfig?.targetTotalBattles ?? 2000,
    battlesPerCycle: customConfig?.battlesPerCycle ?? 100,
    evalRoundsPerCycle: customConfig?.evalRoundsPerCycle ?? 9, // 18 games per eval (covering all 9 gens symmetrically)
    thresholdWinRate: customConfig?.thresholdWinRate ?? 50.0,
    outputDir: customConfig?.outputDir ?? path.resolve(process.cwd(), 'data', 'autonomous_run'),
    formats
  };

  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  const startTime = Date.now();
  let totalBattlesCompleted = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalDraws = 0;
  let cycleIndex = 0;
  let previousCycleFailureReport: CycleFailureReport | null = null;

  console.log(`================================================================================`);
  console.log(`          AUTONOMOUS POKÉMON AI TRAINING SYSTEM (TARGET: ${config.targetTotalBattles} BATTLES)         `);
  console.log(`================================================================================`);
  console.log(`Configuration:`);
  console.log(`  Target Battles:     ${config.targetTotalBattles}`);
  console.log(`  Battles per Cycle:  ${config.battlesPerCycle}`);
  console.log(`  Evaluation Rounds:  ${config.evalRoundsPerCycle} (mirrored held-out pairs across gens)`);
  console.log(`  Win Rate Threshold: ${config.thresholdWinRate}%`);
  console.log(`  Formats Sampled:    ${formats.join(', ')}`);
  console.log(`  Working Directory:  ${config.outputDir}\n`);

  let isShuttingDown = false;
  process.on('SIGINT', () => {
    console.log(`\n[SHUTDOWN] Intercepted SIGINT. Gracefully finishing current battle...`);
    isShuttingDown = true;
  });

  while (totalBattlesCompleted < config.targetTotalBattles && !isShuttingDown) {
    cycleIndex++;
    const remaining = config.targetTotalBattles - totalBattlesCompleted;
    const currentBatchSize = Math.min(config.battlesPerCycle, remaining);
    const versionId = `v_cycle_${cycleIndex}_${Date.now()}`;

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`>>> CYCLE ${cycleIndex} | Total Progress: ${totalBattlesCompleted}/${config.targetTotalBattles} (${((totalBattlesCompleted / config.targetTotalBattles) * 100).toFixed(1)}%)`);
    console.log(`--------------------------------------------------------------------------------`);

    const activePointer = ModelRegistry.getActivePointer();
    const activeModel = NeuralValueModel.loadFromFile(activePointer.activeModelPath);
    console.log(`  Active Model: ${activePointer.activeVersion} (${path.basename(activePointer.activeModelPath)})`);

    const cycleExpPath = path.join(config.outputDir, `cycle_${cycleIndex}_experiences.jsonl`);
    const expStream = fs.createWriteStream(cycleExpPath, { flags: 'w', encoding: 'utf8' });

    let cycleWins = 0;
    let cycleLosses = 0;
    let cycleDraws = 0;
    let cycleExperiences = 0;
    const cycleExpArray: RawExperienceRecord[] = [];

    // STEP 1: Run Battle Batch
    const batchStartTime = Date.now();
    for (let b = 1; b <= currentBatchSize; b++) {
      if (isShuttingDown) break;

      totalBattlesCompleted++;
      const battleIndex = totalBattlesCompleted;

      try {
        const seedBase = 1000000 + battleIndex * 17;
        const seed: [number, number, number, number] = [
          (seedBase) % 65535 + 1,
          (seedBase + 101) % 65535 + 1,
          (seedBase + 202) % 65535 + 1,
          (seedBase + 303) % 65535 + 1
        ];

        const activeFormats = config.formats && config.formats.length > 0 ? config.formats : ALL_GEN_RANDOM_BATTLE_FORMATS;
        const formatid = activeFormats[(battleIndex - 1) % activeFormats.length];
        const runner = new BattleRunner();
        const tracker = new StateTracker(formatid);

        await runner.start({
          formatid,
          p1Name: `Agent_${cycleIndex}`,
          p2Name: 'Showdown_Bot',
          seed,
          autoOpponent: true
        });

        let winner = 'Unknown';
        let stepCount = 0;

        while (true) {
          const actionable = await runner.getNextActionableRequest();
          if (!actionable) {
            for (const line of runner.accumulatedLines) {
              if (line.startsWith('|win|')) winner = line.split('|')[2]?.trim() || 'Unknown';
              if (line.startsWith('|tie|')) winner = 'Tie';
            }
            break;
          }

          const stateBefore = cloneBattleState(tracker.state);
          tracker.processLines(actionable.rawLines);
          tracker.updateFromRequest(actionable.request);

          const candidates = CandidateGenerator.generateCandidates(tracker.state, actionable.request);
          const decision = NeuralEngine.selectBestAction(activeModel, tracker.state, actionable.request);

          // Calculate reward
          const p1Hp = tracker.state.p1.active?.hpPercent ?? 100;
          const p2Hp = tracker.state.p2.active?.hpPercent ?? 100;
          const stepReward = Number(((100 - p2Hp) * 0.05 - (100 - p1Hp) * 0.03).toFixed(2));

          const rec: RawExperienceRecord = {
            battleId: `b_${battleIndex}`,
            turn: tracker.state.turn,
            step: ++stepCount,
            state: stateBefore,
            available_actions: candidates,
            selected_action: decision.candidate.id,
            result: {
              rawLines: actionable.rawLines.slice(-3),
              terminal: false
            },
            reward: stepReward,
            next_state: cloneBattleState(tracker.state)
          };

          const val = ExperienceValidator.validateRecord(rec);
          if (val.valid) {
            expStream.write(JSON.stringify(rec) + '\n');
            cycleExpArray.push(rec);
            cycleExperiences++;
          }

          await runner.chooseP1(decision.candidate.id);
        }

        runner.destroy();

        if (winner.startsWith('Agent_')) {
          cycleWins++;
          totalWins++;
        } else if (winner === 'Tie') {
          cycleDraws++;
          totalDraws++;
        } else {
          cycleLosses++;
          totalLosses++;
        }

        if (b % 25 === 0 || b === currentBatchSize) {
          const elapsedSec = ((Date.now() - batchStartTime) / 1000).toFixed(1);
          const winRate = ((cycleWins / b) * 100).toFixed(1);
          const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
          console.log(`  [Batch Progress] ${b}/${currentBatchSize} battles (${elapsedSec}s) | Win Rate: ${winRate}% | RAM: ${memMb}MB`);
        }
      } catch (err: any) {
        console.warn(`  [Warning] Battle ${battleIndex} skipped due to error: ${err.message}`);
      }
    }

    await new Promise<void>(resolve => expStream.end(() => resolve()));

    const cycleWinRate = ((cycleWins / currentBatchSize) * 100).toFixed(1);
    const cumulativeWinRate = ((totalWins / totalBattlesCompleted) * 100).toFixed(1);
    console.log(`  [Step 1 Complete] Batch Result: ${cycleWins}W / ${cycleLosses}L / ${cycleDraws}D (${cycleWinRate}% batch win rate | ${cumulativeWinRate}% cumulative)`);

    // STEP 2: Train Candidate Model
    console.log(`  [Step 2] Training Candidate Model ${versionId}...`);
    const modelOutDir = path.resolve(process.cwd(), 'data', 'models');
    const newModelPath = path.join(modelOutDir, `model_${versionId}.json`);

    try {
      const trainRes = await ModelTrainer.train({
        version: versionId,
        datasetPath: cycleExpPath,
        outputPath: newModelPath,
        epochs: 10,
        batchSize: 32,
        learningRate: 0.005,
        hiddenDim: 32
      });
      console.log(`  [Step 2 Complete] Model trained in ${trainRes.trainingTimeMs}ms (Loss reduction: ${trainRes.lossReductionPercent}%)`);
    } catch (trainErr: any) {
      console.warn(`  [Warning] Training error: ${trainErr.message}`);
      continue;
    }

    // STEP 3: Evaluate on Held-out Benchmark across all generations
    console.log(`  [Step 3] Evaluating Candidate Model on Held-Out Benchmark Across Formats...`);
    const evalReportPath = path.join(config.outputDir, `eval_${versionId}.json`);
    const evalReport = await ModelEvaluator.evaluateModels({
      oldModelPath: activePointer.activeModelPath,
      newModelPath,
      numRounds: config.evalRoundsPerCycle,
      thresholdWinRate: config.thresholdWinRate,
      formats: config.formats,
      reportJsonPath: evalReportPath,
      seedBase: 850000 + cycleIndex * 1000
    });

    if (evalReport.decision === 'ACCEPT') {
      console.log(`  [Step 4] Candidate Model ${versionId} ACCEPTED (${evalReport.newModelWinRate}% vs ${evalReport.oldModelWinRate}%) -> PROMOTED to Active.`);
    } else {
      console.log(`  [Step 4] Candidate Model ${versionId} REJECTED (${evalReport.newModelWinRate}% vs ${evalReport.oldModelWinRate}%) -> Retaining ${activePointer.activeVersion}.`);
    }

    // STEP 5: Self-Improvement Monitoring & Feedback
    const cycleFailureReport = FailureCategorizer.analyzeExperiences(cycleExpArray, `Cycle_${cycleIndex}`);
    if (previousCycleFailureReport) {
      const diff = FailureCategorizer.compareCycleFailures(previousCycleFailureReport, cycleFailureReport);
      console.log(`  [Monitoring] Failure Delta: ${diff.totalDelta > 0 ? '+' : ''}${diff.totalDelta} (Trend: ${diff.overallTrend})`);
    }
    previousCycleFailureReport = cycleFailureReport;

    // Trigger garbage collection if exposed
    if (typeof global.gc === 'function') {
      global.gc();
    }

    // Save cycle checkpoint
    const checkpointPath = path.join(config.outputDir, 'run_checkpoint.json');
    fs.writeFileSync(checkpointPath, JSON.stringify({
      totalBattlesCompleted,
      targetTotalBattles: config.targetTotalBattles,
      totalWins,
      totalLosses,
      totalDraws,
      cumulativeWinRatePercent: Number(cumulativeWinRate),
      activeModel: ModelRegistry.getActivePointer().activeVersion,
      cycleIndex,
      elapsedMinutes: Number(((Date.now() - startTime) / 60000).toFixed(1)),
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  }

  const totalElapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);
  const finalWinRate = totalBattlesCompleted > 0 ? ((totalWins / totalBattlesCompleted) * 100).toFixed(1) : '0';
  const finalActive = ModelRegistry.getActivePointer();

  console.log(`\n================================================================================`);
  console.log(`            AUTONOMOUS RUN COMPLETED (2,000 BATTLES TARGET REACHED)             `);
  console.log(`================================================================================`);
  console.log(`Total Battles Played:    ${totalBattlesCompleted}`);
  console.log(`Final Record:            ${totalWins}W / ${totalLosses}L / ${totalDraws}D`);
  console.log(`Overall Win Rate:        ${finalWinRate}%`);
  console.log(`Cycles Completed:        ${cycleIndex}`);
  console.log(`Final Active Model:      ${finalActive.activeVersion} (${finalActive.activeModelPath})`);
  console.log(`Total Execution Time:    ${totalElapsedMin} minutes`);
  console.log(`Artifacts & Logs Saved:  ${config.outputDir}`);
  console.log(`================================================================================\n`);
}

if (process.argv[1] && process.argv[1].endsWith('autonomous-runner.ts')) {
  const target = process.argv[2] ? parseInt(process.argv[2], 10) : 2000;
  const batchSize = process.argv[3] ? parseInt(process.argv[3], 10) : 100;
  runContinuousAutonomousTraining({
    targetTotalBattles: target,
    battlesPerCycle: batchSize
  }).catch(err => {
    console.error('Fatal runner error:', err);
    process.exit(1);
  });
}
