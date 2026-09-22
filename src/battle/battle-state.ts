export interface StatTable {
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface BoostTable {
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
  accuracy: number;
  evasion: number;
}

export interface PlayerPokemon {
  ident: string;
  species: string;
  level: number;
  gender: string;
  currentHp: number;
  maxHp: number;
  hpPercent: number;
  status: string | null;
  types: string[];
  item: string | null;
  ability: string | null;
  stats: StatTable;
  boosts: BoostTable;
  moves: Array<{
    id: string;
    name: string;
    pp: number;
    maxpp: number;
    disabled: boolean;
  }>;
  fainted: boolean;
  active: boolean;
  teraType: string | null;
  terastallized: boolean;
}

export interface OpponentPokemon {
  ident: string;
  species: string;
  level: number;
  gender: string;
  hpPercent: number;
  status: string | null;
  fainted: boolean;
  active: boolean;
  revealedMoves: string[];
  revealedAbility: string | null;
  revealedItem: string | null;
  teraType: string | null;
  terastallized: boolean;
  boosts: BoostTable;
}

export interface HazardState {
  stealthRock: boolean;
  spikes: number;
  toxicSpikes: number;
  stickyWeb: boolean;
}

export interface FieldState {
  weather: string | null;
  weatherTurnsRemaining: number | null;
  terrain: string | null;
  terrainTurnsRemaining: number | null;
  p1Hazards: HazardState;
  p2Hazards: HazardState;
}

export interface BattleState {
  turn: number;
  format: string;
  field: FieldState;
  p1: {
    name: string;
    active: PlayerPokemon | null;
    team: PlayerPokemon[];
  };
  p2: {
    name: string;
    active: OpponentPokemon | null;
    team: OpponentPokemon[];
  };
}

export function createInitialBoostTable(): BoostTable {
  return {
    atk: 0,
    def: 0,
    spa: 0,
    spd: 0,
    spe: 0,
    accuracy: 0,
    evasion: 0
  };
}

export function createInitialHazardState(): HazardState {
  return {
    stealthRock: false,
    spikes: 0,
    toxicSpikes: 0,
    stickyWeb: false
  };
}

export function createInitialBattleState(format: string = 'gen9randombattle'): BattleState {
  return {
    turn: 1,
    format,
    field: {
      weather: null,
      weatherTurnsRemaining: null,
      terrain: null,
      terrainTurnsRemaining: null,
      p1Hazards: createInitialHazardState(),
      p2Hazards: createInitialHazardState()
    },
    p1: {
      name: 'Player 1',
      active: null,
      team: []
    },
    p2: {
      name: 'Player 2',
      active: null,
      team: []
    }
  };
}
