import { z } from 'zod';

export const DecisionSchema = z.object({
  selected_candidate_id: z.string().min(1),
  action_type: z.enum(['move', 'switch']),
  confidence: z.number().min(0).max(1),
  opponent_prediction: z.string().min(1),
  strategic_rationale: z.string().min(1)
});

export type AgentDecision = z.infer<typeof DecisionSchema>;
