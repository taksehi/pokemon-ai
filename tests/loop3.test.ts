import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { runLoop3Verification } from '../src/loop3-runner.js';
import { ExperienceValidator } from '../src/experience/experience-record.js';
import { ExperienceBuffer } from '../src/experience/experience-buffer.js';

describe('LOOP 3: Experience Collection & Reconstruction', () => {
  const testFile = path.resolve(process.cwd(), 'data', 'test_loop3_experience.json');

  afterAll(() => {
    if (fs.existsSync(testFile)) {
      try {
        fs.unlinkSync(testFile);
      } catch {}
    }
  });

  it('should run a complete battle, collect valid experience records, and pass 100% schema validation', async () => {
    const summary = await runLoop3Verification(testFile);

    expect(summary.recordsCount).toBeGreaterThan(0);
    expect(summary.allRecordsSchemaValid).toBe(true);
    expect(summary.malformedRecordRejected).toBe(true);
    expect(summary.saveLoadRoundTripLossless).toBe(true);
    expect(summary.saveHash).toBe(summary.loadHash);
    expect(summary.battleReconstructed).toBe(true);
    expect(summary.losslessStateChaining).toBe(true);
    expect(summary.allPass).toBe(true);
  }, 30000);

  it('should strictly reject malformed records at write time', () => {
    const buffer = new ExperienceBuffer();
    expect(() => {
      buffer.addRecord({
        battleId: 'test_bad',
        turn: 1,
        step: 1,
        state: null as any,
        available_actions: [],
        selected_action: 'invalid_action',
        result: { rawLines: [], terminal: false },
        reward: 0,
        next_state: null as any
      });
    }).toThrowError(/Malformed record rejected/);
  });
});
