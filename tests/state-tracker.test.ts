import { describe, it, expect } from 'vitest';
import { StateTracker } from '../src/battle/state-tracker.js';
import { BattleRunner } from '../src/sim/battle-runner.js';
import { BattleLogger } from '../src/utils/battle-logger.js';
import { CandidateGenerator } from '../src/strategy/candidate-generator.js';

describe('Loop 2: StateTracker Protocol Parsing & Synchronization', () => {
  it('should parse synthetic protocol events accurately', () => {
    const tracker = new StateTracker('gen9ou');

    const lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Dragapult|Dragapult, L85, M|280/280',
      '|switch|p2a: Gholdengo|Gholdengo, L80|100/100',
      '|-ability|p2a: Gholdengo|Good as Gold',
      '|-weather|RainDance',
      '|-sidestart|p2: Bob|move: Stealth Rock',
      '|turn|2',
      '|move|p1a: Dragapult|Shadow Ball|p2a: Gholdengo',
      '|-damage|p2a: Gholdengo|42/100',
      '|move|p2a: Gholdengo|Make It Rain|p1a: Dragapult',
      '|-damage|p1a: Dragapult|160/280',
      '|-unboost|p2a: Gholdengo|spa|1'
    ];

    tracker.processLines(lines);

    const { state } = tracker;

    // Turn
    expect(state.turn).toBe(2);

    // Players
    expect(state.p1.name).toBe('Alice');
    expect(state.p2.name).toBe('Bob');

    // Field
    expect(state.field.weather).toBe('RainDance');
    expect(state.field.p2Hazards.stealthRock).toBe(true);
    expect(state.field.p1Hazards.stealthRock).toBe(false);

    // Active Pokémon
    expect(state.p1.active).not.toBeNull();
    expect(state.p1.active?.species).toBe('Dragapult');
    expect(state.p1.active?.currentHp).toBe(160);
    expect(state.p1.active?.maxHp).toBe(280);
    expect(state.p1.active?.hpPercent).toBe(57); // 160/280 ~ 57%

    expect(state.p2.active).not.toBeNull();
    expect(state.p2.active?.species).toBe('Gholdengo');
    expect(state.p2.active?.hpPercent).toBe(42);
    expect(state.p2.active?.revealedAbility).toBe('Good as Gold');
    expect(state.p2.active?.revealedMoves).toContain('Make It Rain');
    expect(state.p2.active?.boosts.spa).toBe(-1);

    // Verify instrumentation logger
    const logOutput = BattleLogger.formatState(state);
    expect(logOutput).toContain('[OBSERVE] Turn: 2');
    expect(logOutput).toContain('Dragapult (HP: 57%, 160/280)');
    expect(logOutput).toContain('Gholdengo (HP: ~42%)');
    expect(logOutput).toContain('RainDance');
  });

  it('should maintain live synchronized state across 3 turns in an in-memory battle', async () => {
    const runner = new BattleRunner();
    const tracker = new StateTracker('gen9randombattle');

    await runner.start({
      formatid: 'gen9randombattle',
      p1Name: 'Alice_AI',
      p2Name: 'Bob_Opponent',
      autoOpponent: true
    });

    // Turn 1
    const t1 = await runner.getNextActionableRequest();
    expect(t1).not.toBeNull();
    tracker.processLines(t1!.rawLines);
    tracker.updateFromRequest(t1!.request);

    expect(tracker.state.p1.active).not.toBeNull();
    expect(tracker.state.p2.active).not.toBeNull();
    expect(tracker.state.p1.team.length).toBe(6);
    expect(tracker.state.p1.active?.moves.length).toBeGreaterThan(0);
    expect(tracker.state.turn).toBe(1);

    // Turn 2
    await runner.chooseP1('move 1');
    const t2 = await runner.getNextActionableRequest();
    expect(t2).not.toBeNull();
    tracker.processLines(t2!.rawLines);
    tracker.updateFromRequest(t2!.request);

    // If a faint occurred, it could be a forceSwitch request on turn 1, or turn 2
    expect(tracker.state.p1.active).not.toBeNull();
    expect(tracker.state.p2.active).not.toBeNull();

    // Submit legal candidate action (move or forced switch)
    const t2Candidates = CandidateGenerator.generateCandidates(tracker.state, t2!.request);
    expect(t2Candidates.length).toBeGreaterThan(0);
    await runner.chooseP1(t2Candidates[0].id);

    // Turn 3
    const t3 = await runner.getNextActionableRequest();
    if (t3) {
      tracker.processLines(t3.rawLines);
      tracker.updateFromRequest(t3.request);
      expect(tracker.state.turn).toBeGreaterThanOrEqual(2);
    }
  });

  it('should correctly map state when bot is assigned to Player 2 slot', () => {
    const tracker = new StateTracker('gen9randombattle');

    // Simulate request received where bot is p2
    tracker.updateFromRequest({
      rqid: 1,
      side: {
        id: 'p2',
        name: 'AIBot_Alpha',
        pokemon: [
          {
            ident: 'p2: Garchomp',
            details: 'Garchomp, L80, M',
            condition: '300/300',
            active: true,
            stats: { atk: 250, def: 200, spa: 180, spd: 190, spe: 220 },
            moves: ['earthquake', 'outrage'],
            baseAbility: 'roughskin',
            item: 'rockyhelmet',
            pokeball: 'pokeball'
          }
        ]
      }
    });

    expect(tracker.playerSlot).toBe('p2');
    expect(tracker.opponentSlot).toBe('p1');

    // Protocol lines where p1 is human opponent and p2 is our bot
    const lines = [
      '|player|p1|HumanTrainer|',
      '|player|p2|AIBot_Alpha|',
      '|switch|p1a: Corviknight|Corviknight, L80, F|100/100',
      '|switch|p2a: Garchomp|Garchomp, L80, M|300/300',
      '|-sidestart|p2: AIBot_Alpha|move: Stealth Rock',
      '|-sidestart|p1: HumanTrainer|move: Spikes',
      '|move|p1a: Corviknight|Brave Bird|p2a: Garchomp',
      '|-damage|p2a: Garchomp|200/300'
    ];

    tracker.processLines(lines);

    // Our bot (p2) is mapped to state.p1
    expect(tracker.state.p1.name).toBe('AIBot_Alpha');
    expect(tracker.state.p1.active?.species).toBe('Garchomp');
    expect(tracker.state.p1.active?.currentHp).toBe(200);
    expect(tracker.state.field.p1Hazards.stealthRock).toBe(true);

    // Opponent (p1) is mapped to state.p2
    expect(tracker.state.p2.name).toBe('HumanTrainer');
    expect(tracker.state.p2.active?.species).toBe('Corviknight');
    expect(tracker.state.p2.active?.revealedMoves).toContain('Brave Bird');
    expect(tracker.state.field.p2Hazards.spikes).toBe(1);
  });
});
