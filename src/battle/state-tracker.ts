import {
  BattleState,
  PlayerPokemon,
  OpponentPokemon,
  createInitialBattleState,
  createInitialBoostTable,
  BoostTable
} from './battle-state.js';
import { RequestPayload, PokemonSideItem } from '../sim/battle-runner.js';

export class StateTracker {
  public state: BattleState;
  public playerSlot: 'p1' | 'p2' = 'p1';

  constructor(format: string = 'gen9randombattle') {
    this.state = createInitialBattleState(format);
  }

  public get opponentSlot(): 'p1' | 'p2' {
    return this.playerSlot === 'p1' ? 'p2' : 'p1';
  }

  public isPlayerSlot(slot?: string): boolean {
    return Boolean(slot && slot.startsWith(this.playerSlot));
  }

  public isOpponentSlot(slot?: string): boolean {
    return Boolean(slot && slot.startsWith(this.opponentSlot));
  }

  /**
   * Ingests a list of raw protocol lines (e.g. from a turn's events).
   */
  public processLines(lines: string[]): void {
    for (const rawLine of lines) {
      this.processLine(rawLine);
    }
  }

  /**
   * Ingests a single protocol line.
   */
  public processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('|')) return;

    const parts = trimmed.split('|').slice(1);
    const cmd = parts[0];

    switch (cmd) {
      case 'player': {
        // |player|p1|Alice|
        const slot = parts[1];
        const name = parts[2];
        if (slot === this.playerSlot) this.state.p1.name = name || 'Player 1';
        if (slot === this.opponentSlot) this.state.p2.name = name || 'Player 2';
        break;
      }

      case 'turn': {
        // |turn|3
        const turnNum = parseInt(parts[1], 10);
        if (!isNaN(turnNum)) {
          this.state.turn = turnNum;
        }
        break;
      }

      case 'switch':
      case 'drag': {
        // |switch|p1a: Hitmontop|Hitmontop, L88, M|231/231
        // |switch|p2a: Dondozo|Dondozo, L78, M|100/100
        const slot = parts[1];
        const details = parts[2];
        const condition = parts[3];
        this.handleSwitch(slot, details, condition);
        break;
      }

      case '-damage':
      case '-heal': {
        // |-damage|p1a: Hitmontop|150/231
        // |-damage|p2a: Dondozo|75/100
        const slot = parts[1];
        const condition = parts[2];
        this.handleConditionUpdate(slot, condition);
        break;
      }

      case 'faint': {
        // |faint|p2a: Dondozo
        const slot = parts[1];
        this.handleFaint(slot);
        break;
      }

      case 'move': {
        // |move|p2a: Dondozo|Wave Crash|p1a: Hitmontop
        const slot = parts[1];
        const moveName = parts[2];
        if (this.isOpponentSlot(slot) && this.state.p2.active) {
          if (!this.state.p2.active.revealedMoves.includes(moveName)) {
            this.state.p2.active.revealedMoves.push(moveName);
          }
        }
        break;
      }

      case '-ability': {
        // |-ability|p2a: Dondozo|Unaware|boost
        const slot = parts[1];
        const ability = parts[2];
        if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.revealedAbility = ability;
        }
        break;
      }

      case '-item': {
        // |-item|p2a: Dondozo|Leftovers|[from] ability: Frisk
        const slot = parts[1];
        const item = parts[2];
        if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.revealedItem = item;
        }
        break;
      }

      case '-enditem': {
        // |-enditem|p2a: Dondozo|Booster Energy|[from] move: Knock Off
        const slot = parts[1];
        if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.revealedItem = null;
        }
        break;
      }

      case '-terastallize': {
        // |-terastallize|p2a: Dondozo|Water
        const slot = parts[1];
        const teraType = parts[2];
        if (this.isPlayerSlot(slot) && this.state.p1.active) {
          this.state.p1.active.terastallized = true;
          this.state.p1.active.teraType = teraType;
        } else if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.terastallized = true;
          this.state.p2.active.teraType = teraType;
        }
        break;
      }

      case '-status': {
        // |-status|p1a: Snorlax|slp
        const slot = parts[1];
        const status = parts[2];
        if (this.isPlayerSlot(slot) && this.state.p1.active) {
          this.state.p1.active.status = status;
        } else if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.status = status;
        }
        break;
      }

      case '-curestatus': {
        // |-curestatus|p1a: Snorlax|slp
        const slot = parts[1];
        if (this.isPlayerSlot(slot) && this.state.p1.active) {
          this.state.p1.active.status = null;
        } else if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.status = null;
        }
        break;
      }

      case 'replace': {
        // |replace|p2a: Zoroark|Zoroark, L80, M
        const slot = parts[1];
        const details = this.parseDetails(parts[2] || '');
        if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.species = details.species;
        }
        break;
      }

      case '-boost': {
        // |-boost|p2a: Dondozo|atk|1
        const slot = parts[1];
        const stat = parts[2] as keyof BoostTable;
        const amount = parseInt(parts[3], 10) || 1;
        this.applyBoost(slot, stat, amount);
        break;
      }

      case '-unboost': {
        // |-unboost|p2a: Dondozo|atk|1
        const slot = parts[1];
        const stat = parts[2] as keyof BoostTable;
        const amount = parseInt(parts[3], 10) || 1;
        this.applyBoost(slot, stat, -amount);
        break;
      }

      case '-setboost': {
        // |-setboost|p1a: Snorlax|atk|6
        const slot = parts[1];
        const stat = parts[2] as keyof BoostTable;
        const amount = parseInt(parts[3], 10) || 0;
        const active = this.isPlayerSlot(slot) ? this.state.p1.active : this.state.p2.active;
        if (active && stat in active.boosts) {
          active.boosts[stat] = Math.max(-6, Math.min(6, amount));
        }
        break;
      }

      case '-clearboost': {
        const slot = parts[1];
        if (this.isPlayerSlot(slot) && this.state.p1.active) {
          this.state.p1.active.boosts = createInitialBoostTable();
        } else if (this.isOpponentSlot(slot) && this.state.p2.active) {
          this.state.p2.active.boosts = createInitialBoostTable();
        }
        break;
      }

      case '-clearallboost': {
        if (this.state.p1.active) this.state.p1.active.boosts = createInitialBoostTable();
        if (this.state.p2.active) this.state.p2.active.boosts = createInitialBoostTable();
        break;
      }

      case '-weather': {
        // |-weather|RainDance|[from] ability: Drizzle
        const weather = parts[1];
        if (weather === 'none') {
          this.state.field.weather = null;
          this.state.field.weatherTurnsRemaining = null;
        } else {
          this.state.field.weather = weather;
          this.state.field.weatherTurnsRemaining = 5;
        }
        break;
      }

      case '-fieldstart': {
        // |-fieldstart|move: Electric Terrain
        const fieldEffect = parts[1];
        if (fieldEffect.includes('Terrain')) {
          this.state.field.terrain = fieldEffect.replace('move: ', '');
          this.state.field.terrainTurnsRemaining = 5;
        }
        break;
      }

      case '-fieldend': {
        const fieldEffect = parts[1];
        if (fieldEffect.includes('Terrain')) {
          this.state.field.terrain = null;
          this.state.field.terrainTurnsRemaining = null;
        }
        break;
      }

      case '-sidestart': {
        // |-sidestart|p1: Alice|move: Stealth Rock
        const sideSlot = parts[1];
        const hazard = parts[2].toLowerCase();
        const targetHazards = this.isPlayerSlot(sideSlot)
          ? this.state.field.p1Hazards
          : this.state.field.p2Hazards;

        if (hazard.includes('stealth rock')) targetHazards.stealthRock = true;
        if (hazard.includes('sticky web')) targetHazards.stickyWeb = true;
        if (hazard.includes('spikes') && !hazard.includes('toxic')) {
          targetHazards.spikes = Math.min(3, targetHazards.spikes + 1);
        }
        if (hazard.includes('toxic spikes')) {
          targetHazards.toxicSpikes = Math.min(2, targetHazards.toxicSpikes + 1);
        }
        break;
      }

      case '-sideend': {
        // |-sideend|p1: Alice|Stealth Rock
        const sideSlot = parts[1];
        const hazard = parts[2].toLowerCase();
        const targetHazards = this.isPlayerSlot(sideSlot)
          ? this.state.field.p1Hazards
          : this.state.field.p2Hazards;

        if (hazard.includes('stealth rock')) targetHazards.stealthRock = false;
        if (hazard.includes('sticky web')) targetHazards.stickyWeb = false;
        if (hazard.includes('spikes') && !hazard.includes('toxic')) targetHazards.spikes = 0;
        if (hazard.includes('toxic spikes')) targetHazards.toxicSpikes = 0;
        break;
      }
    }
  }

  /**
   * Updates Player 1 state using the ground-truth |request| payload.
   */
  public updateFromRequest(request: RequestPayload): void {
    if (request.side?.id) {
      this.playerSlot = request.side.id === 'p2' ? 'p2' : 'p1';
    }

    if (!request.side || !request.side.pokemon) return;

    // Sync full team
    const updatedTeam: PlayerPokemon[] = request.side.pokemon.map((p, idx) => {
      const parsedCond = this.parseCondition(p.condition);
      const details = this.parseDetails(p.details);

      // Check if this is the active pokemon
      const isActive = p.active;

      // Extract moves
      const moves = p.moves.map(m => {
        // Check active moves info for disabled status & PP
        let disabled = false;
        let pp = 5;
        let maxpp = 5;

        if (isActive && request.active && request.active[0]?.moves) {
          const activeMove = request.active[0].moves.find(
            am => am.id === m || am.move.toLowerCase().replace(/[^a-z0-9]/g, '') === m
          );
          if (activeMove) {
            disabled = activeMove.disabled ?? false;
            pp = activeMove.pp;
            maxpp = activeMove.maxpp;
          }
        }

        return {
          id: m,
          name: m,
          pp,
          maxpp,
          disabled
        };
      });

      return {
        ident: p.ident,
        species: details.species,
        level: details.level,
        gender: details.gender,
        currentHp: parsedCond.currentHp,
        maxHp: parsedCond.maxHp,
        hpPercent: parsedCond.maxHp > 0 ? Math.round((parsedCond.currentHp / parsedCond.maxHp) * 100) : 0,
        status: parsedCond.status,
        types: [],
        item: p.item || null,
        ability: p.ability || p.baseAbility || null,
        stats: p.stats,
        boosts: isActive && this.state.p1.active ? this.state.p1.active.boosts : createInitialBoostTable(),
        moves,
        fainted: parsedCond.fainted,
        active: isActive,
        teraType: p.teraType || (isActive && request.active?.[0]?.canTerastallize ? request.active[0].canTerastallize : null) || null,
        terastallized: Boolean(p.terastallized)
      };
    });

    this.state.p1.team = updatedTeam;
    this.state.p1.active = updatedTeam.find(p => p.active) || null;
  }

  private handleSwitch(slot: string, detailsStr: string, conditionStr: string): void {
    const details = this.parseDetails(detailsStr);
    const cond = this.parseCondition(conditionStr);

    if (this.isPlayerSlot(slot)) {
      // Mark existing active as inactive
      if (this.state.p1.active) {
        this.state.p1.active.active = false;
        this.state.p1.active.boosts = createInitialBoostTable();
      }

      // Find or create in team
      let mon = this.state.p1.team.find(p => p.species === details.species);
      if (!mon) {
        mon = {
          ident: slot,
          species: details.species,
          level: details.level,
          gender: details.gender,
          currentHp: cond.currentHp,
          maxHp: cond.maxHp,
          hpPercent: cond.maxHp > 0 ? Math.round((cond.currentHp / cond.maxHp) * 100) : 100,
          status: cond.status,
          types: [],
          item: null,
          ability: null,
          stats: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
          boosts: createInitialBoostTable(),
          moves: [],
          fainted: cond.fainted,
          active: true,
          teraType: null,
          terastallized: false
        };
        this.state.p1.team.push(mon);
      } else {
        mon.active = true;
        mon.currentHp = cond.currentHp;
        mon.maxHp = cond.maxHp;
        mon.hpPercent = cond.maxHp > 0 ? Math.round((cond.currentHp / cond.maxHp) * 100) : mon.hpPercent;
        mon.status = cond.status;
        mon.fainted = cond.fainted;
        mon.boosts = createInitialBoostTable();
      }
      this.state.p1.active = mon;
    } else if (this.isOpponentSlot(slot)) {
      if (this.state.p2.active) {
        this.state.p2.active.active = false;
        this.state.p2.active.boosts = createInitialBoostTable();
      }

      let mon = this.state.p2.team.find(p => p.species === details.species);
      if (!mon) {
        mon = {
          ident: slot,
          species: details.species,
          level: details.level,
          gender: details.gender,
          hpPercent: cond.hpPercent,
          status: cond.status,
          fainted: cond.fainted,
          active: true,
          revealedMoves: [],
          revealedAbility: null,
          revealedItem: null,
          teraType: null,
          terastallized: false,
          boosts: createInitialBoostTable()
        };
        this.state.p2.team.push(mon);
      } else {
        mon.active = true;
        mon.hpPercent = cond.hpPercent;
        mon.status = cond.status;
        mon.fainted = cond.fainted;
        mon.boosts = createInitialBoostTable();
      }
      this.state.p2.active = mon;
    }
  }

  private handleConditionUpdate(slot: string, conditionStr: string): void {
    const cond = this.parseCondition(conditionStr);

    if (this.isPlayerSlot(slot) && this.state.p1.active) {
      this.state.p1.active.currentHp = cond.currentHp;
      this.state.p1.active.maxHp = cond.maxHp;
      this.state.p1.active.hpPercent = cond.maxHp > 0 ? Math.round((cond.currentHp / cond.maxHp) * 100) : 0;
      this.state.p1.active.status = cond.status;
      if (cond.fainted) {
        this.state.p1.active.fainted = true;
      }
    } else if (this.isOpponentSlot(slot) && this.state.p2.active) {
      this.state.p2.active.hpPercent = cond.hpPercent;
      this.state.p2.active.status = cond.status;
      if (cond.fainted) {
        this.state.p2.active.fainted = true;
      }
    }
  }

  private handleFaint(slot: string): void {
    if (this.isPlayerSlot(slot) && this.state.p1.active) {
      this.state.p1.active.fainted = true;
      this.state.p1.active.currentHp = 0;
      this.state.p1.active.hpPercent = 0;
    } else if (this.isOpponentSlot(slot) && this.state.p2.active) {
      this.state.p2.active.fainted = true;
      this.state.p2.active.hpPercent = 0;
    }
  }

  private applyBoost(slot: string, stat: keyof BoostTable, amount: number): void {
    const active = this.isPlayerSlot(slot) ? this.state.p1.active : this.state.p2.active;
    if (active && stat in active.boosts) {
      active.boosts[stat] = Math.max(-6, Math.min(6, active.boosts[stat] + amount));
    }
  }

  private parseDetails(details: string): { species: string; level: number; gender: string } {
    const parts = details.split(',').map(p => p.trim());
    const species = parts[0] || 'Unknown';
    let level = 100;
    let gender = 'N';

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith('L')) {
        level = parseInt(part.slice(1), 10) || 100;
      } else if (part === 'M' || part === 'F') {
        gender = part;
      }
    }

    return { species, level, gender };
  }

  private parseCondition(condition: string): {
    currentHp: number;
    maxHp: number;
    hpPercent: number;
    status: string | null;
    fainted: boolean;
  } {
    if (!condition || condition === '0 fnt' || condition.endsWith(' fnt')) {
      return { currentHp: 0, maxHp: 100, hpPercent: 0, status: null, fainted: true };
    }

    const [hpPart, statusPart] = condition.split(' ');
    const status = statusPart || null;

    if (hpPart.includes('/')) {
      const [curr, max] = hpPart.split('/').map(v => parseInt(v, 10));
      return {
        currentHp: curr,
        maxHp: max,
        hpPercent: max > 0 ? Math.round((curr / max) * 100) : 0,
        status,
        fainted: curr === 0
      };
    } else {
      const hp = parseInt(hpPart, 10) || 0;
      return {
        currentHp: hp,
        maxHp: 100,
        hpPercent: hp,
        status,
        fainted: hp === 0
      };
    }
  }
}
