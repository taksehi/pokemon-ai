import { describe, it, expect } from 'vitest';
import { CandidateGenerator } from '../src/strategy/candidate-generator.js';
import { StateTracker } from '../src/battle/state-tracker.js';
import { BattleRunner, RequestPayload } from '../src/sim/battle-runner.js';

describe('Loop 3: CandidateGenerator & Deterministic Damage Evaluation', () => {
  it('should deterministically calculate damage, KO chance, and speed for Dragapult vs Gholdengo', () => {
    const tracker = new StateTracker('gen9ou');

    // Synthetic setup
    const lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Dragapult|Dragapult, L100, M|317/317',
      '|switch|p2a: Gholdengo|Gholdengo, L100|70/100',
      '|-ability|p2a: Gholdengo|Good as Gold'
    ];
    tracker.processLines(lines);

    const syntheticRequest: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Shadow Ball', id: 'shadowball', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Draco Meteor', id: 'dracometeor', pp: 8, maxpp: 8, target: 'normal', disabled: false },
            { move: 'U-turn', id: 'uturn', pp: 32, maxpp: 32, target: 'normal', disabled: false },
            { move: 'Flamethrower', id: 'flamethrower', pp: 24, maxpp: 24, target: 'normal', disabled: false }
          ],
          canTerastallize: 'Ghost'
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Dragapult',
            details: 'Dragapult, L100, M',
            condition: '317/317',
            active: true,
            stats: { atk: 256, def: 186, spa: 299, spd: 186, spe: 421 },
            moves: ['shadowball', 'dracometeor', 'uturn', 'flamethrower'],
            baseAbility: 'infiltrator',
            item: 'choicespecs',
            pokeball: 'pokeball'
          },
          {
            ident: 'p1: Volcarona',
            details: 'Volcarona, L100, F',
            condition: '311/311',
            active: false,
            stats: { atk: 140, def: 166, spa: 369, spd: 246, spe: 299 },
            moves: ['quiverdance', 'fierydance', 'bugbuzz', 'roost'],
            baseAbility: 'flamebody',
            item: '',
            pokeball: 'pokeball'
          },
          {
            ident: 'p1: Ting-Lu',
            details: 'Ting-Lu, L100',
            condition: '514/514',
            active: false,
            stats: { atk: 256, def: 286, spa: 120, spd: 260, spe: 126 },
            moves: ['earthquake', 'stealthrock', 'ruination', 'whirlwind'],
            baseAbility: 'vesselofruin',
            item: 'leftovers',
            pokeball: 'pokeball'
          }
        ]
      }
    };

    tracker.updateFromRequest(syntheticRequest);

    // Also set Stealth Rock on our side to verify hazard calculation
    tracker.processLine('|-sidestart|p1: Alice|move: Stealth Rock');

    const candidates = CandidateGenerator.generateCandidates(tracker.state, syntheticRequest);

    // Verify candidates count: 4 normal moves + 4 terastallize moves + 2 switches (Volcarona & Ting-Lu) = 10
    expect(candidates).toHaveLength(10);

    // 1. Check Shadow Ball
    const shadowBall = candidates.find(c => c.id === 'move 1' && !c.terastallize);
    expect(shadowBall).toBeDefined();
    expect(shadowBall!.evaluation.minDamagePercent).toBeGreaterThan(60);
    expect(shadowBall!.evaluation.maxDamagePercent).toBeGreaterThan(80);
    expect(shadowBall!.evaluation.outspeeds).toBe(true);
    // Gholdengo is at 70% HP, so high chance to KO
    expect(shadowBall!.evaluation.koProbability).toBeGreaterThan(0.5);

    // 2. Check Terastallized Shadow Ball deals even more damage
    const teraShadowBall = candidates.find(c => c.id === 'move 1 terastallize');
    expect(teraShadowBall).toBeDefined();
    expect(teraShadowBall!.evaluation.minDamagePercent).toBeGreaterThan(shadowBall!.evaluation.minDamagePercent);

    // 3. Check Volcarona switch (Fire/Bug is 4x weak to Rock: 50% Stealth Rock damage without boots!)
    const volcaronaSwitch = candidates.find(c => c.id === 'switch 2');
    expect(volcaronaSwitch).toBeDefined();
    expect(volcaronaSwitch!.evaluation.hazardDamagePercent).toBe(50);
    expect(volcaronaSwitch!.evaluation.switchInSafety).toBe('risky');

    // 4. Check Ting-Lu switch (Dark/Ground resists Rock: 6.3% Stealth Rock damage)
    const tingLuSwitch = candidates.find(c => c.id === 'switch 3');
    expect(tingLuSwitch).toBeDefined();
    expect(tingLuSwitch!.evaluation.hazardDamagePercent).toBe(6.3);
    expect(tingLuSwitch!.evaluation.switchInSafety).toBe('safe');
  });

  it('should generate legal candidates in a live in-memory battle and successfully execute the highest damage move', async () => {
    const runner = new BattleRunner();
    const tracker = new StateTracker('gen9randombattle');

    await runner.start({
      formatid: 'gen9randombattle',
      p1Name: 'Alice_AI',
      p2Name: 'Bob_Opponent',
      autoOpponent: true
    });

    const turn1 = await runner.getNextActionableRequest();
    expect(turn1).not.toBeNull();
    tracker.processLines(turn1!.rawLines);
    tracker.updateFromRequest(turn1!.request);

    const candidates = CandidateGenerator.generateCandidates(tracker.state, turn1!.request);
    expect(candidates.length).toBeGreaterThan(0);

    // Sort by max damage
    const moveCandidates = candidates.filter(c => c.type === 'move' && !c.terastallize);
    expect(moveCandidates.length).toBeGreaterThan(0);

    // Pick candidate with highest max damage
    const bestMove = [...moveCandidates].sort(
      (a, b) => b.evaluation.maxDamagePercent - a.evaluation.maxDamagePercent
    )[0];

    expect(bestMove).toBeDefined();

    // Execute choice in simulator
    await runner.chooseP1(bestMove.id);

    // Confirm next turn arrives
    const turn2 = await runner.getNextActionableRequest();
    expect(turn2).not.toBeNull();
    tracker.processLines(turn2!.rawLines);
    tracker.updateFromRequest(turn2!.request);

    expect(tracker.state.turn).toBeGreaterThanOrEqual(2);
  });
});
