import path from 'node:path';
import { BattleRunner } from './sim/battle-runner.js';
import { StateTracker } from './battle/state-tracker.js';
import { cloneBattleState, BattleState } from './battle/battle-state.js';
import { CandidateGenerator } from './strategy/candidate-generator.js';
import { BaselineEngine } from './strategy/baseline-engine.js';
import { ExperienceRecord, ExperienceValidator } from './experience/experience-record.js';
import { ExperienceBuffer, BattleReconstruction } from './experience/experience-buffer.js';

export interface Loop3VerificationSummary {
  battleId: string;
  totalTurns: number;
  totalSteps: number;
  winner: string;
  recordsCount: number;
  allRecordsSchemaValid: boolean;
  malformedRecordRejected: boolean;
  saveLoadRoundTripLossless: boolean;
  saveHash: string;
  loadHash: string;
  battleReconstructed: boolean;
  losslessStateChaining: boolean;
  allPass: boolean;
  reconstruction: BattleReconstruction;
}

export async function runLoop3Verification(outputPath?: string): Promise<Loop3VerificationSummary> {
  console.log(`================================================================================`);
  console.log(`         LOOP 3 VERIFICATION: EXPERIENCE COLLECTION & RECONSTRUCTION            `);
  console.log(`================================================================================\n`);

  const battleId = `battle_loop3_${Date.now()}`;
  const saveFilePath = outputPath ?? path.resolve(process.cwd(), 'data', 'loop3_experience.json');

  const runner = new BattleRunner();
  const tracker = new StateTracker('gen9randombattle');
  const buffer = new ExperienceBuffer();

  const p1Name = 'Experience_Agent';
  const p2Name = 'Simulator_Bot';

  await runner.start({
    formatid: 'gen9randombattle',
    p1Name,
    p2Name,
    autoOpponent: true
  });

  let step = 0;
  let winner = 'Unknown';

  let pendingStep: {
    turn: number;
    step: number;
    stateBefore: BattleState;
    chosenActionId: string;
    availableActions: any[];
  } | null = null;

  console.log(`[BATTLE START] Running 1 complete automated battle for experience collection...`);

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
        const reward = ExperienceBuffer.computeReward(
          pendingStep.stateBefore,
          stateAfter,
          runner.accumulatedLines.slice(-10),
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
          result: {
            rawLines: runner.accumulatedLines.slice(-10),
            terminal: true,
            winner
          },
          reward,
          next_state: stateAfter
        };

        buffer.addRecord(record);
        pendingStep = null;
      }
      break;
    }

    if (pendingStep) {
      tracker.processLines(actionable.rawLines);
      tracker.updateFromRequest(actionable.request);
      const stateAfter = cloneBattleState(tracker.state);

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
        result: {
          rawLines: actionable.rawLines,
          terminal: false
        },
        reward,
        next_state: stateAfter
      };

      buffer.addRecord(record);
      pendingStep = null;
    } else {
      tracker.processLines(actionable.rawLines);
      tracker.updateFromRequest(actionable.request);
    }

    step++;
    const currentTurn = tracker.state.turn;
    const stateBefore = cloneBattleState(tracker.state);
    const availableActions = CandidateGenerator.generateCandidates(tracker.state, actionable.request);

    const decision = BaselineEngine.selectBestAction(tracker.state, actionable.request);
    const chosenActionId = decision.candidate.id;

    pendingStep = {
      turn: currentTurn,
      step,
      stateBefore,
      chosenActionId,
      availableActions
    };

    await runner.chooseP1(chosenActionId);
  }

  console.log(`[BATTLE FINISHED] Winner: ${winner} | Total Steps: ${buffer.size()} | Final Turn: ${tracker.state.turn}\n`);

  // 1. Validate 100% of recorded experiences against Zod / ExperienceValidator
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`[CRITERION 1] 100% Schema Validation Across All Completed Turns`);
  console.log(`--------------------------------------------------------------------------------`);
  const allRecords = buffer.getRecords();
  let schemaErrorsCount = 0;

  allRecords.forEach((r, idx) => {
    const val = ExperienceValidator.validateRecord(r);
    if (!val.valid) {
      schemaErrorsCount++;
      console.error(`  Record ${idx + 1} INVALID:`, val.errors);
    }
  });

  const allRecordsSchemaValid = schemaErrorsCount === 0 && allRecords.length > 0;
  console.log(`  Records Validated:         ${allRecords.length} / ${allRecords.length}`);
  console.log(`  Schema Invalidation Count: ${schemaErrorsCount}`);
  console.log(`  Status:                    ${allRecordsSchemaValid ? 'PASS (100% VALID)' : 'FAIL'}\n`);

  // 2. Verify write-time rejection of malformed records
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`[CRITERION 2] Malformed Record Rejection at Write Time`);
  console.log(`--------------------------------------------------------------------------------`);
  let malformedRecordRejected = false;
  try {
    const malformed: any = {
      battleId: 'test_malformed',
      turn: 1,
      step: 1,
      // Missing state!
      available_actions: [], // Empty available actions!
      selected_action: 'move 99', // Illegal selected action!
      result: { rawLines: [], terminal: false },
      reward: 0
    };
    buffer.addRecord(malformed);
  } catch (err: any) {
    malformedRecordRejected = true;
    console.log(`  Malformed Record Detected & Rejected: YES`);
    console.log(`  Exception Message: "${err.message}"`);
    console.log(`  Status: PASS (Rejected at write time, not silently dropped)\n`);
  }

  // 3. Lossless Save -> Load Round-Trip Verification
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`[CRITERION 3] Lossless Save -> Load Round-Trip (SHA-256 Hash Verification)`);
  console.log(`--------------------------------------------------------------------------------`);
  const saveResult = buffer.saveToFile(saveFilePath);
  console.log(`  Saved to:                  ${saveResult.filePath}`);
  console.log(`  Saved Record Count:        ${saveResult.recordCount}`);
  console.log(`  SHA-256 Save Hash:         ${saveResult.hash}`);

  const loadResult = ExperienceBuffer.loadFromFile(saveFilePath);
  console.log(`  Loaded Record Count:       ${loadResult.recordCount}`);
  console.log(`  SHA-256 Load Hash:         ${loadResult.hash}`);

  const saveLoadRoundTripLossless =
    saveResult.hash === loadResult.hash &&
    saveResult.recordCount === loadResult.recordCount &&
    saveResult.recordCount > 0;

  console.log(`  Hash Match:                ${saveResult.hash === loadResult.hash ? 'IDENTICAL' : 'MISMATCH'}`);
  console.log(`  Status:                    ${saveLoadRoundTripLossless ? 'PASS (LOSSLESS)' : 'FAIL'}\n`);

  // 4. Battle Reconstruction Turn-by-Turn from Saved Records Alone
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`[CRITERION 4] Full Battle Reconstruction Turn-by-Turn from Saved Records Alone`);
  console.log(`--------------------------------------------------------------------------------`);
  const reconstruction = loadResult.buffer.reconstructBattle(battleId);
  console.log(`  Reconstructed Battle ID:   ${reconstruction.battleId}`);
  console.log(`  Total Timeline Steps:      ${reconstruction.timeline.length}`);
  console.log(`  Reconstructed Winner:      ${reconstruction.winner}`);
  console.log(`  Lossless State Chaining:   ${reconstruction.losslessStateChaining ? 'CONFIRMED' : 'BROKEN'}`);

  console.log(`\n  Sample Reconstructed Turns:`);
  reconstruction.timeline.slice(0, 5).forEach(t => {
    console.log(
      `    [Step ${t.step.toString().padStart(2, ' ')} | Turn ${t.turn.toString().padStart(2, ' ')}] ` +
      `P1: ${t.p1Active} (${t.p1Hp}%) vs P2: ${t.p2Active} (${t.p2Hp}%) -> ` +
      `Action: "${t.action}" (Reward: ${t.reward >= 0 ? '+' : ''}${t.reward}) -> ` +
      `Next P1: ${t.nextP1Active} (${t.nextP1Hp}%), Next P2: ${t.nextP2Active} (${t.nextP2Hp}%)`
    );
  });
  if (reconstruction.timeline.length > 5) {
    const last = reconstruction.timeline[reconstruction.timeline.length - 1];
    console.log(`    ...`);
    console.log(
      `    [Step ${last.step.toString().padStart(2, ' ')} | Turn ${last.turn.toString().padStart(2, ' ')}] ` +
      `P1: ${last.p1Active} (${last.p1Hp}%) vs P2: ${last.p2Active} (${last.p2Hp}%) -> ` +
      `Action: "${last.action}" (Reward: ${last.reward >= 0 ? '+' : ''}${last.reward}) -> ` +
      `Next P1: ${last.nextP1Active} (${last.nextP1Hp}%), Next P2: ${last.nextP2Active} (${last.nextP2Hp}%) [TERMINAL]`
    );
  }

  const battleReconstructed =
    reconstruction.timeline.length === allRecords.length &&
    reconstruction.losslessStateChaining === true &&
    reconstruction.winner === winner;

  console.log(`\n  Status:                    ${battleReconstructed ? 'PASS' : 'FAIL'}\n`);

  const allPass =
    allRecordsSchemaValid &&
    malformedRecordRejected &&
    saveLoadRoundTripLossless &&
    battleReconstructed;

  console.log(`================================================================================`);
  console.log(`                      LOOP 3 VERIFICATION FINAL TALLY                           `);
  console.log(`================================================================================`);
  console.log(`Schema Validation:           ${allRecordsSchemaValid ? '100% VALID' : 'FAIL'}`);
  console.log(`Malformed Record Rejection:  ${malformedRecordRejected ? 'CONFIRMED' : 'FAIL'}`);
  console.log(`Save -> Load Round-Trip:     ${saveLoadRoundTripLossless ? 'LOSSLESS' : 'FAIL'}`);
  console.log(`Turn-by-Turn Reconstruction: ${battleReconstructed ? 'LOSSLESS' : 'FAIL'}`);
  console.log(`Overall Loop 3 Result:       ${allPass ? 'PASS' : 'FAIL'}`);
  console.log(`================================================================================\n`);

  return {
    battleId,
    totalTurns: tracker.state.turn,
    totalSteps: allRecords.length,
    winner,
    recordsCount: allRecords.length,
    allRecordsSchemaValid,
    malformedRecordRejected,
    saveLoadRoundTripLossless,
    saveHash: saveResult.hash,
    loadHash: loadResult.hash,
    battleReconstructed,
    losslessStateChaining: reconstruction.losslessStateChaining,
    allPass,
    reconstruction
  };
}

if (process.argv[1] && process.argv[1].endsWith('loop3-runner.ts')) {
  runLoop3Verification().catch(err => {
    console.error('Fatal execution error in Loop 3:', err);
    process.exit(1);
  });
}
