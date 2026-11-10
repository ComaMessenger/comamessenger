import type { ChatAgent } from "./types";

export type ChatCommand = {
  command: string;
  agentID: string;
  agentName: string;
  agentHandle: string;
  avatarVersion: number;
  description: string;
};

/** Commands that start agents in a chat; paused agents are left out. */
export function chatCommands(agents: ChatAgent[]): ChatCommand[] {
  const seen = new Set<string>();
  const commands: ChatCommand[] = [];
  for (const agent of agents) {
    if (agent.status !== "active") continue;
    for (const trigger of agent.triggers) {
      if (trigger.type !== "command" || !trigger.command) continue;
      const key = `${agent.agent_id}/${trigger.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push({
        command: trigger.command,
        agentID: agent.agent_id,
        agentName: agent.display_name,
        agentHandle: agent.handle,
        avatarVersion: agent.avatar_version,
        description: agent.description,
      });
    }
  }
  return commands.sort((left, right) =>
    left.command.localeCompare(right.command),
  );
}

/**
 * The command being typed: the composer text is a single `/word` with no
 * whitespace yet. Returns the lowercase query without the slash, or null.
 */
export function commandQuery(text: string): string | null {
  const match = /^\/([\p{L}\p{N}_.-]*)$/u.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

export function matchCommands(
  commands: ChatCommand[],
  query: string,
): ChatCommand[] {
  const starts = commands.filter((item) => item.command.startsWith(query));
  const contains = commands.filter(
    (item) =>
      !item.command.startsWith(query) &&
      (item.command.includes(query) ||
        item.agentName.toLowerCase().includes(query)),
  );
  return [...starts, ...contains];
}
