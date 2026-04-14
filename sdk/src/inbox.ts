/** Per-subagent inbox manager for inject message delivery. */
export class InboxManager {
  private inboxes = new Map<string, string[]>();

  /** Initialize an empty inbox for a new subagent. */
  create(agentId: string): void {
    this.inboxes.set(agentId, []);
  }

  /** Push a message into a subagent's inbox. */
  push(agentId: string, message: string): void {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) {
      throw new Error(
        `pmcp: no inbox for agent "${agentId}". ` +
          `Known agents: ${[...this.inboxes.keys()].join(", ") || "(none)"}`,
      );
    }
    inbox.push(message);
  }

  /** Drain and return all pending messages, clearing the inbox. */
  drain(agentId: string): string[] {
    const inbox = this.inboxes.get(agentId);
    if (!inbox || inbox.length === 0) return [];
    return inbox.splice(0, inbox.length);
  }

  /** Check if an agent has a registered inbox. */
  has(agentId: string): boolean {
    return this.inboxes.has(agentId);
  }

  /** Get all registered agent IDs. */
  getAgentIds(): string[] {
    return [...this.inboxes.keys()];
  }
}
