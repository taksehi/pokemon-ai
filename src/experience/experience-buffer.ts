import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ExperienceRecord, ExperienceValidator } from './experience-record.js';
import { BattleState } from '../battle/battle-state.js';

export interface BattleReconstruction {
  battleId: string;
  totalTurns: number;
  totalSteps: number;
  winner?: string;
  timeline: Array<{
    turn: number;
    step: number;
    p1Active: string;
    p2Active: string;
    p1Hp: number;
    p2Hp: number;
    action: string;
    reward: number;
    nextP1Active: string;
    nextP2Active: string;
    nextP1Hp: number;
    nextP2Hp: number;
  }>;
  losslessStateChaining: boolean;
}

export class ExperienceBuffer {
  private records: ExperienceRecord[] = [];

  constructor(initialRecords: ExperienceRecord[] = []) {
    for (const r of initialRecords) {
      this.addRecord(r);
    }
  }

  /**
   * Appends an experience record. Rejects malformed records at write time.
   */
  public addRecord(record: ExperienceRecord): void {
    // Write-time validation: throws if malformed
    ExperienceValidator.assertValid(record);
    this.records.push(record);
  }

  public getRecords(): readonly ExperienceRecord[] {
    return this.records;
  }

  public size(): number {
    return this.records.length;
  }

  public clear(): void {
    this.records = [];
  }

  /**
   * Computes SHA-256 hash of the in-memory records.
   */
  public getHash(): string {
    const serialized = JSON.stringify(this.records);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Saves records losslessly to a JSON file.
   */
  public saveToFile(filePath: string): { filePath: string; hash: string; recordCount: number } {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      hash: this.getHash(),
      count: this.records.length,
      records: this.records
    };

    const jsonStr = JSON.stringify(payload, null, 2);
    fs.writeFileSync(filePath, jsonStr, 'utf-8');

    return {
      filePath,
      hash: payload.hash,
      recordCount: this.records.length
    };
  }

  /**
   * Loads records from a JSON file, verifying round-trip integrity and validating every record.
   */
  public static loadFromFile(filePath: string): { buffer: ExperienceBuffer; hash: string; recordCount: number } {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Experience file not found: ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    const buffer = new ExperienceBuffer();
    for (const r of parsed.records) {
      buffer.addRecord(r);
    }

    const computedHash = buffer.getHash();
    if (parsed.hash && parsed.hash !== computedHash) {
      throw new Error(`Data corruption detected: file hash ${parsed.hash} != computed hash ${computedHash}`);
    }

    return {
      buffer,
      hash: computedHash,
      recordCount: buffer.size()
    };
  }

  /**
   * Reconstructs an entire battle turn-by-turn strictly from saved records alone.
   */
  public reconstructBattle(battleId: string): BattleReconstruction {
    const battleRecords = this.records
      .filter(r => r.battleId === battleId)
      .sort((a, b) => a.step - b.step);

    if (battleRecords.length === 0) {
      throw new Error(`No records found for battle ID: ${battleId}`);
    }

    let losslessStateChaining = true;
    const timeline: BattleReconstruction['timeline'] = [];

    for (let i = 0; i < battleRecords.length; i++) {
      const rec = battleRecords[i];
      const nextRec = battleRecords[i + 1];

      // Verify that next_state of step i strictly matches state of step i+1
      if (nextRec) {
        const stateChainingMatches =
          rec.next_state.turn === nextRec.state.turn &&
          rec.next_state.p1.active?.species === nextRec.state.p1.active?.species &&
          rec.next_state.p1.active?.hpPercent === nextRec.state.p1.active?.hpPercent &&
          rec.next_state.p2.active?.species === nextRec.state.p2.active?.species &&
          rec.next_state.p2.active?.hpPercent === nextRec.state.p2.active?.hpPercent;

        if (!stateChainingMatches) {
          losslessStateChaining = false;
        }
      }

      timeline.push({
        turn: rec.turn,
        step: rec.step,
        p1Active: rec.state.p1.active?.species || 'None',
        p2Active: rec.state.p2.active?.species || 'None',
        p1Hp: rec.state.p1.active?.hpPercent ?? 0,
        p2Hp: rec.state.p2.active?.hpPercent ?? 0,
        action: rec.selected_action,
        reward: rec.reward,
        nextP1Active: rec.next_state.p1.active?.species || 'None',
        nextP2Active: rec.next_state.p2.active?.species || 'None',
        nextP1Hp: rec.next_state.p1.active?.hpPercent ?? 0,
        nextP2Hp: rec.next_state.p2.active?.hpPercent ?? 0
      });
    }

    const lastRecord = battleRecords[battleRecords.length - 1];
    const winner = lastRecord.result.winner;
    const totalTurns = lastRecord.next_state.turn;

    return {
      battleId,
      totalTurns,
      totalSteps: battleRecords.length,
      winner,
      timeline,
      losslessStateChaining
    };
  }

  /**
   * Helper to compute competitive reinforcement learning reward for a step transition.
   */
  public static computeReward(
    stateBefore: BattleState,
    stateAfter: BattleState,
    rawLines: string[],
    isTerminal: boolean,
    winner?: string
  ): number {
    let reward = 0;

    // Terminal battle outcome reward
    if (isTerminal) {
      if (winner === 'Alice_AI' || winner === stateBefore.p1.name) {
        reward += 10.0; // Win bonus
      } else if (winner === 'Tie') {
        reward += 0.0;
      } else if (winner && winner !== 'Unknown') {
        reward -= 10.0; // Loss penalty
      }
    }

    // Damage differential reward
    const p1HpBefore = stateBefore.p1.active?.hpPercent ?? 0;
    const p1HpAfter = stateAfter.p1.active?.hpPercent ?? 0;
    const p2HpBefore = stateBefore.p2.active?.hpPercent ?? 0;
    const p2HpAfter = stateAfter.p2.active?.hpPercent ?? 0;

    const damageDealt = Math.max(0, p2HpBefore - p2HpAfter);
    const damageTaken = Math.max(0, p1HpBefore - p1HpAfter);

    reward += (damageDealt * 0.05) - (damageTaken * 0.05);

    // KO bonuses
    for (const line of rawLines) {
      if (line.startsWith('|faint|')) {
        const slot = line.split('|')[1];
        if (slot.startsWith('p2')) {
          reward += 2.0; // Knocked out opponent
        } else if (slot.startsWith('p1')) {
          reward -= 2.0; // Lost our Pokemon
        }
      }
    }

    return Math.round(reward * 100) / 100;
  }
}
