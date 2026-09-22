import { runCompleteBattle } from './index.js';

async function main() {
  console.log('====================================================');
  console.log('   FULL END-TO-END VERIFICATION: 3 MODES TO FINISH   ');
  console.log('====================================================\n');

  console.log('[RUN 1/3] Running Full Match with BASELINE ENGINE...');
  const res1 = await runCompleteBattle({ mode: 'baseline', verbose: false });
  console.log(`-> Winner: ${res1.winner} | Turns: ${res1.totalTurns} | Decisions: ${res1.decisionsMade} | Fallbacks: ${res1.fallbacksTriggered}\n`);

  console.log('[RUN 2/3] Running Full Match with AI STRATEGY PLAYER (Mock LLM + Zod Schema Validation)...');
  const res2 = await runCompleteBattle({ mode: 'ai_mock', verbose: false });
  console.log(`-> Winner: ${res2.winner} | Turns: ${res2.totalTurns} | Decisions: ${res2.decisionsMade} | Fallbacks: ${res2.fallbacksTriggered}\n`);

  console.log('[RUN 3/3] Running Full Match with TYPESAFE JEV SYSTEM ONE CLIENT...');
  const res3 = await runCompleteBattle({ mode: 'ai_jev', verbose: false });
  console.log(`-> Winner: ${res3.winner} | Turns: ${res3.totalTurns} | Decisions: ${res3.decisionsMade} | Fallbacks: ${res3.fallbacksTriggered}\n`);

  console.log('====================================================');
  console.log('   VERIFICATION COMPLETE: ALL 3 BATTLES FINISHED!    ');
  console.log('====================================================');
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
