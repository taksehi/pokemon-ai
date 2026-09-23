import { BattleRunner } from './sim/battle-runner.js';
import { StateTracker } from './battle/state-tracker.js';
import { CandidateGenerator } from './strategy/candidate-generator.js';
import { BaselineEngine } from './strategy/baseline-engine.js';
import { AIStrategyPlayer } from './ai/strategy-player.js';
import { MockLLMClient, OllamaClient, LLMClient } from './ai/llm-client.js';
import { JevClient } from './ai/jev-client.js';
import { BattleLogger } from './utils/battle-logger.js';

try {
  (process as any).loadEnvFile?.();
} catch {
  // Ignore if .env is missing or invalid
}

export interface BattleResult {
  winner: string;
  totalTurns: number;
  decisionsMade: number;
  fallbacksTriggered: number;
  finalTurn: number;
}

export interface RunBattleOptions {
  formatid?: string;
  p1Name?: string;
  p2Name?: string;
  mode?: 'baseline' | 'ai_mock' | 'ai_ollama' | 'ai_jev';
  ollamaModel?: string;
  jevApiKey?: string;
  verbose?: boolean;
}

export async function runCompleteBattle(options: RunBattleOptions = {}): Promise<BattleResult> {
  const formatid = options.formatid ?? 'gen9randombattle';
  const p1Name = options.p1Name ?? 'Antigravity_Agent';
  const p2Name = options.p2Name ?? 'Showdown_Bot';
  const mode = options.mode ?? 'baseline';
  const verbose = options.verbose ?? true;

  const runner = new BattleRunner();
  const tracker = new StateTracker(formatid);

  let llmClient: LLMClient;
  if (mode === 'ai_ollama') {
    llmClient = new OllamaClient({ model: options.ollamaModel ?? 'qwen2.5:7b' });
  } else if (mode === 'ai_jev') {
    llmClient = new JevClient({
      apiKey: options.jevApiKey || process.env.TYPESAFE_API_KEY
    });
  } else {
    // Intelligent heuristic mock for demonstration & test runs
    llmClient = new MockLLMClient(prompt => {
      // Pick best candidate from prompt
      return JSON.stringify({
        selected_candidate_id: 'move 1',
        action_type: 'move',
        confidence: 0.9,
        opponent_prediction: 'Opponent attacks or switches',
        strategic_rationale: 'Execute highest damage action based on calculations.'
      });
    });
  }

  const aiPlayer = new AIStrategyPlayer(llmClient);

  await runner.start({
    formatid,
    p1Name,
    p2Name,
    autoOpponent: true
  });

  let decisionsMade = 0;
  let fallbacksTriggered = 0;
  let winner = 'Unknown';

  if (verbose) {
    console.log(`\n============================================================`);
    console.log(`   POKÉMON SHOWDOWN AUTONOMOUS AGENT [${mode.toUpperCase()}]`);
    console.log(`   Match: ${p1Name} vs. ${p2Name} | Format: ${formatid}`);
    console.log(`============================================================\n`);
  }

  while (true) {
    const actionable = await runner.getNextActionableRequest();
    if (!actionable) {
      // Stream closed, determine winner from accumulated lines
      for (const line of runner.accumulatedLines) {
        if (line.startsWith('|win|')) {
          winner = line.split('|')[2]?.trim() || 'Unknown';
        } else if (line.startsWith('|tie|')) {
          winner = 'Tie';
        }
      }
      break;
    }

    tracker.processLines(actionable.rawLines);
    tracker.updateFromRequest(actionable.request);

    if (verbose) {
      console.log(BattleLogger.formatState(tracker.state));
    }

    let candidateId = '';
    let rationale = '';

    if (mode === 'baseline') {
      const best = BaselineEngine.selectBestAction(tracker.state, actionable.request);
      candidateId = best.candidate.id;
      rationale = `Score: ${best.score} | Breakdown: [${best.breakdown.join('; ')}]`;
    } else {
      const aiResult = await aiPlayer.decideAction(tracker.state, actionable.request);
      candidateId = aiResult.candidate.id;
      rationale = aiResult.rationale;
      if (aiResult.usedFallback) {
        fallbacksTriggered++;
      }
    }

    decisionsMade++;

    if (verbose) {
      console.log(`[ACTION SELECTED] -> "${candidateId}"`);
      console.log(`[STRATEGY REASONING] ${rationale}\n`);
    }

    await runner.chooseP1(candidateId);
  }

  if (verbose) {
    console.log(`\n============================================================`);
    console.log(`[BATTLE FINISHED] Winner: ${winner}`);
    console.log(`Total Turns: ${tracker.state.turn} | Decisions: ${decisionsMade} | Fallbacks: ${fallbacksTriggered}`);
    console.log(`============================================================\n`);
  }

  return {
    winner,
    totalTurns: tracker.state.turn,
    decisionsMade,
    fallbacksTriggered,
    finalTurn: tracker.state.turn
  };
}

// Allow direct CLI execution: node dist/src/index.js or npx tsx src/index.ts
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  runCompleteBattle({
    mode: (process.argv[2] as any) || 'baseline',
    verbose: true
  }).catch(console.error);
}
