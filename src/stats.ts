/** In-memory activity counters for the dashboard (MCP tool calls + harvest events). */

export interface McpStats {
  total: number;
  calls: Record<string, number>;
  recent: { tool: string; at: number }[];
}
export const mcpStats: McpStats = { total: 0, calls: {}, recent: [] };

export function recordMcp(tool: string): void {
  mcpStats.total++;
  mcpStats.calls[tool] = (mcpStats.calls[tool] ?? 0) + 1;
  mcpStats.recent.unshift({ tool, at: Date.now() });
  if (mcpStats.recent.length > 60) mcpStats.recent.length = 60;
}

export interface HarvestEvents {
  current: { parkId: string; at: number } | null;
  recent: { parkId: string; ok: boolean; sites: number; ms: number; error?: string; at: number }[];
}
export const harvestEvents: HarvestEvents = { current: null, recent: [] };

export function harvestStart(parkId: string): void {
  harvestEvents.current = { parkId, at: Date.now() };
}
export function harvestDone(parkId: string, ok: boolean, sites: number, ms: number, error?: string): void {
  harvestEvents.current = null;
  harvestEvents.recent.unshift({ parkId, ok, sites, ms, error, at: Date.now() });
  if (harvestEvents.recent.length > 60) harvestEvents.recent.length = 60;
}
