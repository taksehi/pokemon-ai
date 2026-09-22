# Engineering Development Loop Log

This document records each iteration of our engineering loop following the **Loop Engineering Method**:
`Plan → Build → Run → Observe → Test → Diagnose → Improve → Run Again`.

---

## Loop 1: In-Memory Headless Battle Simulation & Turn Detection

### ITERATION:
What were we trying to achieve?
* Initialize a headless Pokémon Showdown battle locally in-memory using `@pkmn/sim`.
* Intercept and parse protocol messages and extract the first actionable `|request|` JSON for Player 1.
* Progress from Turn 1 to Turn 2 by submitting an action.

### CHANGE:
What did we modify?
1. Initialized Node.js (v22 ESM) project with `@pkmn/sim`, `@pkmn/protocol`, `@smogon/calc`, `@pkmn/data`, `@pkmn/randoms`, and `vitest`.
2. Created `src/sim/battle-runner.ts` encapsulating `BattleStreams.BattleStream` and `BattleStreams.getPlayerStreams`.
3. Added automatic random team generator wiring (`Teams.setGeneratorFactory(TeamGenerators)`).
4. Added support for automated opponent responses (`autoOpponent: true`) and normalized action commands (`move 1`, `switch 2`, etc.).
5. Created automated test suite `tests/sim-runner.test.ts`.

### TEST:
How did we test it?
* Executed `npx vitest run tests/sim-runner.test.ts`.
* Verified that Player 1 receives non-empty active moves, 6 team Pokémon, and advances to Turn 2 upon action execution.

### OBSERVATION:
What actually happened?
1. Initial run failed with `getTeamGenerator maybe not be used unless a TeamGeneratorFactory has been set`.
2. Second run failed with `actual value must be number or bigint, received "undefined"` on `request.rqid`, and the turn-progression test timed out.
3. Third run (after diagnosis and fixes) passed 100% in 89ms.

### FAILURES & ROOT CAUSE:
Why did it happen?
* **Failure 1**: `@pkmn/sim` does not bundle the random team generator by default for random battle formats.
  * *Root Cause*: `@pkmn/randoms` package needed to be installed and registered with `Teams.setGeneratorFactory(TeamGenerators)`.
* **Failure 2**: `request.rqid` was undefined in the in-memory stream.
  * *Root Cause*: `rqid` is only attached by the network WebSocket server for concurrency control; the local in-memory stream omits `rqid`. `rqid` must be treated as optional (`rqid?: number`).
* **Failure 3**: Test timed out on Turn 2 progression.
  * *Root Cause*: `streams.p1.write` expects `'move 1'`, `'switch 2'`, or `'default'`, whereas `'choose move 1'` is rejected by `BattleStream` as an unrecognized choice. Furthermore, Player 2's stream must be read and responded to in order for the engine to advance the turn.

### RESULT:
Did the iteration succeed?
**YES (SUCCESS)**.
* 2/2 tests passing in 89ms.
* Battle starts in-memory, streams protocol events, extracts legal moves on Turn 1, and successfully advances turns.

### NEXT LOOP:
What should we build/test next?
Move to Loop 2: Battle State Extraction & Belief State Representation.

---

## Loop 2: Battle State Extraction & Belief State Representation

### ITERATION:
What were we trying to achieve?
* Ingest Showdown wire protocol events (`|switch|`, `|-damage|`, `|-heal|`, `|move|`, `|faint|`, `|-boost|`, `|-weather|`, `|-sidestart|`, `|-sideend|`, `|turn|`) alongside `|request|` JSON.
* Maintain a clean, structured `BattleState` separating Ground Truth (our side: exact stats, moves, PP, items), Observed/Belief (opponent side: approximate HP %, revealed moves/ability/item), and Field conditions (hazards, weather, terrain).
* Build instrumentation formatting for observability (`BattleLogger`).

### CHANGE:
What did we modify?
1. Created `src/battle/battle-state.ts` defining data structures for `PlayerPokemon`, `OpponentPokemon`, `HazardState`, `FieldState`, and `BattleState`.
2. Created `src/battle/state-tracker.ts` implementing `StateTracker` with robust condition string parsing (`231/231`, `42/100`, `0 fnt`), details parsing, boost tracking, and hazard handling.
3. Created `src/utils/battle-logger.ts` for clean human/diagnostic state formatting.
4. Created test suite `tests/state-tracker.test.ts` covering synthetic battle events and live multi-turn in-memory battles.

### TEST:
How did we test it?
* Executed `npx vitest run tests/state-tracker.test.ts`.
* Verified state accuracy across synthetic multi-turn combat, hazard setups, stat drops, and live in-memory battle progression.

### OBSERVATION:
What actually happened?
* All 4 tests across the test suite passed cleanly in 236ms.
* Both synthetic and live battle turns accurately updated HP, revealed moves, hazard tracking, and turn counters.

### FAILURES & ROOT CAUSE:
Why did it happen?
* None. The design anticipated percentage vs absolute HP formats, boost resetting on switch, and hazard increment bounds.

### RESULT:
Did the iteration succeed?
**YES (SUCCESS)**.
* 4/4 total tests passing.
* Accurate, real-time battle state tracking is fully operational.

### NEXT LOOP:
What should we build/test next?
Move to Loop 3: Candidate Action Generation & Deterministic Damage Evaluation.

---

## Loop 3: Candidate Action Generation & Deterministic Damage Evaluation

### ITERATION:
What were we trying to achieve?
* Extract all legal candidate actions (damaging moves, status moves, terastallize variants, bench switches) from `RequestPayload` and `BattleState`.
* Annotate each candidate with deterministic calculations using `@smogon/calc` and `@pkmn/sim` Dex:
  - Exact min/max damage roll percentages.
  - Knockout (KO) probability against opponent's current HP %.
  - Outspeed relationship (faster, slower, speed tie) taking stat stages and move priority into account.
  - Entry hazard damage percentage on switch-in based on typing vs Rock (Stealth Rock) and Spikes.
  - Switch-in safety categorization (safe, risky, fatal).
* Verify that actions are guaranteed legal and directly executable.

### CHANGE:
What did we modify?
1. Created `src/strategy/candidate-generator.ts` implementing `CandidateGenerator`.
2. Normalized item and ability IDs via `Dex.forGen(9)` to match `@smogon/calc` expectations (e.g. `'choicespecs'` -> `'Choice Specs'`).
3. Automated typing effectiveness calculations for Stealth Rock (accounting for 4x weaknesses like Volcarona and 0.5x resistances like Ting-Lu).
4. Supported terastallization candidate generation with elevated damage roll calculations.
5. Created test suite `tests/candidate-generator.test.ts` covering synthetic competitive matchups (Dragapult vs Gholdengo) and live in-memory battle execution.

### TEST:
How did we test it?
* Executed `npx vitest run tests/candidate-generator.test.ts` alongside all existing regression suites.
* Validated:
  - Shadow Ball min/max damage rolls and KO chance against Gholdengo at 70% HP.
  - Terastallized Shadow Ball damage boost.
  - Volcarona 50% Stealth Rock hazard penalty (4x weak).
  - Ting-Lu 6.3% Stealth Rock hazard penalty (0.5x resistance).
  - Live execution of highest damage candidates in in-memory battles.

### OBSERVATION:
What actually happened?
1. Initial test run failed with `expected 59 to be greater than 60` for Choice Specs Dragapult.
2. Second run failed with `expected 89.5 to be greater than 89.5` for Terastallize candidate.
3. Third run failed with `expected 6.3 to be 12.5` on Ting-Lu hazard damage.
4. Fourth run passed 100% (6/6 tests passing across all suites).

### FAILURES & ROOT CAUSE:
Why did it happen?
* **Failure 1**: Dragapult dealt unboosted damage (`186 - 222` instead of `282 - 332`).
  * *Root Cause*: `@smogon/calc` requires proper-cased item names (e.g. `'Choice Specs'`) while Showdown protocol emits lowercase IDs (`'choicespecs'`). Resolved by adding a normalization layer using `dexGen9.items.get(id)?.name`.
* **Failure 2**: Terastallize candidate did not apply STAB boost.
  * *Root Cause*: `p1Active.teraType` was not populated from `request.active[0].canTerastallize`. Resolved by syncing `teraType` in `StateTracker.updateFromRequest`.
* **Failure 3**: Ting-Lu hazard damage mismatch.
  * *Root Cause*: Test assumed 12.5% neutral hazard damage, but Ting-Lu is Dark/Ground (resisting Rock 0.5x), taking exactly 6.25% (~6.3%). The code was correct; updated test assertion.
* **Failure 4**: Intermittent Turn 2 assertion failure in `tests/state-tracker.test.ts`.
  * *Root Cause*: High damage on Turn 1 can cause a faint, producing an immediate `forceSwitch` request before `|turn|2`. Resolved by using `CandidateGenerator` to handle both normal turns and forced switches.

### RESULT:
Did the iteration succeed?
**YES (SUCCESS)**.
* 6/6 tests passing across 3 test files in 3.5s.
* High-precision deterministic candidate generation is verified and operational.

### NEXT LOOP:
What should we build/test next?
Move to Loop 4: Deterministic Baseline Engine (Rule Benchmark & Safety Guard).

---

## Loop 4: Deterministic Baseline Engine (Rule Benchmark & Safety Guard)

### ITERATION:
What were we trying to achieve?
* Build an algorithmic decision engine (`BaselineEngine`) that scores legal candidate actions using competitive heuristics (+damage, +KO chance bonus, +guaranteed outspeed KO bonus, +priority bonus, +hazard setup, -fatal switch penalty, -tempo loss).
* Provide two essential capabilities:
  1. A deterministic benchmark opponent for measuring AI strategic performance.
  2. A bulletproof deterministic safety fallback whenever an AI model times out or returns invalid output.
* Verify autonomous multi-turn play without human intervention or illegal choices.

### CHANGE:
What did we modify?
1. Created `src/strategy/baseline-engine.ts` implementing `BaselineEngine` with scoring heuristics and detailed decision breakdown logging.
2. Handled both standard turn choices and forced switches (`forceSwitch: [true]`) cleanly.
3. Created test suite `tests/baseline-engine.test.ts` verifying KO prioritization and autonomous 12-turn battle execution.

### TEST:
How did we test it?
* Executed `npx vitest run tests/baseline-engine.test.ts` alongside all existing regression suites.
* Verified:
  - Synthetic Dragapult vs Gholdengo chooses Shadow Ball with KO bonus score > 100.
  - Live in-memory battle executes 12 consecutive turns autonomously with zero illegal choices.

### OBSERVATION:
What actually happened?
* All 8 tests across 4 test suites passed cleanly in 4.29s.
* The baseline engine navigated normal turns, KOs, and forced replacements seamlessly.

### FAILURES & ROOT CAUSE:
Why did it happen?
* None. The engine built directly upon the verified abstractions of Loops 1, 2, and 3.

### RESULT:
Did the iteration succeed?
**YES (SUCCESS)**.
* 8/8 tests passing.
* Autonomous deterministic gameplay and safety fallback are fully verified.

### NEXT LOOP:
What should we build/test next?
Move to Loop 5: AI Strategic Reasoning Layer (Prompt Compiler + Zod Schema Validation + Safety Guard).

---

## Loop 5: AI Strategic Reasoning Layer (Prompt Compiler + Zod Schema Validation + Safety Guard)

### ITERATION:
What were we trying to achieve?
* Build `PromptCompiler` to compile the rich `BattleState` and evaluated candidate actions into a structured briefing for the LLM.
* Enforce a strict Zod schema (`DecisionSchema`) on AI responses (`selected_candidate_id`, `action_type`, `confidence`, `opponent_prediction`, `strategic_rationale`).
* Provide an abstract `LLMClient` interface with `MockLLMClient` and local `OllamaClient`.
* Implement `AIStrategyPlayer` with a hard deterministic safety guard: if the model times out, fails schema validation, or hallucinates an illegal candidate ID, it automatically falls back to `BaselineEngine` with an instrumented log message.

### CHANGE:
What did we modify?
1. Created `src/ai/decision-schema.ts` defining strict Zod schema.
2. Created `src/ai/prompt-compiler.ts` converting state and deterministic calculations into a clean markdown prompt.
3. Created `src/ai/llm-client.ts` defining `LLMClient`, `MockLLMClient`, and `OllamaClient`.
4. Created `src/ai/strategy-player.ts` implementing `AIStrategyPlayer` with JSON sanitization, timeout racing (`Promise.race`), candidate verification, and fallback delegation to `BaselineEngine`.
5. Created test suite `tests/strategy-player.test.ts` testing schema parsing, candidate hallucination protection, timeout enforcement, and multi-turn live battle execution.

### TEST:
How did we test it?
* Executed `npx vitest run tests/strategy-player.test.ts` alongside all existing regression suites.
* Validated:
  - Valid structured JSON maps cleanly to legal candidate actions.
  - Hallucinated candidate ID (`move 99`) is rejected and handled by fallback.
  - LLM delay exceeding timeout (50ms) triggers immediate fallback without hanging.
  - 5-turn live battle completes with AI decisions.

### OBSERVATION:
What actually happened?
* All 12 tests across 5 test suites passed cleanly in 5.31s.
* The system is completely resilient to AI timeouts, malformed JSON, and candidate hallucinations.

### FAILURES & ROOT CAUSE:
Why did it happen?
* None. The architecture cleanly isolated prompt compilation, validation, and safety fallbacks.

### RESULT:
Did the iteration succeed?
**YES (SUCCESS)**.
* 12/12 tests passing across 5 test files.
* AI strategic reasoning with deterministic safety fallback is fully verified.

### NEXT LOOP:
What should we build/test next?
Move to Loop 6: Autonomous Battle Runner & CLI Entry Point.

---

## Loop 6: Autonomous Battle Runner & CLI Entry Point

### ITERATION:
What were we trying to achieve?
* Connect the entire autonomous system end-to-end in `src/index.ts`:
  `Observe → State Update → Candidate Gen & Calc → Decision (AI / Baseline) → Action Execution → State Sync → Loop until Victory`.
* Support running complete matches in console with rich instrumentation logs (`npm start`).
* Support competitive benchmarking across full 10-50 turn battles.

### CHANGE:
What did we modify?
1. Created `src/index.ts` implementing `runCompleteBattle(options)` supporting `baseline`, `ai_mock`, and `ai_ollama` modes.
2. Added post-game analytical summaries (Winner, Total Turns, Decisions Made, Fallbacks Triggered).
3. Added `"start": "tsx src/index.ts"` in `package.json`.
4. Created test suite `tests/full-battle-loop.test.ts` verifying complete end-to-end games to conclusion.

### TEST:
How did we test it?
* Executed `npx vitest run tests/full-battle-loop.test.ts`.
* Ran full live interactive match via `npm start`.

### OBSERVATION:
What actually happened?
* All 14 tests across 6 test suites passed in 5.43s.
* The live `npm start` match ran 42 consecutive turns in under 3 seconds:
  - PP decreased accurately across repeated move choices (`crunch` from 20 down to 14).
  - Recognized opponent's revealed moves (`Substitute`, `Calm Mind`, `Rest`).
  - Drednaw systematically cleaned up opponent team and secured victory:
    `[BATTLE FINISHED] Winner: Antigravity_Agent | Total Turns: 42 | Decisions: 44 | Fallbacks: 0`.

### FAILURES & ROOT CAUSE:
Why did it happen?
* None. The system operated reliably across all 42 turns.

### RESULT:
Did the iteration succeed?
**YES (SUCCESS)**.
* Complete autonomous Pokémon Showdown playing system is operational and verified end-to-end.

### NEXT LOOP:
Move to Loop 7: TypeSafe AI Jev System One Integration.

---

## Loop 7: TypeSafe AI Jev System One Integration

### ITERATION:
What were we trying to achieve?
* Implement TypeSafe AI's **Jev System One** decision client for rapid, calibrated decision-making.
* Formulate native Jev primitives (`choice` for candidate selection, `boolean` for opponent switch prediction, `score` for win-condition preservation).
* Integrate `JevClient` with `AIStrategyPlayer` so that Jev decisions bypass natural-language token generation while maintaining full deterministic safety fallbacks.
* Add `ai_jev` mode to `src/index.ts` for full autonomous match play.

### CHANGE:
What did we modify?
1. Created `src/ai/jev-client.ts` implementing `JevClient` conforming to TypeSafe AI's `/v1/systemone` specification.
2. Extended `LLMClient` interface with optional `decide?(state, candidates)` method.
3. Enhanced `AIStrategyPlayer` in `src/ai/strategy-player.ts` to natively route to `llmClient.decide` with timeout protection.
4. Added `ai_jev` mode to `src/index.ts`.
5. Created test suite `tests/jev-client.test.ts` testing question formulation, decision mapping, network failure fallbacks, and live multi-turn play.

### TEST:
How did we test it?
* Executed `npx vitest run tests/jev-client.test.ts` alongside all existing regression suites.
* Verified:
  - Formulates native `choice`, `boolean`, and `score` questions.
  - Successfully maps Jev's calibrated probabilities to legal Pokémon actions.
  - Automatically delegates to `BaselineEngine` if the Jev endpoint encounters network errors (503/timeout).
  - Plays multi-turn live in-memory battles seamlessly.

### OBSERVATION:
What actually happened?
* All 18 tests across 7 test suites passed in 7.67s.
* The Jev System One integration bypassed token streaming latency and executed directly with 0 parsing errors.

### FAILURES & ROOT CAUSE:
Why did it happen?
* None. The clean interface abstractions in Loop 5 made plugging in Jev frictionless.

### RESULT:
Did the iteration succeed?
**YES (SUCCESS)**.
* 18/18 tests passing.
* TypeSafe AI Jev integration is verified and operational.

### NEXT LOOP:
* Deploy live WebSocket connection to a local or public Pokémon Showdown server (`showdown-client.ts`).






