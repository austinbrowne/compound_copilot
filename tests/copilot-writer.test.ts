import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { writeCopilotBundle, renderMcpJson } from "../src/targets/copilot"
import type { CopilotBundle } from "../src/types/copilot"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-writer-test-"))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const minimalBundle: CopilotBundle = {
  agents: [
    { name: "test-agent", content: "---\nname: test-agent\n---\n\nAgent body." },
  ],
  prompts: [
    { name: "test-prompt", content: "---\ndescription: Test prompt\n---\n\nPrompt body." },
  ],
  skillDirs: [],
  mcpServers: { local: { command: "echo", args: ["hello"] } },
  instructions: "# Instructions\n\nTest instructions.",
  agentsMd: "# AGENTS\n\nTest catalog.",
}

describe("writeCopilotBundle", () => {
  test("creates correct output directory structure", async () => {
    await writeCopilotBundle(tmpDir, minimalBundle)

    const agentsDir = path.join(tmpDir, ".github", "agents")
    const promptsDir = path.join(tmpDir, ".github", "prompts")
    const vscodeDir = path.join(tmpDir, ".vscode")

    const agentsStat = await fs.stat(agentsDir)
    expect(agentsStat.isDirectory()).toBe(true)

    const promptsStat = await fs.stat(promptsDir)
    expect(promptsStat.isDirectory()).toBe(true)

    const vscodeStat = await fs.stat(vscodeDir)
    expect(vscodeStat.isDirectory()).toBe(true)
  })

  test("writes agent files as {name}.agent.md", async () => {
    await writeCopilotBundle(tmpDir, minimalBundle)

    const agentFile = path.join(tmpDir, ".github", "agents", "test-agent.agent.md")
    const content = await fs.readFile(agentFile, "utf8")
    expect(content).toContain("name: test-agent")
    expect(content).toContain("Agent body.")
  })

  test("writes prompt files as {name}.prompt.md", async () => {
    await writeCopilotBundle(tmpDir, minimalBundle)

    const promptFile = path.join(tmpDir, ".github", "prompts", "test-prompt.prompt.md")
    const content = await fs.readFile(promptFile, "utf8")
    expect(content).toContain("Test prompt")
    expect(content).toContain("Prompt body.")
  })

  test("copies skill directories wholesale", async () => {
    // Create a fake skill source directory
    const skillSource = path.join(tmpDir, "source-skill")
    await fs.mkdir(skillSource, { recursive: true })
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# Skill\n")
    await fs.mkdir(path.join(skillSource, "scripts"), { recursive: true })
    await fs.writeFile(path.join(skillSource, "scripts", "run.sh"), "#!/bin/bash\n")

    const outputDir = path.join(tmpDir, "output")
    const bundle: CopilotBundle = {
      ...minimalBundle,
      skillDirs: [{ name: "my-skill", sourceDir: skillSource }],
    }

    await writeCopilotBundle(outputDir, bundle)

    const skillMd = path.join(outputDir, ".github", "skills", "my-skill", "SKILL.md")
    const scriptFile = path.join(outputDir, ".github", "skills", "my-skill", "scripts", "run.sh")
    const skillContent = await fs.readFile(skillMd, "utf8")
    const scriptContent = await fs.readFile(scriptFile, "utf8")

    expect(skillContent).toBe("# Skill\n")
    expect(scriptContent).toBe("#!/bin/bash\n")
  })

  test("writes mcp.json with correct JSON structure", async () => {
    await writeCopilotBundle(tmpDir, minimalBundle)

    const mcpFile = path.join(tmpDir, ".vscode", "mcp.json")
    const raw = await fs.readFile(mcpFile, "utf8")
    const parsed = JSON.parse(raw)

    expect(parsed.servers).toBeDefined()
    expect(parsed.servers.local.type).toBe("stdio")
    expect(parsed.servers.local.command).toBe("echo")
    expect(parsed.servers.local.args).toEqual(["hello"])
  })

  test("writes copilot-instructions.md to .github/", async () => {
    await writeCopilotBundle(tmpDir, minimalBundle)

    const file = path.join(tmpDir, ".github", "copilot-instructions.md")
    const content = await fs.readFile(file, "utf8")
    expect(content).toContain("Test instructions.")
  })

  test("writes AGENTS.md to output root", async () => {
    await writeCopilotBundle(tmpDir, minimalBundle)

    const file = path.join(tmpDir, "AGENTS.md")
    const content = await fs.readFile(file, "utf8")
    expect(content).toContain("Test catalog.")
  })
})

describe("renderMcpJson", () => {
  test("returns null for empty servers", () => {
    expect(renderMcpJson(undefined)).toBeNull()
    expect(renderMcpJson({})).toBeNull()
  })

  test("formats stdio server correctly", () => {
    const result = renderMcpJson({
      myserver: { command: "node", args: ["server.js"], env: { API_KEY: "secret" } },
    })
    expect(result).toEqual({
      servers: {
        myserver: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { API_KEY: "secret" },
        },
      },
    })
  })

  test("formats HTTP server correctly", () => {
    const result = renderMcpJson({
      remote: { type: "http", url: "https://example.com/mcp", headers: { "X-Token": "abc" } },
    })
    expect(result).toEqual({
      servers: {
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { "X-Token": "abc" },
        },
      },
    })
  })
})
