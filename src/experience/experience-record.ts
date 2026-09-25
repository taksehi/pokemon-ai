import { z } from 'zod';
import { BattleState } from '../battle/battle-state.js';
import { EvaluatedCandidateAction } from '../strategy/candidate-generator.js';

export interface TurnResult {
  rawLines: string[];
  terminal: boolean;
  winner?: string;
  p1DamageDealtPercent?: number;
  p1DamageTakenPercent?: number;
  p2KnockedOut?: boolean;
  p1KnockedOut?: boolean;
}

export interface ExperienceRecord {
  battleId: string;
  turn: number;
  step: number;
  state: BattleState;
  available_actions: EvaluatedCandidateAction[];
  selected_action: string;
  result: TurnResult;
  reward: number;
  next_state: BattleState;
}

export type RawExperienceRecord = ExperienceRecord;

export const CandidateEvaluationSchema = z.object({
  minDamagePercent: z.number(),
  maxDamagePercent: z.number(),
  koProbability: z.number(),
  outspeeds: z.union([z.boolean(), z.literal('speed_tie'), z.literal('unknown')]),
  priority: z.number(),
  hazardDamagePercent: z.number(),
  switchInSafety: z.enum(['safe', 'risky', 'fatal']).optional(),
  description: z.string(),
  incomingMaxDamagePercent: z.number().optional(),
  opponentThreatensKO: z.boolean().optional(),
  typeEffectivenessAgainstOpponent: z.number().optional(),
  typeResistanceAgainstOpponent: z.number().optional()
});

export const EvaluatedCandidateActionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['move', 'switch']),
  choice: z.string().min(1),
  name: z.string().min(1),
  slot: z.number().int().positive(),
  terastallize: z.boolean().optional(),
  evaluation: CandidateEvaluationSchema
});

export const TurnResultSchema = z.object({
  rawLines: z.array(z.string()),
  terminal: z.boolean(),
  winner: z.string().optional(),
  p1DamageDealtPercent: z.number().optional(),
  p1DamageTakenPercent: z.number().optional(),
  p2KnockedOut: z.boolean().optional(),
  p1KnockedOut: z.boolean().optional()
});

export const ExperienceRecordSchema = z.object({
  battleId: z.string().min(1),
  turn: z.number().int().positive(),
  step: z.number().int().positive(),
  state: z.any(), // BattleState structure
  available_actions: z.array(EvaluatedCandidateActionSchema).min(1),
  selected_action: z.string().min(1),
  result: TurnResultSchema,
  reward: z.number(),
  next_state: z.any()
}).refine(data => {
  // Validate that selected_action was one of the available_actions
  return data.available_actions.some(a => a.id === data.selected_action);
}, {
  message: 'selected_action must be present in available_actions',
  path: ['selected_action']
});

export class ExperienceValidator {
  /**
   * Validates an experience record against the strict schema.
   * Throws Error if record is malformed (rejected at write time).
   */
  public static validateRecord(record: ExperienceRecord): { valid: boolean; errors?: string[] } {
    const parseResult = ExperienceRecordSchema.safeParse(record);
    if (!parseResult.success) {
      const errorMsgs = parseResult.error.errors.map(
        e => `${e.path.join('.')}: ${e.message}`
      );
      return { valid: false, errors: errorMsgs };
    }

    // Additional deep checks on state and next_state
    if (!record.state || typeof record.state.turn !== 'number') {
      return { valid: false, errors: ['state must contain a valid turn number'] };
    }
    if (!record.next_state || typeof record.next_state.turn !== 'number') {
      return { valid: false, errors: ['next_state must contain a valid turn number'] };
    }

    return { valid: true };
  }

  /**
   * Asserts validity, throwing immediately if invalid.
   */
  public static assertValid(record: ExperienceRecord): void {
    const res = this.validateRecord(record);
    if (!res.valid) {
      throw new Error(`[ExperienceValidator] Malformed record rejected: ${res.errors?.join('; ')}`);
    }
  }
}
