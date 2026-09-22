import { describe, it, expect } from 'vitest';
import { runCompleteBattle } from '../src/index.js';

describe('Loop 6: Autonomous Battle Runner & Closed-Loop Execution', () => {
  it('should run a complete battle from start to finish using the Baseline Engine', async () => {
    const result = await runCompleteBattle({
      formatid: 'gen9randombattle',
      p1Name: 'Baseline_Agent',
      p2Name: 'Default_Bot',
      mode: 'baseline',
      verbose: false
    });

    expect(result.totalTurns).toBeGreaterThan(0);
    expect(result.decisionsMade).toBeGreaterThan(0);
    expect(result.fallbacksTriggered).toBe(0);
    expect(['Baseline_Agent', 'Default_Bot', 'Tie']).toContain(result.winner);
  }, 20000); // 20s timeout for complete battle

  it('should run a complete battle from start to finish using the AI Strategy Player', async () => {
    const result = await runCompleteBattle({
      formatid: 'gen9randombattle',
      p1Name: 'AI_Agent',
      p2Name: 'Default_Bot',
      mode: 'ai_mock',
      verbose: false
    });

    expect(result.totalTurns).toBeGreaterThan(0);
    expect(result.decisionsMade).toBeGreaterThan(0);
    expect(['AI_Agent', 'Default_Bot', 'Tie']).toContain(result.winner);
  }, 20000);

  it('should run a complete Gen 2 battle from start to finish using the Baseline Engine', async () => {
    const result = await runCompleteBattle({
      formatid: 'gen2randombattle',
      p1Name: 'Gen2_Hero',
      p2Name: 'Gen2_Rival',
      mode: 'baseline',
      verbose: false
    });

    expect(result.totalTurns).toBeGreaterThan(0);
    expect(result.decisionsMade).toBeGreaterThan(0);
    expect(result.fallbacksTriggered).toBe(0);
    expect(['Gen2_Hero', 'Gen2_Rival', 'Tie']).toContain(result.winner);
  }, 20000);
});
