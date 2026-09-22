import { LLMClient } from './llm-client.js';
import { BattleState } from '../battle/battle-state.js';
import { EvaluatedCandidateAction } from '../strategy/candidate-generator.js';
import { AgentDecision } from './decision-schema.js';

export interface JevSystemOneResponse {
  answers: {
    action: {
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    };
    opponent_switch?: {
      probability: number;
    };
    win_con_preservation?: {
      score: string | number;
    };
  };
}

export type JevTransport = (payload: {
  model: string;
  state: Record<string, any>;
  questions: Record<string, any>;
}) => Promise<JevSystemOneResponse>;

export class JevClient implements LLMClient {
  private apiKey: string;
  private endpoint: string;
  private transport?: JevTransport;

  constructor(options: {
    apiKey?: string;
    endpoint?: string;
    transport?: JevTransport;
  } = {}) {
    this.apiKey = options.apiKey || process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '';
    this.endpoint = options.endpoint || 'https://api.typesafe.ai/v1/systemone';
    this.transport = options.transport;
  }

  /**
   * Evaluates the game state and candidates natively using Jev's System One questions.
   */
  public async evaluate(
    state: BattleState,
    candidates: EvaluatedCandidateAction[]
  ): Promise<AgentDecision> {
    const candidateCriteria: Record<string, string> = {};
    for (const c of candidates) {
      candidateCriteria[c.id] = c.evaluation.description;
    }

    const payload = {
      model: 'jev-latest',
      state: {
        format: state.format,
        turn: state.turn,
        our_active: state.p1.active
          ? `${state.p1.active.species} (HP: ${state.p1.active.hpPercent}%, ${state.p1.active.currentHp}/${state.p1.active.maxHp})`
          : 'None',
        opponent_active: state.p2.active
          ? `${state.p2.active.species} (HP: ~${state.p2.active.hpPercent}%)`
          : 'None',
        field: {
          weather: state.field.weather || 'None',
          terrain: state.field.terrain || 'None',
          our_hazards: state.field.p1Hazards,
          opponent_hazards: state.field.p2Hazards
        }
      },
      questions: {
        action: {
          type: 'choice',
          instructions:
            'Select the optimal candidate action ID that maximizes win probability given the calculated damage, speed, and hazard impact.',
          criteria: candidateCriteria
        },
        opponent_switch: {
          type: 'boolean',
          instructions: 'Is the opponent likely to switch Pokémon this turn?'
        },
        win_con_preservation: {
          type: 'score',
          instructions: 'How critical is preserving our active Pokémon for the late game?',
          criteria: ['Expendable', 'Useful Support', 'Critical Win Condition']
        }
      }
    };

    let responseData: JevSystemOneResponse;

    if (this.transport) {
      responseData = await this.transport(payload);
    } else {
      if (!this.apiKey) {
        throw new Error(
          'Missing TypeSafe API Key. Please set TYPESAFE_API_KEY environment variable or pass custom transport.'
        );
      }

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(`TypeSafe Jev API call failed [Status: ${res.status}]: ${await res.text()}`);
      }

      responseData = (await res.json()) as JevSystemOneResponse;
    }

    const actionAnswer = responseData.answers?.action;
    if (!actionAnswer || !actionAnswer.choice) {
      throw new Error(`Jev response missing answers.action.choice: ${JSON.stringify(responseData)}`);
    }

    const selectedId = actionAnswer.choice;
    const matchedCandidate = candidates.find(c => c.id === selectedId);
    const actionType = matchedCandidate ? matchedCandidate.type : (selectedId.startsWith('switch') ? 'switch' : 'move');

    const switchProb = responseData.answers?.opponent_switch?.probability ?? 0.5;
    const opponentPrediction =
      switchProb >= 0.55
        ? `Opponent likely to switch (${Math.round(switchProb * 100)}% prob)`
        : `Opponent likely to stay in and attack (${Math.round((1 - switchProb) * 100)}% prob)`;

    const winConRating = responseData.answers?.win_con_preservation?.score || 'Normal';

    return {
      selected_candidate_id: selectedId,
      action_type: actionType,
      confidence: actionAnswer.confidence ?? 0.85,
      opponent_prediction: opponentPrediction,
      strategic_rationale: `Jev System One calibrated decision. Win-con preservation rating: ${winConRating}. Choice rationale: ${matchedCandidate?.evaluation.description || 'Optimal tactical choice'}.`
    };
  }

  /**
   * Implements LLMClient.decide directly bypassing prompt compilation.
   */
  public async decide(
    state: BattleState,
    candidates: EvaluatedCandidateAction[]
  ): Promise<AgentDecision> {
    return this.evaluate(state, candidates);
  }

  /**
   * Fallback implementation for standard LLMClient.generate interface.
   */
  public async generate(prompt: string): Promise<string> {
    return JSON.stringify({
      selected_candidate_id: 'move 1',
      action_type: 'move',
      confidence: 0.85,
      opponent_prediction: 'Opponent attacks',
      strategic_rationale: 'Evaluated by Jev fallback'
    });
  }
}
