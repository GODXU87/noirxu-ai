import type { ToolDefinition } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (tool.kind !== 'read' && !tool.preview) throw new Error(`Write/send tool needs a preview: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
}

/** Defines a tool while keeping input/output types linked to their Zod schemas. */
export function defineTool<I extends import('zod').ZodType, O extends import('zod').ZodType>(tool: ToolDefinition<I, O>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}
