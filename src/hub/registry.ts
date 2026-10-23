import type { ToolDefinition } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (tool.kind === 'send' && tool.requiresConfirmation === false) throw new Error(`Send tools always need confirmation: ${tool.name}`);
    if (tool.requiresConfirmation === false && tool.connection !== 'internal') throw new Error(`Only internal tools may skip confirmation: ${tool.name}`);
    if (tool.kind !== 'read' && tool.requiresConfirmation !== false && !tool.preview) throw new Error(`Write/send tool needs a preview: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** A view with only the tools whose name starts with one of `prefixes` (what the model is shown). */
  subset(prefixes: string[]): ToolRegistry {
    const view = new ToolRegistry();
    for (const tool of this.tools.values()) if (prefixes.some(p => tool.name.startsWith(p))) view.tools.set(tool.name, tool);
    return view;
  }
}

/** Defines a tool while keeping input/output types linked to their Zod schemas. */
export function defineTool<I extends import('zod').ZodType, O extends import('zod').ZodType>(tool: ToolDefinition<I, O>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}
