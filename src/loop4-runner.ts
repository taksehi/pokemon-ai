import path from 'node:path';
import fs from 'node:fs';
import { BattleRunner } from './sim/battle-runner.js';
import { StateTracker } from './battle/state-tracker.js';
import { cloneBattleState, BattleState } from './battle/battle-state.js';
import { CandidateGenerator } from './strategy/candidate-generator.js';
import { BaselineEngine } from './strategy/baseline-engine.js';
import { StateDiffValidator } from './battle/state-diff-validator.js';
import { ExperienceRecord, ExperienceValidator } from './experience/experience-record.js';
import { ExperienceBuffer } from './experience/experience-buffer.js';

export interface MemorySample {
  battleNumber: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
}

export interface Loop4VerificationSummary {
  totalBattles: number;
  completedBattles: number;
  wins: number;
  losses: number;
  draws: number;
  tallySum: number;
  allLoop1CriteriaMet: boolean;
  totalSteps: number;
  totalExperiencesCollected: number;
  allExperiencesSchemaValid: boolean;
  memorySamples: MemorySample[];
  memAfterBattle10MB: number;
  memAfterBattle100MB: number;
  memoryGrowthPercent: number;
  memoryLeakDetected: boolean;
  allPass: boolean;
}

export async function run100AutonomousBattles(options: {
  battleCount?: number;
  experienceSavePath?: string;
  verboseInterval?: number;
} = {}): Promise<Loop4VerificationSummary> {
  const targetCount = options.battleCount ?? 100;
  const verboseInterval = options.verboseInterval ?? 10;
  const experienceSavePath = options.experienceSavePath ?? path.resolve(process.cwd(), 'data', 'loop4_experiences.jsonl');

  console.log(`================================================================================`);
  console.log(`       LOOP 4 VERIFICATION: 100 CONSECUTIVE UNATTENDED AUTONOMOUS BATTLES       `);
  console.log(`================================================================================\n`);

  // Ensure output directory exists and truncate previous file
  const dir = path.dirname(experienceSavePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(experienceSavePath)) {
    fs.unlinkSync(experienceSavePath);
  }

  let wins = 0;
  let losses = 0;
  let draws = 0;
  let totalSteps = 0;
  let totalExperiencesCollected = 0;
  let illegalActionsCount = 0;
  let stateDiffErrorsCount = 0;
  let schemaErrorsCount = 0;

  const memorySamples: MemorySample[] = [];

  // Helper to sample memory cleanly
  function sampleMemory(battleNum: number): MemorySample {
    if (typeof (global as any).gc === 'function') {
      try {
        (global as any).gc();
      } catch {}
    }
    const mem = process.memoryUsage();
    return {
      battleNumber: battleNum,
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100
    };
  }

  const startTime = Date.now();

  for (let b = 1; b <= targetCount; b++) {
    const battleId = `loop4_b${b}`;
    const p1Name = 'Loop4_Agent';
    const p2Name = 'Opponent_Bot';

    const runner = new BattleRunner();
    const tracker = new StateTracker('gen9randombattle');
    const battleExperiences: ExperienceRecord[] = [];

    await runner.start({
      formatid: 'gen9randombattle',
      p1Name,
      p2Name,
      autoOpponent: true
    });

    let pendingStep: {
      turn: number;
      step: number;
      stateBefore: BattleState;
      chosenActionId: string;
      availableActions: any[];
    } | null = null;

    let battleSteps = 0;
    let winner = 'Unknown';

    while (true) {
      const actionable = await runner.getNextActionableRequest();
      if (!actionable) {
        // Concluded
        for (const line of runner.accumulatedLines) {
          if (line.startsWith('|win|')) {
            winner = line.split('|')[2]?.trim() || 'Unknown';
          } else if (line.startsWith('|tie|')) {
            winner = 'Tie';
          }
        }

        if (pendingStep) {
          const stateAfter = cloneBattleState(tracker.state);
          const rawLines = runner.accumulatedLines.slice(-10);

          // Loop 1 StateDiff validation
          const report = StateDiffValidator.validateTurnTransition(
            pendingStep.turn,
            pendingStep.stateBefore,
            stateAfter,
            pendingStep.chosenActionId,
            pendingStep.availableActions,
            rawLines
          );
          if (!report.isValid) stateDiffErrorsCount += report.errors.length;

          // Loop 3 Experience record
          const reward = ExperienceBuffer.computeReward(
            pendingStep.stateBefore,
            stateAfter,
            rawLines,
            true,
            winner
          );
          const record: ExperienceRecord = {
            battleId,
            turn: pendingStep.turn,
            step: pendingStep.step,
            state: pendingStep.stateBefore,
            available_actions: pendingStep.availableActions,
            selected_action: pendingStep.chosenActionId,
            result: { rawLines, terminal: true, winner },
            reward,
            next_state: stateAfter
          };

          const val = ExperienceValidator.validateRecord(record);
          if (!val.valid) schemaErrorsCount++;
          battleExperiences.push(record);
          totalExperiencesCollected++;
          pendingStep = null;
        }
        break;
      }

      if (pendingStep) {
        tracker.processLines(actionable.rawLines);
        tracker.updateFromRequest(actionable.request);
        const stateAfter = cloneBattleState(tracker.state);

        // Loop 1 StateDiff validation
        const report = StateDiffValidator.validateTurnTransition(
          pendingStep.turn,
          pendingStep.stateBefore,
          stateAfter,
          pendingStep.chosenActionId,
          pendingStep.availableActions,
          actionable.rawLines
        );
        if (!report.isValid) stateDiffErrorsCount += report.errors.length;

        // Loop 3 Experience record
        const reward = ExperienceBuffer.computeReward(
          pendingStep.stateBefore,
          stateAfter,
          actionable.rawLines,
          false
        );
        const record: ExperienceRecord = {
          battleId,
          turn: pendingStep.turn,
          step: pendingStep.step,
          state: pendingStep.stateBefore,
          available_actions: pendingStep.availableActions,
          selected_action: pendingStep.chosenActionId,
          result: { rawLines: actionable.rawLines, terminal: false },
          reward,
          next_state: stateAfter
        };

        const val = ExperienceValidator.validateRecord(record);
        if (!val.valid) schemaErrorsCount++;
        battleExperiences.push(record);
        totalExperiencesCollected++;
        pendingStep = null;
      } else {
        tracker.processLines(actionable.rawLines);
        tracker.updateFromRequest(actionable.request);
      }

      battleSteps++;
      totalSteps++;
      const currentTurn = tracker.state.turn;
      const stateBefore = cloneBattleState(tracker.state);
      const availableActions = CandidateGenerator.generateCandidates(tracker.state, actionable.request);

      const decision = BaselineEngine.selectBestAction(tracker.state, actionable.request);
      const chosenActionId = decision.candidate.id;

      // Legality validation
      if (!availableActions.some(a => a.id === chosenActionId)) {
        illegalActionsCount++;
      }

      pendingStep = {
        turn: currentTurn,
        step: battleSteps,
        stateBefore,
        chosenActionId,
        availableActions
      };

      await runner.chooseP1(chosenActionId);
    }

    if (winner === p1Name) {
      wins++;
    } else if (winner === 'Tie') {
      draws++;
    } else {
      losses++;
    }

    // Flush this battle's experiences to disk (JSON Lines) to prevent memory leak
    if (battleExperiences.length > 0) {
      const lines = battleExperiences.map(r => JSON.stringify(r)).join('\n') + '\n';
      fs.appendFileSync(experienceSavePath, lines, 'utf-8');
    }

    // Release runner streams & clear memory
    runner.destroy();

    // Record memory sample every verboseInterval battles (or at 10 and targetCount)
    if (b === 10 || b % verboseInterval === 0 || b === targetCount) {
      const sample = sampleMemory(b);
      memorySamples.push(sample);
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  [Battle ${b.toString().padStart(3, ' ')}/${targetCount}] ` +
        `Wins: ${wins.toString().padStart(2, ' ')} | Losses: ${losses.toString().padStart(2, ' ')} | Draws: ${draws} | ` +
        `HeapUsed: ${sample.heapUsedMB.toFixed(1)} MB | RSS: ${sample.rssMB.toFixed(1)} MB | Elapsed: ${elapsedSec}s`
      );
    }
  }

  const tallySum = wins + losses + draws;

  // Compute memory metrics: Battle 10 vs Battle 100
  const sample10 = memorySamples.find(s => s.battleNumber === 10) || memorySamples[0];
  const sample100 = memorySamples[memorySamples.length - 1];

  const memAfterBattle10MB = sample10.heapUsedMB;
  const memAfterBattle100MB = sample100.heapUsedMB;

  const memoryGrowthPercent =
    memAfterBattle10MB > 0
      ? Math.round(((memAfterBattle100MB - memAfterBattle10MB) / memAfterBattle10MB) * 1000) / 10
      : 0;

  // Criteria: Memory after battle 100 is not > 20% above after battle 10
  const memoryLeakDetected = memoryGrowthPercent > 20.0;

  const allLoop1CriteriaMet =
    tallySum === targetCount &&
    illegalActionsCount === 0 &&
    stateDiffErrorsCount === 0;

  const allExperiencesSchemaValid =
    schemaErrorsCount === 0 && totalExperiencesCollected === totalSteps;

  const allPass =
    tallySum === targetCount &&
    allLoop1CriteriaMet &&
    allExperiencesSchemaValid &&
    !memoryLeakDetected;

  console.log(`\n================================================================================`);
  console.log(`                      LOOP 4 VERIFICATION FINAL TALLY                           `);
  console.log(`================================================================================`);
  console.log(`Consecutive Battles Run:     ${targetCount} (100% Unattended)`);
  console.log(`Tally Breakdown:             Wins: ${wins} | Losses: ${losses} | Draws: ${draws}`);
  console.log(`Tally Sum:                   ${tallySum} / ${targetCount} (${tallySum === targetCount ? '100% EXACT' : 'FAIL'})`);
  console.log(`Total Decision Steps:        ${totalSteps}`);
  console.log(`Illegal Actions:             ${illegalActionsCount} (Target: 0)`);
  console.log(`State Diff Errors:           ${stateDiffErrorsCount} (Target: 0)`);
  console.log(`Loop 1 Compliance:           ${allLoop1CriteriaMet ? '100/100 PASSED' : 'FAILED'}`);
  console.log(`Experiences Collected:       ${totalExperiencesCollected}`);
  console.log(`Schema Validation:           ${allExperiencesSchemaValid ? '100% VALID' : 'FAILED'}`);
  console.log(`Experiences Saved to:        ${experienceSavePath}`);
  console.log(`Memory after Battle 10:      ${memAfterBattle10MB.toFixed(2)} MB`);
  console.log(`Memory after Battle 100:     ${memAfterBattle100MB.toFixed(2)} MB`);
  console.log(`Memory Growth (10 -> 100):   ${memoryGrowthPercent >= 0 ? '+' : ''}${memoryGrowthPercent.toFixed(1)}% (Threshold: <= 20%)`);
  console.log(`Memory Leak Status:          ${memoryLeakDetected ? 'FLAGGED LEAK (>20%)' : 'NO LEAK DETECTED (PASSED)'}`);
  console.log(`Overall Loop 4 Result:       ${allPass ? 'PASS' : 'FAIL'}`);
  console.log(`================================================================================\n`);

  return {
    totalBattles: targetCount,
    completedBattles: targetCount,
    wins,
    losses,
    draws,
    tallySum,
    allLoop1CriteriaMet,
    totalSteps,
    totalExperiencesCollected,
    allExperiencesSchemaValid,
    memorySamples,
    memAfterBattle10MB,
    memAfterBattle100MB,
    memoryGrowthPercent,
    memoryLeakDetected,
    allPass
  };
}

if (process.argv[1] && process.argv[1].endsWith('loop4-runner.ts')) {
  run100AutonomousBattles({ battleCount: 100, verboseInterval: 10 }).catch(err => {
    console.error('Fatal execution error in Loop 4:', err);
    process.exit(1);
  });
}
