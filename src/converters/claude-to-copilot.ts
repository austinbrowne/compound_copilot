import { formatFrontmatter } from "../utils/frontmatter"
import type { ClaudeAgent, ClaudeCommand, ClaudePlugin, ClaudeSkill } from "../types/claude"
import type { CopilotBundle, CopilotAgentFile, CopilotPromptFile } from "../types/copilot"
import type { ClaudeToOpenCodeOptions } from "./claude-to-opencode"

export type ClaudeToCopilotOptions = ClaudeToOpenCodeOptions

const COPILOT_DESCRIPTION_MAX_LENGTH = 1024

const DEFAULT_TOOLS = ["read", "edit", "search", "execute", "web"]

const TOOL_MAP: Record<string, string> = {
  bash: "execute",
  read: "read",
  edit: "edit",
  write: "edit",
  multiedit: "edit",
  grep: "search",
  glob: "search",
  list: "search",
  websearch: "web",
  webfetch: "web",
  task: "agent",
  todowrite: "todo",
  todoread: "todo",
  question: "agent",
  notebookread: "read",
  notebookedit: "edit",
  patch: "edit",
}

export function convertClaudeToCopilot(
  plugin: ClaudePlugin,
  _options: ClaudeToCopilotOptions,
): CopilotBundle {
  const agentNames = new Set<string>()
  const promptNames = new Set<string>()

  const agents = plugin.agents.map((agent) => convertAgent(agent, agentNames))
  const prompts = plugin.commands.map((command) => convertCommand(command, promptNames))
  const skillDirs = plugin.skills.map((skill) => ({
    name: skill.name,
    sourceDir: skill.sourceDir,
  }))

  const instructions = renderInstructions(agents.length, prompts.length, skillDirs.length)
  const agentsMd = renderAgentsMd(agents, prompts, plugin.skills)

  // Warn about large files
  for (const agent of agents) {
    warnIfLarge(agent.name + ".agent.md", agent.content)
  }
  for (const prompt of prompts) {
    warnIfLarge(prompt.name + ".prompt.md", prompt.content)
  }

  return {
    agents,
    prompts,
    skillDirs,
    mcpServers: plugin.mcpServers,
    instructions,
    agentsMd,
  }
}

function convertAgent(agent: ClaudeAgent, usedNames: Set<string>): CopilotAgentFile {
  const name = uniqueName(normalizeName(agent.name), usedNames)

  const { description, examples } = sanitizeAgentDescription(
    agent.description ?? `Converted from Claude agent ${agent.name}`,
  )

  const frontmatter: Record<string, unknown> = {
    name,
    description,
    tools: DEFAULT_TOOLS,
  }

  const sections: string[] = []

  if (examples) {
    sections.push("## When to Use This Agent\n\n" + examples)
  }

  let body = transformContentForCopilot(agent.body.trim())
  if (agent.capabilities && agent.capabilities.length > 0) {
    const capabilities = agent.capabilities.map((c) => `- ${c}`).join("\n")
    body = `## Capabilities\n\n${capabilities}\n\n${body}`
  }

  sections.push(body)

  const finalBody = sections.filter(Boolean).join("\n\n").trim()
  const content = formatFrontmatter(frontmatter, finalBody || `Instructions for the ${name} agent.`)
  return { name, content }
}

function convertCommand(command: ClaudeCommand, usedNames: Set<string>): CopilotPromptFile {
  const name = uniqueName(normalizeName(command.name), usedNames)

  const tools = mapTools(command.allowedTools)

  const frontmatter: Record<string, unknown> = {
    description: command.description,
    "argument-hint": command.argumentHint,
    agent: "agent",
    tools,
  }

  const body = transformContentForCopilot(command.body.trim())
  const content = formatFrontmatter(frontmatter, body || command.body)
  return { name, content }
}

export function mapTools(allowedTools?: string[]): string[] {
  if (!allowedTools || allowedTools.length === 0) return DEFAULT_TOOLS

  const mapped = new Set<string>()
  for (const tool of allowedTools) {
    // Extract tool name before parenthesis: "Bash(ls:*)" → "bash"
    const toolName = tool.replace(/\(.*$/, "").trim().toLowerCase()
    const copilotTool = TOOL_MAP[toolName]
    if (copilotTool) {
      mapped.add(copilotTool)
    }
  }

  return mapped.size > 0 ? [...mapped] : DEFAULT_TOOLS
}

/**
 * Transform Claude Code content to Copilot-compatible content.
 *
 * Handles Claude-specific syntax that other LLMs won't understand:
 * Task calls, $ARGUMENTS, thinking blocks, plugin-namespaced commands, etc.
 */
export function transformContentForCopilot(body: string): string {
  let result = body

  // 1. Task agent calls → sequential instruction
  const taskPattern = /^(\s*-?\s*)Task\s+([a-z][a-z0-9-]*)\(([^)]+)\)/gm
  result = result.replace(taskPattern, '$1Use the **$2** agent to: $3')

  // 2. Plugin-namespaced command references
  result = result.replace(/\/compound-engineering:([\w-]+)/g, "/$1")

  // 3. Workflow command references (colon to hyphen)
  result = result.replace(/\/workflows:([\w-]+)/g, "/workflows-$1")

  // 4. $ARGUMENTS placeholder
  result = result.replace(/\$ARGUMENTS/g, "(the user's input)")

  // 5. <thinking> blocks
  result = result.replace(/<thinking>[\s\S]*?<\/thinking>/g, "")

  // 6. AskUserQuestion tool references
  result = result.replace(/AskUserQuestion/g, "ask the user")

  // 7. TodoWrite tool references
  result = result.replace(/TodoWrite/g, "task tracking")

  // 8. Skill() tool pattern
  result = result.replace(/Skill\(([\w-]+)\)/g, "the $1 skill")

  // 9. /model directive lines
  result = result.replace(/^\/model.*$/gm, "")

  // 10. EnterPlanMode references
  result = result.replace(/EnterPlanMode/g, "")

  // 11. Parallel dispatch prose rewrite
  result = result.replace(/Run these agents?\s*\*?\*?in parallel\*?\*?/gi, "Run these agents sequentially")

  // Rewrite parallel Task blocks to numbered sequential steps
  result = rewriteParallelBlocks(result)

  // Clean up excessive blank lines left by removals
  result = result.replace(/\n{3,}/g, "\n\n")

  return result.trim()
}

/**
 * Detect bullet lists of `- Task` calls and rewrite as numbered sequential steps.
 * Copilot does not support parallel agent dispatch.
 */
export function rewriteParallelBlocks(body: string): string {
  const lines = body.split("\n")
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    // Look for consecutive lines starting with "- Use the **"
    // (these are already transformed from "- Task" by regex #1)
    if (/^\s*-\s+Use the \*\*/.test(lines[i])) {
      const block: string[] = []
      while (i < lines.length && /^\s*-\s+Use the \*\*/.test(lines[i])) {
        block.push(lines[i])
        i++
      }

      // Only rewrite if there are 2+ consecutive agent calls (a "parallel block")
      if (block.length >= 2) {
        for (let j = 0; j < block.length; j++) {
          const content = block[j].replace(/^\s*-\s+/, "")
          result.push(`${j + 1}. ${content}`)
        }
      } else {
        result.push(...block)
      }
    } else {
      result.push(lines[i])
      i++
    }
  }

  return result.join("\n")
}

function sanitizeAgentDescription(
  raw: string,
): { description: string; examples: string | null } {
  // Check for <example> tags
  const exampleIndex = raw.indexOf("<example>")
  if (exampleIndex === -1) {
    // No examples — just clean and truncate
    const cleaned = raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    return { description: truncateDescription(cleaned), examples: null }
  }

  // Extract text before first <example> as description
  const descriptionRaw = raw.slice(0, exampleIndex).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
  const description = truncateDescription(descriptionRaw)

  // Extract examples, strip XML tags, convert to markdown
  const examplesRaw = raw.slice(exampleIndex)
  const examples = examplesRaw
    .replace(/<example>/g, "")
    .replace(/<\/example>/g, "\n---\n")
    .replace(/<commentary>/g, "\n> ")
    .replace(/<\/commentary>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return { description, examples: examples || null }
}

function truncateDescription(value: string, maxLength = COPILOT_DESCRIPTION_MAX_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  const ellipsis = "..."
  return normalized.slice(0, Math.max(0, maxLength - ellipsis.length)).trimEnd() + ellipsis
}

function renderInstructions(agentCount: number, promptCount: number, skillCount: number): string {
  return `# Compound Engineering

This repository uses the compound-engineering plugin for AI-assisted development.

## Philosophy

Each unit of engineering work should make subsequent work easier — not harder.
Focus 80% on planning and review, 20% on execution.

## Available Tools

- **${agentCount} custom agents** in \`.github/agents/\` — invoke with @agent-name in chat
- **${promptCount} prompt commands** in \`.github/prompts/\` — invoke with /command-name in chat
- **${skillCount} skills** in \`.github/skills/\` — automatically loaded when relevant
- **MCP servers** configured in \`.vscode/mcp.json\`

## Code Style

- Write tests for new code
- Use type hints (Python) or TypeScript
- Follow existing project conventions
- Validate all user input
- Never hardcode secrets — use environment variables

## Security

- Parameterized queries only (no string concatenation in SQL)
- Encode output in HTML context (XSS prevention)
- Check authorization on every resource access
- Try/catch around all external calls (API, DB, file I/O)`
}

function renderAgentsMd(
  agents: CopilotAgentFile[],
  prompts: CopilotPromptFile[],
  skills: ClaudeSkill[],
): string {
  const agentRows = agents
    .map((a) => `| @${a.name} | ${getDescriptionFromContent(a.content)} |`)
    .join("\n")

  const promptRows = prompts
    .map((p) => `| /${p.name} | ${getDescriptionFromContent(p.content)} |`)
    .join("\n")

  const skillRows = skills
    .map((s) => `| ${s.name} | ${s.description ?? ""} |`)
    .join("\n")

  return `# Compound Engineering Plugin

## Agents

| Agent | Description |
|-------|-------------|
${agentRows}

## Commands (Prompt Files)

| Command | Description |
|---------|-------------|
${promptRows}

## Skills

| Skill | Description |
|-------|-------------|
${skillRows}

## Workflow

**Full feature:** /workflows-brainstorm → /workflows-plan → /workflows-work → /workflows-review

**Quick bug fix:** /reproduce-bug → [fix] → /workflows-review

**Just review:** [staged changes] → /workflows-review`
}

/**
 * Extract description from pre-rendered frontmatter content.
 * Looks for the `description:` line in YAML frontmatter.
 */
function getDescriptionFromContent(content: string): string {
  const match = content.match(/^description:\s*(.+)$/m)
  if (match) return match[1].trim()
  return ""
}

function normalizeName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "item"
  const normalized = trimmed
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[:\s_]+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "item"
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let index = 2
  while (used.has(`${base}-${index}`)) {
    index += 1
  }
  const name = `${base}-${index}`
  used.add(name)
  return name
}

const SIZE_WARNING_THRESHOLD = 25_000

function warnIfLarge(filename: string, content: string): void {
  if (content.length > SIZE_WARNING_THRESHOLD) {
    console.warn(
      `Warning: ${filename} is ${content.length} characters (exceeds ${SIZE_WARNING_THRESHOLD}). ` +
        `Copilot may truncate files over 30,000 characters.`,
    )
  }
}
