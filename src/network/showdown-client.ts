import { StateTracker } from '../battle/state-tracker.js';
import { CandidateGenerator } from '../strategy/candidate-generator.js';
import { BaselineEngine } from '../strategy/baseline-engine.js';
import { AIStrategyPlayer } from '../ai/strategy-player.js';
import { LLMClient, MockLLMClient } from '../ai/llm-client.js';
import { BattleLogger } from '../utils/battle-logger.js';
import { RequestPayload } from '../sim/battle-runner.js';

export interface ShowdownClientConfig {
  serverUrl?: string; // default: wss://sim3.psim.us/showdown/websocket
  username: string;
  password?: string;
  avatar?: string;
  autoAcceptChallenges?: boolean;
  targetOpponent?: string;
  format?: string;
  searchLadder?: boolean;
  llmClient?: LLMClient;
}

export class ShowdownClient {
  private ws: WebSocket | null = null;
  private config: ShowdownClientConfig;
  private trackerMap = new Map<string, StateTracker>();
  private aiPlayer: AIStrategyPlayer;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private currentRoomId: string = '';
  public onBattleEnd?: (winner: string) => void;

  constructor(config: ShowdownClientConfig) {
    this.config = {
      serverUrl: config.serverUrl || 'wss://sim3.psim.us/showdown/websocket',
      format: config.format || 'gen9randombattle',
      autoAcceptChallenges: config.autoAcceptChallenges ?? true,
      ...config
    };

    const llm = config.llmClient || new MockLLMClient(() => JSON.stringify({
      selected_candidate_id: 'move 1',
      action_type: 'move',
      confidence: 0.9,
      opponent_prediction: 'Opponent attacks',
      strategic_rationale: 'Default offensive pressure'
    }));

    this.aiPlayer = new AIStrategyPlayer(llm);
  }

  /**
   * Connects to the Pokémon Showdown WebSocket server.
   */
  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[NETWORK] Connecting to ${this.config.serverUrl}...`);
      this.ws = new WebSocket(this.config.serverUrl!);

      this.ws.onopen = () => {
        console.log(`[NETWORK] Connected to Showdown server.`);
        // Send keep-alive every 20 seconds to maintain persistent connection
        this.heartbeatInterval = setInterval(() => {
          this.send('|/cmd rooms');
        }, 20000);
        resolve();
      };

      this.ws.onerror = err => {
        console.error(`[NETWORK ERROR]`, err);
        reject(err);
      };

      this.ws.onmessage = event => {
        try {
          this.handleMessage(event.data.toString());
        } catch (err) {
          console.error(`[MESSAGE ERROR]`, err);
        }
      };

      this.ws.onclose = () => {
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        console.log(`[NETWORK] Disconnected from server.`);
      };
    });
  }

  /**
   * Disconnects from the server and cleans up timers.
   */
  public disconnect(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Dispatches incoming raw server messages.
   */
  private handleMessage(raw: string): void {
    const lines = raw.split('\n');
    let roomId = '';

    for (const line of lines) {
      if (line.startsWith('>')) {
        roomId = line.slice(1).trim();
        this.currentRoomId = roomId;
        continue;
      }

      const parts = line.split('|');
      const cmd = parts[1];

      switch (cmd) {
        case 'challstr': {
          // |challstr|<id>|<challenge>
          const challstr = parts.slice(2).join('|');
          this.login(challstr);
          break;
        }

        case 'updateuser': {
          const name = parts[2];
          const isNamed = parts[3] === '1';
          if (isNamed) {
            console.log(`[AUTH] Logged in successfully as: "${name.trim()}"`);
            if (this.config.avatar) {
              this.send(`|/avatar ${this.config.avatar}`);
            }

            console.log(`\n------------------------------------------------------------`);
            console.log(`[READY] Bot is LIVE on Pokémon Showdown!`);
            console.log(`        Username: ${name.trim()}`);
            console.log(`        Format:   ${this.config.format}`);
            console.log(``);
            console.log(`TO PLAY AGAINST THIS BOT:`);
            console.log(`1. Open https://play.pokemonshowdown.com in your web browser.`);
            console.log(`2. Click "Find a user" on the right sidebar.`);
            console.log(`3. Search for: "${name.trim()}"`);
            console.log(`4. Click "Challenge" -> select "${this.config.format || '[Gen 9] Random Battle'}".`);
            console.log(`5. The bot will automatically accept your challenge and play!`);
            console.log(`------------------------------------------------------------\n`);

            if (this.config.searchLadder) {
              console.log(`[LADDER] Searching for a live match on Showdown ladder in "${this.config.format}"...`);
              this.send(`|/search ${this.config.format}`);
            } else if (this.config.targetOpponent) {
              console.log(`[CHALLENGE] Challenging "${this.config.targetOpponent}"...`);
              this.send(`|/challenge ${this.config.targetOpponent}, ${this.config.format}`);
            }
          }
          break;
        }

        case 'popup': {
          const popupMsg = parts.slice(2).join('|');
          console.warn(`\n[SHOWDOWN POPUP]\n${popupMsg}\n`);
          break;
        }

        case 'pm': {
          const sender = parts[2];
          const receiver = parts[3];
          const message = parts.slice(4).join('|');
          if (message.startsWith('/error')) {
            const errorText = message.replace('/error ', '');
            console.error(`\n[SHOWDOWN CHALLENGE ERROR] ${errorText}`);
            if (errorText.toLowerCase().includes('spam') || errorText.toLowerCase().includes('registered')) {
              console.log(`\n------------------------------------------------------------`);
              console.log(`[ACTION REQUIRED TO PLAY LIVE]`);
              console.log(`Showdown's anti-spam filter blocks guest/unregistered accounts from`);
              console.log(`initiating outgoing challenges from this network.`);
              console.log(``);
              console.log(`TWO EASY WAYS TO PLAY:`);
              console.log(`1. CHALLENGE FROM BROWSER (RECOMMENDED):`);
              console.log(`   - Open https://play.pokemonshowdown.com in your browser.`);
              console.log(`   - Log in as your player account (e.g. "${this.config.targetOpponent || 'taksehi'}").`);
              console.log(`   - Click "Find a user" -> Search "${this.config.username.trim()}".`);
              console.log(`   - Click "Challenge" -> Select "${this.config.format || '[Gen 9] Random Battle'}".`);
              console.log(`   - This bot will AUTOMATICALLY ACCEPT your challenge and battle you!`);
              console.log(``);
              console.log(`2. USE A REGISTERED ACCOUNT FOR THE BOT:`);
              console.log(`   - Pass your bot's password via environment variable:`);
              console.log(`     SHOWDOWN_PASSWORD="your_password" npm run live ${this.config.username} ${this.config.targetOpponent || ''}`);
              console.log(`------------------------------------------------------------\n`);
            }
          } else {
            console.log(`[PM] [${sender} -> ${receiver}]: ${message}`);
          }
          break;
        }

        case 'nametaken': {
          const takenName = parts[2];
          const reason = parts[3] || 'Name already taken or password required';
          console.warn(`[AUTH WARNING] "${takenName}": ${reason}`);
          break;
        }

        case 'error': {
          console.error(`[SERVER ERROR] ${parts.slice(2).join('|')}`);
          break;
        }

        case 'updatechallenges': {
          try {
            const challenges = JSON.parse(parts[2]);
            if (challenges.challengesFrom) {
              for (const [challenger, format] of Object.entries(challenges.challengesFrom)) {
                console.log(`[CHALLENGE RECEIVED] Incoming challenge from "${challenger}" (${format})`);
                if (this.config.autoAcceptChallenges) {
                  console.log(`[CHALLENGE ACCEPTED] Accepting challenge from "${challenger}"...`);
                  this.send(`|/accept ${challenger}`);
                }
              }
            }
            if (challenges.challengeTo) {
              console.log(`[CHALLENGE PENDING] Sent challenge to "${challenges.challengeTo.to}" (${challenges.challengeTo.format}), awaiting response...`);
            }
          } catch {}
          break;
        }

        case 'init': {
          if (parts[2] === 'battle') {
            console.log(`\n============================================================`);
            console.log(`[BATTLE INIT] Joined battle room: ${roomId}`);
            console.log(`============================================================\n`);
            this.trackerMap.set(roomId, new StateTracker(this.config.format || 'gen9randombattle'));
          }
          break;
        }

        case 'request': {
          const jsonStr = parts.slice(2).join('|').trim();
          if (jsonStr && roomId) {
            this.handleBattleRequest(roomId, jsonStr);
          }
          break;
        }

        case 'win':
        case 'tie': {
          if (roomId) {
            const winner = parts[2] || 'Tie';
            console.log(`\n============================================================`);
            console.log(`[BATTLE END] Room: ${roomId} | Winner: ${winner}`);
            console.log(`============================================================\n`);
            this.send(`${roomId}|gg`);
            this.send(`|/leave ${roomId}`);
            this.trackerMap.delete(roomId);
            if (this.onBattleEnd) {
              this.onBattleEnd(winner);
            }
          }
          break;
        }

        default: {
          // Process battle-specific combat lines
          if (roomId && this.trackerMap.has(roomId)) {
            const tracker = this.trackerMap.get(roomId)!;
            tracker.processLine(line);
          }
          break;
        }
      }
    }
  }

  /**
   * Authenticates against Showdown's action.php.
   */
  private async login(challstr: string): Promise<void> {
    const url = 'https://play.pokemonshowdown.com/action.php';

    console.log(`[AUTH] Authenticating user "${this.config.username}"...`);

    try {
      if (this.config.password) {
        // Registered account authentication flow
        const body = new URLSearchParams({
          act: 'login',
          name: this.config.username,
          pass: this.config.password,
          challstr
        });

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });

        const text = await res.text();
        const cleanJson = text.startsWith(']') ? text.slice(text.indexOf('{')) : text;
        const data = JSON.parse(cleanJson);

        if (data.actionsuccess && data.assertion) {
          this.send(`|/trn ${this.config.username},0,${data.assertion}`);
        } else {
          console.error('[AUTH FAILED] Registered login error:', data);
        }
      } else {
        // Unregistered / Guest account flow (act=getassertion)
        const userid = this.config.username.toLowerCase().replace(/[^a-z0-9]/g, '');
        const body = new URLSearchParams({
          act: 'getassertion',
          userid,
          challstr
        });

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });

        const assertion = (await res.text()).trim();
        if (assertion && !assertion.startsWith(';')) {
          this.send(`|/trn ${this.config.username},0,${assertion}`);
        } else {
          console.error('[AUTH FAILED] Guest assertion error:', assertion);
        }
      }
    } catch (err) {
      console.error('[AUTH ERROR]', err);
    }
  }

  /**
   * Evaluates state and submits a /choose action for an active battle room.
   */
  private async handleBattleRequest(roomId: string, jsonStr: string): Promise<void> {
    try {
      const request: RequestPayload = JSON.parse(jsonStr);
      if (request.wait) {
        return; // Waiting for opponent
      }

      let tracker = this.trackerMap.get(roomId);
      if (!tracker) {
        tracker = new StateTracker(this.config.format || 'gen9randombattle');
        this.trackerMap.set(roomId, tracker);
      }

      tracker.updateFromRequest(request);

      console.log(BattleLogger.formatState(tracker.state));

      // Decide action via AIStrategyPlayer (with deterministic fallback)
      const decision = await this.aiPlayer.decideAction(tracker.state, request);

      console.log(`[ACTION] Room: ${roomId} -> "${decision.candidate.id}" (rqid: ${request.rqid})`);
      console.log(`[RATIONALE] ${decision.rationale}\n`);

      // Transmit to room: <roomId>|/choose <action>|<rqid>
      const rqidToken = request.rqid !== undefined ? `|${request.rqid}` : '';
      this.send(`${roomId}|/choose ${decision.candidate.id}${rqidToken}`);
    } catch (err) {
      console.error(`[REQUEST HANDLER ERROR] Room ${roomId}:`, err);
    }
  }

  /**
   * Sends raw wire protocol frame.
   */
  public send(msg: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    }
  }
}
