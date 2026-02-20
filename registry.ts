/**
 * In-memory registry of dispatched background agents.
 * Reconstructable from tmux sessions + lb issue descriptions on restart.
 */

export interface AgentEntry {
  issueId: string
  port: number
  sessionId: string
  tmuxSession: string
  branch: string
  worktreePath: string
  dispatchedAt: string
}

export class AgentRegistry {
  private agents = new Map<string, AgentEntry>()

  set(issueId: string, entry: AgentEntry): void {
    this.agents.set(issueId, entry)
  }

  get(issueId: string): AgentEntry | undefined {
    return this.agents.get(issueId)
  }

  has(issueId: string): boolean {
    return this.agents.has(issueId)
  }

  delete(issueId: string): boolean {
    return this.agents.delete(issueId)
  }

  entries(): IterableIterator<[string, AgentEntry]> {
    return this.agents.entries()
  }

  size(): number {
    return this.agents.size
  }

  toJSON(): Record<string, AgentEntry> {
    return Object.fromEntries(this.agents)
  }
}
