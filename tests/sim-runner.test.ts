import { describe, it, expect } from 'vitest';
import { BattleRunner } from '../src/sim/battle-runner.js';

describe('Loop 1: BattleRunner In-Memory Stream Ingestion', () => {
  it('should initialize a Gen 9 random battle and receive an actionable Turn 1 request', async () => {
    const runner = new BattleRunner();
    await runner.start({
      formatid: 'gen9randombattle',
      p1Name: 'Agent_P1',
      p2Name: 'Bot_P2',
      autoOpponent: true
    });

    const result = await runner.getNextActionableRequest();
    expect(result).not.toBeNull();
    if (!result) return;

    const { request, rawLines } = result;

    // Check request structure
    expect(request.wait).toBeFalsy();
    expect(request.side).toBeDefined();
    expect(request.side.name).toBe('Agent_P1');
    expect(request.side.pokemon).toHaveLength(6);

    // Active pokemon must have legal moves
    expect(request.active).toBeDefined();
    expect(request.active![0].moves.length).toBeGreaterThan(0);

    const firstMove = request.active![0].moves[0];
    expect(firstMove.id).toBeDefined();
    expect(firstMove.pp).toBeGreaterThan(0);

    // Verify protocol lines contain expected initialization tokens
    const joined = rawLines.join('\n');
    expect(joined).toContain('|gametype|singles');
    expect(joined).toContain('|player|p1|Agent_P1|');
    expect(joined).toContain('|player|p2|Bot_P2|');
    expect(joined).toContain('|start');
  });

  it('should progress to Turn 2 when both players submit choices', async () => {
    const runner = new BattleRunner();
    await runner.start({
      formatid: 'gen9randombattle',
      p1Name: 'Agent_P1',
      p2Name: 'Bot_P2',
      autoOpponent: true
    });

    const turn1Result = await runner.getNextActionableRequest();
    expect(turn1Result).not.toBeNull();

    // Player 1 chooses move 1, autoOpponent automatically handles Player 2
    await runner.chooseP1('move 1');

    const turn2Result = await runner.getNextActionableRequest();
    expect(turn2Result).not.toBeNull();
    if (!turn2Result) return;

    // Raw lines should contain turn events and move execution
    const joined = turn2Result.rawLines.join('\n');
    expect(joined).toMatch(/\|turn\|\d+|\|faint\|/);
    expect(joined).toMatch(/\|move\|/);
  });
});
