import path from "path"
import { copyDir, writeText, writeJson } from "../utils/files"
import type { CopilotBundle } from "../types/copilot"
import type { ClaudeMcpServer } from "../types/claude"

export async function writeCopilotBundle(outputRoot: string, bundle: CopilotBundle): Promise<void> {
  const githubRoot = path.join(outputRoot, ".github")

  if (bundle.agents.length > 0) {
    const agentsDir = path.join(githubRoot, "agents")
    for (const agent of bundle.agents) {
      await writeText(path.join(agentsDir, `${agent.name}.agent.md`), agent.content + "\n")
    }
  }

  if (bundle.prompts.length > 0) {
    const promptsDir = path.join(githubRoot, "prompts")
    for (const prompt of bundle.prompts) {
      await writeText(path.join(promptsDir, `${prompt.name}.prompt.md`), prompt.content + "\n")
    }
  }

  if (bundle.skillDirs.length > 0) {
    const skillsDir = path.join(githubRoot, "skills")
    for (const skill of bundle.skillDirs) {
      await copyDir(skill.sourceDir, path.join(skillsDir, skill.name))
    }
  }

  const mcpConfig = renderMcpJson(bundle.mcpServers)
  if (mcpConfig) {
    await writeJson(path.join(outputRoot, ".vscode", "mcp.json"), mcpConfig)
  }

  await writeText(path.join(githubRoot, "copilot-instructions.md"), bundle.instructions + "\n")
  await writeText(path.join(outputRoot, "AGENTS.md"), bundle.agentsMd + "\n")
}

export function renderMcpJson(
  mcpServers?: Record<string, ClaudeMcpServer>,
): Record<string, unknown> | null {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return null

  const servers: Record<string, Record<string, unknown>> = {}

  for (const [name, server] of Object.entries(mcpServers)) {
    const entry: Record<string, unknown> = {}

    if (server.command) {
      entry.type = "stdio"
      entry.command = server.command
      if (server.args && server.args.length > 0) {
        entry.args = server.args
      }
      if (server.env && Object.keys(server.env).length > 0) {
        entry.env = server.env
      }
    } else if (server.url) {
      entry.type = server.type ?? "http"
      entry.url = server.url
      if (server.headers && Object.keys(server.headers).length > 0) {
        entry.headers = server.headers
      }
    }

    servers[name] = entry
  }

  return { servers }
}
