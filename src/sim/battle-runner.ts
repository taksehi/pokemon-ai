import { BattleStreams, Teams } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';

// Ensure random team generator factory is available for random formats
Teams.setGeneratorFactory(TeamGenerators);

export interface PokemonMoveInfo {
  move: string;
  id: string;
  pp: number;
  maxpp: number;
  target: string;
  disabled: boolean;
}

export interface PokemonSideItem {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  stats: {
    atk: number;
    def: number;
    spa: number;
    spd: number;
    spe: number;
  };
  moves: string[];
  baseAbility: string;
  item: string;
  pokeball: string;
  ability?: string;
  commanding?: boolean;
  reviving?: boolean;
  teraType?: string;
  terastallized?: string;
}

export interface RequestPayload {
  rqid?: number;
  active?: Array<{
    moves: PokemonMoveInfo[];
    canTerastallize?: string;
    trapped?: boolean;
    maybeTrapped?: boolean;
  }>;
  side: {
    name: string;
    id: string;
    pokemon: PokemonSideItem[];
  };
  forceSwitch?: boolean[];
  wait?: boolean;
}

export interface TurnEventLog {
  turn: number;
  lines: string[];
}

export class BattleRunner {
  private streams: ReturnType<typeof BattleStreams.getPlayerStreams>;
  private battleStream: BattleStreams.BattleStream;
  private p1Iterator: AsyncIterator<string> | null = null;
  public accumulatedLines: string[] = [];
  public currentRqid: number = 0;
  public lastRequest: RequestPayload | null = null;
  public lastError: string | null = null;
  public errorCount: number = 0;

  constructor() {
    this.battleStream = new BattleStreams.BattleStream();
    this.streams = BattleStreams.getPlayerStreams(this.battleStream);
  }

  /**
   * Starts a local in-memory battle with given format and player options.
   */
  public async start(options: {
    formatid?: string;
    p1Name?: string;
    p2Name?: string;
    p1Team?: string;
    p2Team?: string;
    seed?: [number, number, number, number];
    autoOpponent?: boolean;
    p2Controller?: (req: RequestPayload, rawLines: string[]) => Promise<string> | string;
  } = {}): Promise<void> {
    const formatid = options.formatid ?? 'gen9randombattle';
    const p1Name = options.p1Name ?? 'Alice_AI';
    const p2Name = options.p2Name ?? 'Bob_Opponent';

    const p1Spec: { name: string; team?: string } = { name: p1Name };
    if (options.p1Team) {
      p1Spec.team = options.p1Team;
    } else if (options.seed) {
      const g1 = TeamGenerators.getTeamGenerator(formatid, options.seed as any);
      p1Spec.team = Teams.pack(g1.getTeam());
    }

    const p2Spec: { name: string; team?: string } = { name: p2Name };
    if (options.p2Team) {
      p2Spec.team = options.p2Team;
    } else if (options.seed) {
      const revSeed: [number, number, number, number] = [
        options.seed[3],
        options.seed[2],
        options.seed[1],
        options.seed[0]
      ];
      const g2 = TeamGenerators.getTeamGenerator(formatid, revSeed as any);
      p2Spec.team = Teams.pack(g2.getTeam());
    }

    const startCommands = [
      `>start ${JSON.stringify({ formatid, seed: options.seed })}`,
      `>player p1 ${JSON.stringify(p1Spec)}`,
      `>player p2 ${JSON.stringify(p2Spec)}`
    ].join('\n') + '\n';

    await this.streams.omniscient.write(startCommands);
    this.p1Iterator = this.streams.p1[Symbol.asyncIterator]();

    if (options.p2Controller) {
      (async () => {
        try {
          const p2Lines: string[] = [];
          for await (const chunk of this.streams.p2) {
            for (const line of chunk.split('\n')) {
              if (line.trim()) p2Lines.push(line);
              if (line.startsWith('|request|')) {
                const jsonStr = line.slice('|request|'.length).trim();
                if (jsonStr) {
                  const req = JSON.parse(jsonStr);
                  if (!req.wait && (req.active || req.forceSwitch)) {
                    const action = await options.p2Controller!(req, [...p2Lines]);
                    p2Lines.length = 0;
                    await this.streams.p2.write(action);
                  }
                }
              }
            }
          }
        } catch {
          // Stream completed or closed
        }
      })();
    } else if (options.autoOpponent) {
      (async () => {
        try {
          for await (const chunk of this.streams.p2) {
            for (const line of chunk.split('\n')) {
              if (line.startsWith('|request|')) {
                const jsonStr = line.slice('|request|'.length).trim();
                if (jsonStr) {
                  const req = JSON.parse(jsonStr);
                  if (!req.wait) {
                    await this.streams.p2.write('default');
                  }
                }
              }
            }
          }
        } catch {
          // Stream completed or closed
        }
      })();
    }
  }

  /**
   * Reads from P1's stream until an actionable request (wait !== true) is found,
   * or returns null if the battle ends.
   */
  public async getNextActionableRequest(): Promise<{
    request: RequestPayload;
    rawLines: string[];
  } | null> {
    if (!this.p1Iterator) {
      throw new Error('BattleRunner must be started before reading requests');
    }

    const turnLines: string[] = [];

    while (true) {
      const { value, done } = await this.p1Iterator.next();
      if (done || !value) {
        return null;
      }

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        turnLines.push(line);
        this.accumulatedLines.push(line);

        if (line.startsWith('|error|')) {
          this.lastError = line;
          this.errorCount++;
        }

        if (line.startsWith('|request|')) {
          const jsonStr = line.slice('|request|'.length).trim();
          if (jsonStr) {
            try {
              const parsed: RequestPayload = JSON.parse(jsonStr);
              this.lastRequest = parsed;
              if (parsed.rqid !== undefined) {
                this.currentRqid = parsed.rqid;
              }

              // If it's an actionable request (not waiting for opponent)
              if (!parsed.wait && (parsed.active || parsed.forceSwitch)) {
                return {
                  request: parsed,
                  rawLines: turnLines
                };
              }
            } catch (err) {
              console.error('Error parsing |request| JSON:', err, 'Raw:', jsonStr);
            }
          }
        }

        if (line.startsWith('|win|') || line.startsWith('|tie|')) {
          // Battle completed
          return null;
        }
      }
    }
  }

  /**
   * Submits an action for Player 1.
   * Format example: 'move 1', 'move 2 terastallize', 'switch 3'
   */
  public async chooseP1(choice: string): Promise<void> {
    const cmd = choice.startsWith('choose ') ? choice.slice(7) : choice;
    await this.streams.p1.write(cmd);
  }

  /**
   * Submits an action for Player 2 (e.g. for scripted opponents).
   */
  public async chooseP2(choice: string): Promise<void> {
    const cmd = choice.startsWith('choose ') ? choice.slice(7) : choice;
    await this.streams.p2.write(cmd);
  }

  /**
   * Destroys and cleans up streams and internal state.
   */
  public destroy(): void {
    try {
      this.p1Iterator = null;
      (this.streams.p1 as any).destroy?.();
      (this.streams.p2 as any).destroy?.();
      (this.streams.omniscient as any).destroy?.();
      this.accumulatedLines = [];
      this.lastRequest = null;
    } catch {}
  }
}

