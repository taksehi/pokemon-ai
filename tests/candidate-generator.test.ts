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

    // Confirm next actionable request arrives
    const turn2 = await runner.getNextActionableRequest();
    expect(turn2).not.toBeNull();
    tracker.processLines(turn2!.rawLines);
    tracker.updateFromRequest(turn2!.request);

    // If turn 1 resulted in a faint, handle forced switch so turn counter advances
    if (turn2!.request.forceSwitch) {
      const switchCandidates = CandidateGenerator.generateCandidates(tracker.state, turn2!.request);
      expect(switchCandidates.length).toBeGreaterThan(0);
      await runner.chooseP1(switchCandidates[0].id);

      const turn3 = await runner.getNextActionableRequest();
      if (turn3) {
        tracker.processLines(turn3.rawLines);
        tracker.updateFromRequest(turn3.request);
      }
    }

    expect(tracker.state.turn).toBeGreaterThanOrEqual(2);
  });

  it('should deterministically calculate Gen 2 damage and mechanics for Snorlax vs Zapdos in gen2ou', () => {
    const tracker = new StateTracker('gen2ou');

    const lines = [
      '|player|p1|Red|',
      '|player|p2|Blue|',
      '|turn|1',
      '|switch|p1a: Snorlax|Snorlax, L100|523/523',
      '|switch|p2a: Zapdos|Zapdos, L100|100/100'
    ];
    tracker.processLines(lines);

    const request: RequestPayload = {
      rqid: 1,
      active: [
        {
          moves: [
            { move: 'Double-Edge', id: 'doubleedge', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Body Slam', id: 'bodyslam', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Rest', id: 'rest', pp: 16, maxpp: 16, target: 'self', disabled: false },
            { move: 'Curse', id: 'curse', pp: 16, maxpp: 16, target: 'self', disabled: false }
          ]
        }
      ],
      side: {
        name: 'Red',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Snorlax',
            details: 'Snorlax, L100',
            condition: '523/523',
            active: true,
            stats: { atk: 318, def: 228, spa: 228, spd: 318, spe: 158 },
            moves: ['doubleedge', 'bodyslam', 'rest', 'curse'],
            baseAbility: '',
            item: 'leftovers',
            pokeball: 'pokeball'
          }
        ]
      }
    };

    const candidates = CandidateGenerator.generateCandidates(tracker.state, request);
    expect(candidates.length).toBe(4);

    const deCandidate = candidates.find(c => c.choice === 'doubleedge');
    expect(deCandidate).toBeDefined();
    // In Gen 2, Snorlax Double-Edge deals ~38-46% to Zapdos
    expect(deCandidate!.evaluation.minDamagePercent).toBeGreaterThan(30);
    expect(deCandidate!.evaluation.maxDamagePercent).toBeLessThan(60);
    // Terastallize should be false in Gen 2
    expect(deCandidate!.terastallize).toBe(false);
  });

  it('should accurately detect incoming opponent KO threats and switch type resistances', () => {
    const tracker = new StateTracker('gen9ou');

    // P1 has frail Weavile at 35% HP facing high-speed iron valiant with Close Combat
    const lines = [
      '|player|p1|Alice|',
      '|player|p2|Bob|',
      '|turn|1',
      '|switch|p1a: Weavile|Weavile, L100, M|35/100',
      '|switch|p2a: Iron Valiant|Iron Valiant, L100|100/100',
      '|move|p2a: Iron Valiant|Close Combat|p1a: Weavile|[still]'
    ];
    tracker.processLines(lines);

    const request: RequestPayload = {
      rqid: 2,
      active: [
        {
          moves: [
            { move: 'Night Slash', id: 'nightslash', pp: 24, maxpp: 24, target: 'normal', disabled: false },
            { move: 'Ice Shard', id: 'iceshard', pp: 48, maxpp: 48, target: 'normal', disabled: false }
          ]
        }
      ],
      side: {
        name: 'Alice',
        id: 'p1',
        pokemon: [
          {
            ident: 'p1: Weavile',
            details: 'Weavile, L100, M',
            condition: '35/100',
            active: true,
            stats: { atk: 339, def: 166, spa: 113, spd: 206, spe: 383 },
            moves: ['nightslash', 'iceshard'],
            baseAbility: 'pressure',
            item: 'focussash',
            pokeball: 'pokeball'
          },
          {
            ident: 'p1: Gholdengo',
            details: 'Gholdengo, L100',
            condition: '100/100',
            active: false,
            stats: { atk: 140, def: 226, spa: 365, spd: 218, spe: 267 },
            moves: ['shadowball', 'makeitrain'],
            baseAbility: 'goodasgold',
            item: 'leftovers',
            pokeball: 'pokeball'
          }
        ]
      }
    };

    tracker.updateFromRequest(request);

    const candidates = CandidateGenerator.generateCandidates(tracker.state, request);

    // 1. Check Night Slash: slower move facing lethal Close Combat
    const nightSlash = candidates.find(c => c.choice === 'nightslash');
    expect(nightSlash).toBeDefined();
    expect(nightSlash!.evaluation.opponentThreatensKO).toBe(true);

    // 2. Check Ice Shard: priority move
    const iceShard = candidates.find(c => c.choice === 'iceshard');
    expect(iceShard).toBeDefined();
    expect(iceShard!.evaluation.priority).toBe(1);

    // 3. Check Gholdengo switch: Ghost/Steel is immune to Fighting (Close Combat) and resists Fairy
    const gholdengoSwitch = candidates.find(c => c.type === 'switch');
    expect(gholdengoSwitch).toBeDefined();
    expect(gholdengoSwitch!.evaluation.typeResistanceAgainstOpponent).toBeLessThanOrEqual(0.75);
    expect(gholdengoSwitch!.evaluation.switchInSafety).toBe('safe');
  });
});
