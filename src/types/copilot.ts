import type { ClaudeMcpServer } from "./claude"

// Pre-rendered content — converter renders, writer writes
export type CopilotAgentFile = {
  name: string // e.g. "kieran-rails-reviewer" → written as {name}.agent.md
  content: string // Complete file content: YAML frontmatter + body
}

export type CopilotPromptFile = {
  name: string // e.g. "workflows-plan" → written as {name}.prompt.md
  content: string // Complete file content: YAML frontmatter + body
}

export type CopilotSkillDir = {
  name: string
  sourceDir: string // Copied wholesale via copyDir
}

// Reuse ClaudeMcpServer — the writer handles formatting into .vscode/mcp.json
export type CopilotBundle = {
  agents: CopilotAgentFile[]
  prompts: CopilotPromptFile[]
  skillDirs: CopilotSkillDir[]
  mcpServers?: Record<string, ClaudeMcpServer>
  instructions: string // copilot-instructions.md content
  agentsMd: string // AGENTS.md content
}
