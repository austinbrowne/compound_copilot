import { describe, expect, test } from "bun:test"
import {
  convertClaudeToCopilot,
  transformContentForCopilot,
  rewriteParallelBlocks,
  mapTools,
} from "../src/converters/claude-to-copilot"
import { parseFrontmatter } from "../src/utils/frontmatter"
import type { ClaudePlugin } from "../src/types/claude"

const fixturePlugin: ClaudePlugin = {
  root: "/tmp/plugin",
  manifest: { name: "fixture", version: "1.0.0" },
  agents: [
    {
      name: "Security Reviewer",
      description: "Security-focused agent for reviewing code vulnerabilities",
      capabilities: ["Threat modeling", "OWASP"],
      model: "claude-sonnet-4-20250514",
      body: "Focus on vulnerabilities.\n\nCheck for SQL injection.",
      sourcePath: "/tmp/plugin/agents/security-reviewer.md",
    },
  ],
  commands: [
    {
      name: "workflows:plan",
      description: "Planning command",
      argumentHint: "[FOCUS]",
      model: "inherit",
      allowedTools: ["Read", "Grep", "Glob"],
      body: "Plan the work.",
      sourcePath: "/tmp/plugin/commands/workflows/plan.md",
    },
  ],
  skills: [
    {
      name: "existing-skill",
      description: "Existing skill",
      sourceDir: "/tmp/plugin/skills/existing-skill",
      skillPath: "/tmp/plugin/skills/existing-skill/SKILL.md",
    },
  ],
  hooks: undefined,
  mcpServers: {
    context7: { type: "http", url: "https://mcp.context7.com/mcp" },
  },
}

const defaultOptions = { agentMode: "subagent", inferTemperature: false, permissions: "none" as const }

describe("convertClaudeToCopilot", () => {
  test("basic agent conversion — frontmatter fields and body passthrough", () => {
    const bundle = convertClaudeToCopilot(fixturePlugin, defaultOptions)

    expect(bundle.agents).toHaveLength(1)
    const agent = bundle.agents[0]
    expect(agent.name).toBe("security-reviewer")

    const parsed = parseFrontmatter(agent.content)
    expect(parsed.data.name).toBe("security-reviewer")
    expect(parsed.data.description).toBe("Security-focused agent for reviewing code vulnerabilities")
    expect(parsed.data.tools).toEqual(["read", "edit", "search", "execute", "web"])
    expect(parsed.body).toContain("Focus on vulnerabilities")
    expect(parsed.body).toContain("Capabilities")
    expect(parsed.body).toContain("Threat modeling")
  })

  test("agent with XML <example> description — XML stripped, moved to body", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [
        {
          name: "test-agent",
          description:
            "Review Rails code. <example>Context: user asks for review.\nuser: review this\n<commentary>Use this agent for reviews.</commentary></example>",
          body: "Review the code.",
          sourcePath: "/tmp/plugin/agents/test.md",
        },
      ],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToCopilot(plugin, defaultOptions)
    const agent = bundle.agents[0]
    const parsed = parseFrontmatter(agent.content)

    // Description should be clean text before <example>
    expect(parsed.data.description).toBe("Review Rails code.")
    expect(String(parsed.data.description)).not.toContain("<example>")
    expect(String(parsed.data.description)).not.toContain("<commentary>")

    // Examples should be in the body
    expect(parsed.body).toContain("When to Use This Agent")
    expect(parsed.body).not.toContain("<example>")
    expect(parsed.body).not.toContain("<commentary>")
  })

  test("command → prompt conversion — name normalization (: → -, _ → -)", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [
        {
          name: "workflows:plan",
          description: "Plan",
          body: "Do planning.",
          sourcePath: "/tmp/plugin/commands/plan.md",
        },
        {
          name: "my_command",
          description: "My command",
          body: "Run it.",
          sourcePath: "/tmp/plugin/commands/my-command.md",
        },
      ],
      skills: [],
    }

    const bundle = convertClaudeToCopilot(plugin, defaultOptions)
    expect(bundle.prompts[0].name).toBe("workflows-plan")
    expect(bundle.prompts[1].name).toBe("my-command")

    const parsed = parseFrontmatter(bundle.prompts[0].content)
    expect(parsed.data.agent).toBe("agent")
  })

  test("tool mapping — allowed-tools with patterns mapped to Copilot names, case-insensitive", () => {
    const tools = mapTools(["Bash(ls:*)", "Read", "WebSearch"])
    expect(tools).toContain("execute")
    expect(tools).toContain("read")
    expect(tools).toContain("web")
    expect(tools).not.toContain("Bash")
    expect(tools).not.toContain("WebSearch")
  })

  test("tool mapping deduplication — Read, Grep, Glob → read, search (no duplicate search)", () => {
    const tools = mapTools(["Read", "Grep", "Glob"])
    expect(tools).toEqual(["read", "search"])
  })

  test("content transformation: Task calls → sequential instructions", () => {
    const input = `Run these agents:

- Task repo-research-analyst(feature_description)
- Task learnings-researcher(feature_description)

Then consolidate findings.

Task best-practices-researcher(topic)`

    const result = transformContentForCopilot(input)

    expect(result).toContain("Use the **repo-research-analyst** agent to: feature_description")
    expect(result).toContain("Use the **learnings-researcher** agent to: feature_description")
    expect(result).toContain("Use the **best-practices-researcher** agent to: topic")
    expect(result).not.toContain("Task repo-research-analyst")
    expect(result).not.toContain("Task learnings-researcher")
  })

  test("content transformation: <thinking> block removal", () => {
    const input = "Before\n<thinking>\nSome internal reasoning\n</thinking>\nAfter"
    const result = transformContentForCopilot(input)
    expect(result).not.toContain("<thinking>")
    expect(result).not.toContain("internal reasoning")
    expect(result).toContain("Before")
    expect(result).toContain("After")
  })

  test("content transformation: $ARGUMENTS replacement", () => {
    const result = transformContentForCopilot("Use $ARGUMENTS as the input")
    expect(result).toContain("(the user's input)")
    expect(result).not.toContain("$ARGUMENTS")
  })

  test("content transformation: /compound-engineering: namespace stripping", () => {
    const result = transformContentForCopilot("Run /compound-engineering:plan-review for feedback")
    expect(result).toContain("/plan-review")
    expect(result).not.toContain("/compound-engineering:")
  })

  test("content transformation: /workflows: colon-to-hyphen", () => {
    const result = transformContentForCopilot("Start /workflows:work to implement")
    expect(result).toContain("/workflows-work")
    expect(result).not.toContain("/workflows:")
  })

  test("content transformation: parallel dispatch block rewriting", () => {
    // After Task regex, parallel blocks become "- Use the **agent** agent to: args"
    const input = [
      "Run these agents sequentially:",
      "",
      "- Use the **agent-a** agent to: task a",
      "- Use the **agent-b** agent to: task b",
      "- Use the **agent-c** agent to: task c",
      "",
      "Then summarize.",
    ].join("\n")

    const result = rewriteParallelBlocks(input)
    expect(result).toContain("1. Use the **agent-a** agent to: task a")
    expect(result).toContain("2. Use the **agent-b** agent to: task b")
    expect(result).toContain("3. Use the **agent-c** agent to: task c")
    expect(result).not.toMatch(/^- Use the \*\*/m)
  })

  test("content transformation: single agent call not rewritten to numbered list", () => {
    const input = "- Use the **agent-a** agent to: task a\n\nSome other text."
    const result = rewriteParallelBlocks(input)
    expect(result).toContain("- Use the **agent-a** agent to: task a")
    expect(result).not.toContain("1.")
  })

  test("@agent-name references pass through unchanged", () => {
    const result = transformContentForCopilot("Ask @kieran-rails-reviewer for feedback")
    expect(result).toContain("@kieran-rails-reviewer")
  })

  test("bare /command-name references pass through unchanged", () => {
    const result = transformContentForCopilot("Run /deepen-plan to enhance the plan")
    expect(result).toContain("/deepen-plan")
  })

  test("MCP server passthrough", () => {
    const bundle = convertClaudeToCopilot(fixturePlugin, defaultOptions)
    expect(bundle.mcpServers?.context7?.url).toBe("https://mcp.context7.com/mcp")
    expect(bundle.mcpServers?.context7?.type).toBe("http")
  })

  test("skill directory passthrough", () => {
    const bundle = convertClaudeToCopilot(fixturePlugin, defaultOptions)
    expect(bundle.skillDirs).toHaveLength(1)
    expect(bundle.skillDirs[0].name).toBe("existing-skill")
    expect(bundle.skillDirs[0].sourceDir).toBe("/tmp/plugin/skills/existing-skill")
  })

  test("instructions generation with correct component counts", () => {
    const bundle = convertClaudeToCopilot(fixturePlugin, defaultOptions)
    expect(bundle.instructions).toContain("1 custom agents")
    expect(bundle.instructions).toContain("1 prompt commands")
    expect(bundle.instructions).toContain("1 skills")
    expect(bundle.instructions).toContain("Compound Engineering")
  })

  test("AGENTS.md generation with agent/prompt/skill tables", () => {
    const bundle = convertClaudeToCopilot(fixturePlugin, defaultOptions)
    expect(bundle.agentsMd).toContain("@security-reviewer")
    expect(bundle.agentsMd).toContain("/workflows-plan")
    expect(bundle.agentsMd).toContain("existing-skill")
    expect(bundle.agentsMd).toContain("## Agents")
    expect(bundle.agentsMd).toContain("## Commands (Prompt Files)")
    expect(bundle.agentsMd).toContain("## Skills")
  })

  test("model field omitted from all output", () => {
    const bundle = convertClaudeToCopilot(fixturePlugin, defaultOptions)

    for (const agent of bundle.agents) {
      const parsed = parseFrontmatter(agent.content)
      expect(parsed.data.model).toBeUndefined()
    }
    for (const prompt of bundle.prompts) {
      const parsed = parseFrontmatter(prompt.content)
      expect(parsed.data.model).toBeUndefined()
    }
  })

  test("hooks dropped (not present in bundle)", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      hooks: {
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo test" }] }],
        },
      },
    }

    const bundle = convertClaudeToCopilot(plugin, defaultOptions)
    // Bundle has no hooks field at all
    expect("hooks" in bundle).toBe(false)
  })
})
