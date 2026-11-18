import { z } from 'zod';

export const DESKTOP_AGENT_PROTOCOL = 1;
export const DESKTOP_AGENT_PATH = '/agent/v1/tools/call';
export const DESKTOP_AGENT_HEADER = 'x-tracker-agent-token';
export const MAX_AGENT_REQUEST_BYTES = 32 * 1024 * 1024;

export const agentEndpointSchema = z.object({
  version: z.number().int().positive(),
  pid: z.number().int().positive(),
  leaseToken: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AgentEndpoint = z.infer<typeof agentEndpointSchema>;

export const agentCallSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()),
}).strict();
export type AgentCall = z.infer<typeof agentCallSchema>;

export const agentResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;
