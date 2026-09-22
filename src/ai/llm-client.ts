import { BattleState } from '../battle/battle-state.js';
import { EvaluatedCandidateAction } from '../strategy/candidate-generator.js';
import { AgentDecision } from './decision-schema.js';

export interface LLMClient {
  generate(prompt: string): Promise<string>;
  decide?(state: BattleState, candidates: EvaluatedCandidateAction[]): Promise<AgentDecision>;
}

export class MockLLMClient implements LLMClient {
  private responder: (prompt: string) => Promise<string> | string;

  constructor(responder: (prompt: string) => Promise<string> | string) {
    this.responder = responder;
  }

  public async generate(prompt: string): Promise<string> {
    return this.responder(prompt);
  }
}

export class OllamaClient implements LLMClient {
  private baseUrl: string;
  private model: string;

  constructor(options: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = options.baseUrl || 'http://localhost:11434';
    this.model = options.model || 'qwen2.5:7b';
  }

  public async generate(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        format: 'json'
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama request failed with status ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { response: string };
    return data.response;
  }
}
