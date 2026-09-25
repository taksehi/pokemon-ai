# Autonomous Pokémon Showdown AI Agent 🎮🤖

An autonomous game-playing AI system designed for **Pokémon Showdown**. Built using a continuous **Loop Engineering Method**, this agent pairs deterministic competitive mechanics (`@smogon/calc` and `@pkmn/sim`) with fast probabilistic and generative reasoning models.

Instead of asking an LLM to guess damage rolls or legal choices (which causes hallucinations), the system deterministically evaluates all legal moves and switches with exact damage formulas, KO probabilities, speed comparisons, and hazard calculations—then passes those evaluated options to an AI reasoning layer with bulletproof fallback safety guards.

---

## ⚡ Features & Architecture

```text
       ┌──────────────────────────────────────────────────┐
       │             POKÉMON SHOWDOWN BATTLE              │
       │   (Headless @pkmn/sim  OR  Live WebSocket Server) │
       └─────────────────────────┬────────────────────────┘
                                 │ Wire Protocol Events
                                 ▼
       ┌──────────────────────────────────────────────────┐
       │           STATE TRACKER (Belief State)           │
       │   - Known team & active moves                    │
       │   - Observed opponent moves, abilities, items    │
       │   - Auto-detects P1 vs P2 perspective            │
       │   - Tracks hazards, weather, boosts, status      │
       └─────────────────────────┬────────────────────────┘
                                 │ Synchronized State
                                 ▼
       ┌──────────────────────────────────────────────────┐
       │       CANDIDATE ACTION GENERATOR & CALC          │
       │   - Filters 100% legal moves & switches          │
       │   - @smogon/calc exact damage rolls & KO chance  │
       │   - Dynamic Multi-Gen Support (Gens 1 through 9) │
       │   - Speed relation & entry hazard penalties      │
       └─────────────────────────┬────────────────────────┘
                                 │ Evaluated Actions
                                 ▼
       ┌──────────────────────────────────────────────────┐
       │             STRATEGIC REASONING LAYER            │
       │   - Deterministic Baseline Heuristic Engine      │
       │   - TypeSafe AI Jev System One (Fast Typed ML)   │
       │   - Local LLMs (Ollama / Qwen 2.5 / Llama 3)     │
       │   - Safety Guard (catches timeouts/hallucinations)│
       └─────────────────────────┬────────────────────────┘
                                 │ Chosen Action (/choose)
                                 ▼
       ┌──────────────────────────────────────────────────┐
       │                ACTION EXECUTION                  │
       │   Transmits choice back to battle & repeats      │
       └──────────────────────────────────────────────────┘
```

### 1. Multi-Generational Engine (Gen 1 – Gen 9)
* **Gen 9 Random Battles / Standard**: Full Terastallization, modern abilities, items, and hazard mechanics.
* **Gen 2 (Gold / Silver / Crystal)**: Authentic retro GSC mechanics—no abilities, no Tera, Spikes max 1 layer (12.5%), and Gen 2 damage formulas and stats (Snorlax, Zapdos, Raikou, Skarmory).

### 2. Triple Reasoning Modes
* **Baseline Engine**: High-performance heuristic ruleset (+KO bonus, +speed KO, recovery at low HP, hazard setup/clear, cripple status, safe pivot).
* **TypeSafe AI Jev System One**: Fast, typed decision model using native `choice`, `boolean`, and `score` primitives for sub-30ms probabilistic reasoning.
* **Local Chat LLMs (Ollama)**: Structured reasoning prompts parsed with strict Zod validation.

### 3. Bulletproof Safety Fallbacks
If an AI model times out or hallucinates an illegal candidate (e.g. attempting to attack during a forced switch), the safety guard catches it and safely delegates to the highest-scoring legal baseline move with zero lost turns.

---

## 🚀 Quick Start

### Prerequisites
* Node.js v20+
* npm

### Install Dependencies
```bash
npm install
```

### Run All Automated Tests
```bash
npm test
```
*Runs 21 comprehensive test suites covering simulation, damage calculations, state tracking, Jev integration, baseline heuristics, and full battles to conclusion.*

---

## 🕹️ Playing Battles

### 1. In-Memory Simulated Matches (Headless)
Run a full autonomous battle from Turn 1 to victory in ~2 seconds:
```bash
npm start
```
Run all 3 decision modes sequentially:
```bash
npx tsx src/run-verification.ts
```

---

### 2. Live on Pokémon Showdown Server

#### Option A: Challenge the Bot from your Web Browser (Recommended)
1. Launch the bot in listening mode:
   ```bash
   # Gen 9 Random Battles (Default)
   npm run live AIBot_Alpha

   # Play in ANY Generation from Gen 1 to Gen 9:
   npm run live AIBot_Alpha -- --gen1   # Red / Blue / Yellow
   npm run live AIBot_Alpha -- --gen2   # Gold / Silver / Crystal
   npm run live AIBot_Alpha -- --gen3   # Ruby / Sapphire / Emerald
   npm run live AIBot_Alpha -- --gen4   # Diamond / Pearl / Platinum
   npm run live AIBot_Alpha -- --gen5   # Black / White
   npm run live AIBot_Alpha -- --gen6   # X / Y
   npm run live AIBot_Alpha -- --gen7   # Sun / Moon
   npm run live AIBot_Alpha -- --gen8   # Sword / Shield
   npm run live AIBot_Alpha -- --gen9   # Scarlet / Violet
   ```
2. Open **[play.pokemonshowdown.com](https://play.pokemonshowdown.com)** in your web browser.
3. On the right sidebar, click **"Find a user"** and search for `AIBot_Alpha`.
4. Click **"Challenge"** and choose your battle format (e.g. `[Gen 1] Random Battle` up to `[Gen 9] Random Battle`).
5. The bot will **automatically accept your challenge** and battle you in real-time in your browser!

#### Option B: Matchmaking on the Public Showdown Ladder
Play against real players on Pokémon Showdown's public competitive ladder in any generation:
```bash
# Play on Gen 9 Random Battle ladder
npm run live AIBot_Alpha -- --ladder

# Play on Gen 1-8 Random Battle ladder
npm run live AIBot_Alpha -- --gen1 --ladder
npm run live AIBot_Alpha -- --gen2 --ladder
npm run live AIBot_Alpha -- --gen3 --ladder
npm run live AIBot_Alpha -- --gen4 --ladder
npm run live AIBot_Alpha -- --gen5 --ladder
npm run live AIBot_Alpha -- --gen6 --ladder
npm run live AIBot_Alpha -- --gen7 --ladder
npm run live AIBot_Alpha -- --gen8 --ladder

# Play 1 match and cleanly exit when finished
npm run live AIBot_Alpha -- --ladder --exit-on-finish
```

#### Option C: Multi-Generation Autonomous Training & Improvement
Train and evaluate neural models across all 9 generations (Gen 1 through Gen 9):
```bash
# Train on multi-generation self-play battles and promote candidate model
npm run train:all-gens

# Continuous unattended autonomous multi-generation training loop
npm run autonomous
```

#### Option D: Play with TypeSafe AI Jev System One
```bash
$env:TYPESAFE_API_KEY="your_api_key_here"
npm run live AIBot_Alpha -- --jev --ladder
```

---

## ⚙️ Configuration & Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `SHOWDOWN_USERNAME` | Username for Pokémon Showdown | `AI_Bot_<random>` |
| `SHOWDOWN_PASSWORD` | Password (required only for registered accounts) | `""` (Guest Assertion) |
| `SHOWDOWN_FORMAT` | Battle format (e.g. `gen9randombattle`, `gen2randombattle`, `gen2ou`) | `gen9randombattle` |
| `SHOWDOWN_SERVER` | WebSocket server URL | `wss://sim3.psim.us/showdown/websocket` |
| `AI_MODE` | Decision mode: `baseline`, `jev`, or `ollama` | `baseline` |
| `TYPESAFE_API_KEY` | API key for TypeSafe Jev System One | Optional |
| `OLLAMA_MODEL` | Model for local Ollama LLM | `qwen2.5:7b` |

---

## 📁 Repository Structure

```text
pokemon-ai/
├── src/
│   ├── ai/                      # AI Decision Layer
│   │   ├── decision-schema.ts   # Zod schema for structured reasoning
│   │   ├── prompt-compiler.ts   # State to LLM prompt compiler
│   │   ├── strategy-player.ts   # Safety guard & timeout racer
│   │   ├── llm-client.ts        # Ollama & Mock clients
│   │   └── jev-client.ts        # TypeSafe AI Jev System One client
│   ├── battle/                  # State Representation
│   │   ├── battle-state.ts      # BattleState data models
│   │   └── state-tracker.ts     # Protocol parser & P1/P2 auto-detector
│   ├── network/                 # Live Showdown Client
│   │   └── showdown-client.ts   # WebSocket connection, auth & heartbeat
│   ├── sim/                     # In-Memory Simulator
│   │   └── battle-runner.ts     # Headless @pkmn/sim runner
│   ├── strategy/                # Deterministic Evaluation
│   │   ├── candidate-generator.ts # Legal action & @smogon/calc evaluator
│   │   └── baseline-engine.ts   # Heuristic scoring engine
│   ├── utils/
│   │   └── battle-logger.ts     # Console telemetry formatter
│   ├── index.ts                 # In-memory closed-loop runner
│   ├── connect-live.ts          # CLI entry point for live play
│   └── run-verification.ts      # Multi-engine verification suite
├── tests/                       # Automated Vitest test suites (21 tests)
├── docs/                        # Architecture & Loop engineering log
├── package.json
└── tsconfig.json
```

---

## 📜 License
MIT License. Built for autonomous game-playing AI research on Pokémon Showdown.
