import { spawn } from 'node:child_process';
import path from 'node:path';

async function runLiveBattleLoop(): Promise<void> {
  let matchCount = 0;
  let isStopping = false;

  console.log(`============================================================`);
  console.log(`   POKÉMON SHOWDOWN CONTINUOUS LIVE LADDER LOOP DRIVER       `);
  console.log(`   Policy: Play 1 match -> Exit -> Clean restart -> Next match`);
  console.log(`   Press Ctrl+C at any time to stop after current match.`);
  console.log(`============================================================\n`);

  process.on('SIGINT', () => {
    console.log('\n[LIVE LOOP] Intercepted Ctrl+C. Stopping loop after current process finishes...');
    isStopping = true;
  });

  while (!isStopping) {
    matchCount++;
    console.log(`\n------------------------------------------------------------`);
    console.log(`>>> QUEUING LIVE MATCH #${matchCount}...`);
    console.log(`------------------------------------------------------------\n`);

    await new Promise<void>((resolve) => {
      const child = spawn(
        'npx',
        ['tsx', path.resolve(process.cwd(), 'src', 'connect-live.ts'), '--ladder', '--exit-on-finish', ...process.argv.slice(2)],
        {
          stdio: 'inherit',
          shell: true,
          env: {
            ...process.env,
            SHOWDOWN_LADDER: 'true',
            SHOWDOWN_EXIT_ON_FINISH: 'true'
          }
        }
      );

      child.on('close', (code) => {
        console.log(`\n[LIVE LOOP] Match #${matchCount} process exited cleanly (code ${code}).`);
        resolve();
      });

      child.on('error', (err) => {
        console.error(`[LIVE LOOP ERROR] Match #${matchCount} encountered spawn error:`, err);
        resolve();
      });
    });

    if (isStopping) break;

    console.log(`[LIVE LOOP] Cool-down delay (4 seconds) before next match...`);
    await new Promise(r => setTimeout(r, 4000));
  }

  console.log(`\n============================================================`);
  console.log(`   LIVE LADDER LOOP STOPPED. Total matches attempted: ${matchCount}`);
  console.log(`============================================================\n`);
}

runLiveBattleLoop().catch(err => {
  console.error('Fatal live loop error:', err);
  process.exit(1);
});
