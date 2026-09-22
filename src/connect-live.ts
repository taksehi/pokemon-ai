import { ShowdownClient } from './network/showdown-client.js';
import { JevClient } from './ai/jev-client.js';
import { OllamaClient } from './ai/llm-client.js';

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

process.on('unhandledRejection', reason => {
  console.error('[UNHANDLED REJECTION]', reason);
});

async function main() {
  const username = process.env.SHOWDOWN_USERNAME || process.argv[2] || `AI_Bot_${Math.floor(Math.random() * 10000)}`;
  const password = process.env.SHOWDOWN_PASSWORD || '';
  const isLadder = process.argv.includes('--ladder') || process.env.SHOWDOWN_LADDER === 'true';
  const exitOnFinish = process.argv.includes('--exit-on-finish') || process.env.SHOWDOWN_EXIT_ON_FINISH === 'true';
  const targetOpponent = isLadder ? undefined : (process.env.SHOWDOWN_OPPONENT || (process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined));
  const format = process.env.SHOWDOWN_FORMAT || 'gen9randombattle';
  const serverUrl = process.env.SHOWDOWN_SERVER || 'wss://sim3.psim.us/showdown/websocket';
  const mode = process.env.AI_MODE || 'baseline';

  let llmClient;
  if (mode === 'jev') {
    console.log('[AI] Utilizing TypeSafe Jev System One Client');
    llmClient = new JevClient();
  } else if (mode === 'ollama') {
    console.log('[AI] Utilizing Local Ollama Client (Qwen 2.5 7B)');
    llmClient = new OllamaClient();
  }

  console.log(`\n============================================================`);
  console.log(`   POKÉMON SHOWDOWN LIVE NETWORK DRIVER`);
  console.log(`   Username: ${username}`);
  console.log(`   Server:   ${serverUrl}`);
  console.log(`   Format:   ${format}`);
  console.log(`   AI Mode:  ${mode.toUpperCase()}`);
  if (password) {
    console.log(`   Account:  Registered (Authenticated with password)`);
  } else {
    console.log(`   Account:  Guest (Unregistered)`);
  }
  if (isLadder) {
    console.log(`   Mode:     Public Ladder Matchmaking`);
  } else if (targetOpponent) {
    console.log(`   Target:   Challenging "${targetOpponent}" upon login`);
  } else {
    console.log(`   Mode:     Listening for incoming challenges`);
  }
  console.log(`============================================================\n`);

  const client = new ShowdownClient({
    username,
    password,
    serverUrl,
    format,
    targetOpponent,
    searchLadder: isLadder,
    autoAcceptChallenges: true,
    llmClient
  });

  if (exitOnFinish) {
    client.onBattleEnd = winner => {
      console.log(`\n[COMPLETE] Live battle finished! Winner: ${winner}`);
      console.log(`[SHUTDOWN] Exiting process cleanly.`);
      client.disconnect();
      process.exit(0);
    };
  }

  process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Terminating live bot session...');
    client.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[SHUTDOWN] Terminating live bot session...');
    client.disconnect();
    process.exit(0);
  });

  await client.connect();
}

main().catch(err => {
  console.error('[FATAL ERROR IN LIVE DRIVER]', err);
  process.exit(1);
});
