export interface AgentCapability {
  supportsResume: boolean;
  resumeCommand?: (sessionId: string) => string;
}

const agentCapabilities: Record<string, AgentCapability> = {
  claude: {
    supportsResume: true,
    resumeCommand: (sid) => `claude --resume ${sid}`,
  },
};

export function getAgentCapabilities(agentName: string): AgentCapability {
  return agentCapabilities[agentName] ?? { supportsResume: false };
}
