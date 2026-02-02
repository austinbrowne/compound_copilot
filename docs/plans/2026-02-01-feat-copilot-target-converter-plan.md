---
title: "feat: Add GitHub Copilot VS Code target converter"
type: feat
date: 2026-02-01
---

# Add GitHub Copilot VS Code Target Converter

## Overview

Add a third conversion target (`--to copilot`) to the compound-engineering CLI that transforms Claude Code plugins into GitHub Copilot VS Code-compatible file structures. This produces a standalone `.github/` + `.vscode/` directory tree that users can drop into any repository to get agents, commands, skills, and MCP servers working with GitHub Copilot in VS Code agent mode.

The converter works with any Claude Code plugin, not just compound-engineering.

## Problem Statement

The compound-engineering plugin currently only works with Claude Code. GitHub Copilot's extensibility model (`.agent.md`, `.prompt.md`, `SKILL.md`, MCP servers) is mature enough to support the plugin's capabilities — with one notable exception: **no parallel agent execution**. The CLI already converts to OpenCode and Codex; adding Copilot follows the established pattern.

## Proposed Solution

Follow the existing 4-layer converter architecture:

1. **Types** (`src/types/copilot.ts`) — Define the `CopilotBundle` output shape
2. **Converter** (`src/converters/claude-to-copilot.ts`) — Map Claude Code components to Copilot equivalents, render final content
3. **Writer** (`src/targets/copilot.ts`) — Write files to disk (writer is trivial — converter does the heavy lifting)
4. **Registration** (`src/targets/index.ts`) — Register `copilot` as a target

### Component Mapping

| Claude Code (Source) | Copilot (Target) | Location |
|---|---|---|
| Agents (`agents/*.md`) | Custom Agents | `.github/agents/*.agent.md` |
| Commands (`commands/*.md`) | Prompt Files | `.github/prompts/*.prompt.md` |
| Skills (`skills/*/SKILL.md`) | Agent Skills | `.github/skills/*/SKILL.md` |
| MCP servers (plugin.json) | MCP Config | `.vscode/mcp.json` |
| Hooks | (dropped) | Copilot has no equivalent of lifecycle hooks. Consistent with the Codex converter's approach. |

### Output Directory Structure

```
<output-root>/
├── .github/
│   ├── agents/
│   │   └── *.agent.md           (flat — subdirectories flattened)
│   ├── prompts/
│   │   └── *.prompt.md          (colons replaced with hyphens in names)
│   ├── skills/
│   │   └── */SKILL.md           (copied wholesale with scripts/, references/, assets/)
│   └── copilot-instructions.md  (hardcoded template — see Section 2g)
├── .vscode/
│   └── mcp.json
└── AGENTS.md                    (generated catalog — see Section 2g)
```

## Technical Approach

### Phase 1: Type Definitions

**New file: `src/types/copilot.ts`**

Follow the established pattern: bundle types store **pre-rendered content strings**. The converter renders frontmatter + body into a single string. The writer just writes to disk. This matches `CodexPrompt`, `CodexGeneratedSkill`, `OpenCodeAgentFile`, etc.

```typescript
import type { ClaudeMcpServer } from "./claude"

// Pre-rendered content — converter renders, writer writes
export type CopilotAgentFile = {
  name: string       // e.g. "kieran-rails-reviewer" → written as {name}.agent.md
  content: string    // Complete file content: YAML frontmatter + body
}

export type CopilotPromptFile = {
  name: string       // e.g. "workflows-plan" → written as {name}.prompt.md
  content: string    // Complete file content: YAML frontmatter + body
}

export type CopilotSkillDir = {
  name: string
  sourceDir: string  // Copied wholesale via copyDir
}

// Reuse ClaudeMcpServer — no need for a separate Copilot type.
// The writer handles formatting into .vscode/mcp.json structure.
export type CopilotBundle = {
  agents: CopilotAgentFile[]
  prompts: CopilotPromptFile[]
  skillDirs: CopilotSkillDir[]
  mcpServers?: Record<string, ClaudeMcpServer>
  instructions: string   // copilot-instructions.md content
  agentsMd: string       // AGENTS.md content
}
```

**Options type:**

```typescript
// Follow Codex converter's pattern — alias the shared options type
export type ClaudeToCopilotOptions = ClaudeToOpenCodeOptions
```

The options include `agentMode`, `inferTemperature`, and `permissions` — all irrelevant to Copilot. The converter accepts but ignores them (prefix with `_`).

### Phase 2: Converter Logic

**New file: `src/converters/claude-to-copilot.ts`**

The converter performs these transformations and renders final content strings.

#### 2a. Agent Conversion

| Claude Field | Copilot Output | Transformation |
|---|---|---|
| `name` | frontmatter `name` | Pass through |
| `description` (with XML) | frontmatter `description` | Extract first sentence, strip `<example>`/`<commentary>` XML tags |
| `description` (full) | body "## When to Use" section | Clean XML tags, convert examples to markdown, prepend to body |
| `model` | (omitted) | Drop entirely — Copilot uses user's selected model |
| `color` | (dropped) | No Copilot equivalent |
| `body` | body content | Apply content transformations (see 2c) |
| (not present) | frontmatter `tools` | Default: `["read", "edit", "search", "execute", "web"]` |

The converter renders the complete `.agent.md` file content:

```yaml
---
name: kieran-rails-reviewer
description: Rails code reviewer applying strict conventions for quality, naming, and architecture
tools:
  - read
  - edit
  - search
  - execute
---

## When to Use This Agent

Use this agent when you need to review Rails code changes...

## Review Principles

[transformed body content]
```

Note: `formatFrontmatter()` produces YAML block arrays (one item per line with `- ` prefix), not inline arrays. Both are valid YAML. This is fine for Copilot.

#### 2b. Command → Prompt Conversion

| Claude Field | Copilot Output | Transformation |
|---|---|---|
| `name` | frontmatter (via filename) | Replace `:` with `-`, replace `_` with `-` |
| `description` | frontmatter `description` | Pass through |
| `argument-hint` | frontmatter `argument-hint` | Pass through |
| `allowed-tools` | frontmatter `tools` | Map tool names via TOOL_MAP (see 2d) |
| (not present) | frontmatter `agent` | Always `"agent"` — hardcoded in template, not a type field |
| `body` | body content | Apply content transformations (see 2c) |

The converter renders the complete `.prompt.md` file content:

```yaml
---
description: Transform feature descriptions into well-structured project plans
argument-hint: Enter the feature description or improvement idea
agent: agent
tools:
  - read
  - edit
  - search
  - execute
  - web
---

# Create a Plan

[transformed body content]
```

#### 2c. Content Transformations (`transformContentForCopilot`)

These regex/string transformations run on all agent and command bodies. Follow the Codex converter's `transformContentForCodex` pattern at `src/converters/claude-to-codex.ts:95-132`.

**Critical transformations:**

```typescript
// 1. Task agent-name(args) → sequential instruction
// Follow Codex pattern: capture leading whitespace/bullet, anchor to line start
/^(\s*-?\s*)Task\s+([a-z][a-z0-9-]*)\(([^)]+)\)/gm
→ "$1Use the **$2** agent to: $3"

// 2. Plugin-namespaced command references
/\/compound-engineering:([\w-]+)/g → "/$1"

// 3. Workflow command references (colon to hyphen)
/\/workflows:([\w-]+)/g → "/workflows-$1"

// 4. $ARGUMENTS placeholder
/\$ARGUMENTS/g → "(the user's input)"

// 5. <thinking> blocks — not supported by non-Claude models
/<thinking>[\s\S]*?<\/thinking>/g → ""

// 6. AskUserQuestion tool references
/AskUserQuestion/g → "ask the user"

// 7. TodoWrite tool references
/TodoWrite/g → "task tracking"

// 8. Skill() tool pattern in allowed-tools body references
/Skill\(([\w-]+)\)/g → "the $1 skill"

// 9. /model directive lines
/^\/model.*$/gm → ""

// 10. EnterPlanMode references
/EnterPlanMode/g → ""

// 11. Parallel dispatch prose rewrite
/Run these agents?\s*\*?\*?in parallel\*?\*?/gi → "Run these agents sequentially"
```

**Explicit passthrough decisions (no transformation needed):**

- `@agent-name` references — Copilot uses the same `@agent-name` syntax natively. Pass through unchanged.
- Bare `/command-name` references (e.g., `/deepen-plan`) — Copilot uses the same `/command-name` syntax for prompt files. Pass through unchanged.

**Extract the parallel-to-sequential block rewriter** into its own function (`rewriteParallelBlocks`). This detects bullet lists of `- Task` calls and rewrites them as numbered sequential steps. Test it with multiple input shapes independently. The rest of the transformations are straightforward `.replace()` chains.

#### 2d. Tool Name Mapping

Normalize to lowercase before lookup (follow OpenCode converter's pattern at `src/converters/claude-to-opencode.ts:378`).

```typescript
const TOOL_MAP: Record<string, string> = {
  "bash": "execute",
  "read": "read",
  "edit": "edit",
  "write": "edit",
  "multiedit": "edit",
  "grep": "search",
  "glob": "search",
  "list": "search",
  "websearch": "web",
  "webfetch": "web",
  "task": "agent",
  "todowrite": "todo",
  "todoread": "todo",
  "question": "agent",       // Interactive questioning handled natively by agent mode
  "notebookread": "read",
  "notebookedit": "edit",
  "patch": "edit",
}
```

For `allowed-tools` with patterns like `Bash(ls:*)`, extract the tool name before the parenthesis, lowercase it, then map. Deduplicate the resulting array.

Default tools array when no `allowed-tools` specified: `["read", "edit", "search", "execute", "web"]`

#### 2e. Skill Conversion

Skills are copied wholesale via `copyDir` — directory + all contents (scripts/, references/, assets/). This is consistent with both existing converters (neither transforms skill content).

The SKILL.md frontmatter is already compatible with Copilot's agent skills format. Only the location changes: source `skills/*/` → target `.github/skills/*/`.

Claude Code-specific syntax may remain in skill bodies. This is acceptable for MVP and consistent with existing converters. Follow-up: add skill content transformation across all targets if needed.

#### 2f. MCP Server Conversion

The writer formats `ClaudeMcpServer` records into `.vscode/mcp.json`:

```typescript
// Input (from ClaudePlugin.mcpServers):
{ "context7": { type: "http", url: "https://mcp.context7.com/mcp" } }

// Output (.vscode/mcp.json):
{
  "servers": {
    "context7": {
      "type": "http",
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

Stdio servers pass through `command`, `args`, `env` fields. HTTP/SSE servers pass through `url`, `headers`.

#### 2g. Instructions Generation

Both files use **hardcoded templates** in the converter that are populated from the `ClaudePlugin` manifest and component lists. This is new functionality (neither Codex nor OpenCode generates these), justified because Copilot's `copilot-instructions.md` and `AGENTS.md` are the primary discovery mechanism for users.

**`copilot-instructions.md` template:**

```markdown
# Compound Engineering

This repository uses the compound-engineering plugin for AI-assisted development.

## Philosophy

Each unit of engineering work should make subsequent work easier — not harder.
Focus 80% on planning and review, 20% on execution.

## Available Tools

- **${agentCount} custom agents** in `.github/agents/` — invoke with @agent-name in chat
- **${promptCount} prompt commands** in `.github/prompts/` — invoke with /command-name in chat
- **${skillCount} skills** in `.github/skills/` — automatically loaded when relevant
- **MCP servers** configured in `.vscode/mcp.json`

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
- Try/catch around all external calls (API, DB, file I/O)
```

Variables (`${agentCount}`, etc.) are populated from the bundle's actual component counts.

**`AGENTS.md` template:**

```markdown
# Compound Engineering Plugin

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

**Just review:** [staged changes] → /workflows-review
```

Tables are populated from the converted agent/prompt/skill lists using names and descriptions.

### Phase 3: Writer

**New file: `src/targets/copilot.ts`**

The writer is trivially simple — the converter has already rendered all content. The writer just creates directories and writes strings to files.

```
writeCopilotBundle(outputRoot, bundle):
  1. Create .github/agents/ — write each agent.content as {agent.name}.agent.md
  2. Create .github/prompts/ — write each prompt.content as {prompt.name}.prompt.md
  3. Create .github/skills/ — copyDir each skillDir.sourceDir to .github/skills/{name}/
  4. Create .vscode/ — render mcpServers to JSON, write mcp.json
  5. Write .github/copilot-instructions.md from bundle.instructions
  6. Write AGENTS.md from bundle.agentsMd at output root
```

No output path resolution needed beyond the existing `resolveOutputRoot` fallback to `process.cwd()`. No special path logic like Codex's `codexHome`.

### Phase 4: Registration & CLI

**Modify: `src/targets/index.ts`**

```typescript
import { convertClaudeToCopilot } from "../converters/claude-to-copilot"
import { writeCopilotBundle } from "./copilot"

export const targets: Record<string, TargetHandler> = {
  opencode: { ... },
  codex: { ... },
  copilot: {
    name: "copilot",
    implemented: true,
    convert: convertClaudeToCopilot,
    write: writeCopilotBundle,
  },
}
```

**Modify: `src/commands/convert.ts`** — Add `copilot` to `--to` help text. No special output path logic needed (unlike Codex which has `codexHome`).

**Modify: `src/commands/install.ts`** — Add `copilot` to `--to` help text. Default output: `process.cwd()`.

## Handling Edge Cases

### 1. Parallel → Sequential (All parallel dispatch commands)

**Affected:** `/workflows:review`, `/workflows:plan`, `/deepen-plan`, `/resolve_parallel`, `/plan_review`

The `rewriteParallelBlocks` function (extracted, independently tested) detects bullet lists of `- Task` calls and rewrites them as numbered sequential steps. Individual `Task` calls are also caught by regex #1.

### 2. Command Chaining (`/lfg`)

The `/lfg` command chains 8 other commands. **Do not inline.** Convert it to a prompt that lists the workflow steps and tells the user to run them sequentially:

```
Run these prompts in sequence:
1. /workflows-plan
2. /deepen-plan
3. /workflows-work
4. /workflows-review
...
```

The `ralph-wiggum:ralph-loop` external dependency is dropped with a comment noting it's from a separate plugin.

### 3. 30,000 Character Prompt Limit

**Deferred.** The converter emits a warning to stderr if any output file exceeds 25,000 characters. Splitting logic is added only after manual testing reveals which files (if any) actually exceed the limit. This avoids premature engineering.

### 4. Agent Subdirectory Flattening

Agents organized in `review/`, `research/`, etc. are placed directly in `.github/agents/`. The agent name already indicates its purpose. Name collisions within the flat directory are unlikely given unique source names; if encountered, the converter logs a warning and appends a numeric suffix.

### 5. `<thinking>` Tags

Removed entirely by regex #5. Claude-specific; other LLMs render them as literal text.

### 6. Description Sanitization

Agent descriptions containing `<example>`/`<commentary>` XML:
1. Extract text before the first `<example>` tag as the concise frontmatter description
2. Clean the examples (strip XML tags, convert to markdown)
3. Move cleaned examples into the agent body under "## When to Use This Agent"

### 7. Hooks

Intentionally dropped. Copilot has no equivalent of Claude Code's lifecycle hooks (`PreToolUse`, `PostToolUse`, etc.). This is consistent with the Codex converter's approach.

## Acceptance Criteria

### Functional Requirements

- [x] `bunx @every-env/compound-plugin convert ./plugins/compound-engineering --to copilot` produces valid output
- [x] All agents produce valid `.agent.md` files with correct YAML frontmatter
- [x] All commands produce valid `.prompt.md` files with correct YAML frontmatter
- [x] All skills are copied to `.github/skills/` with directory structure intact
- [x] MCP server config produces valid `.vscode/mcp.json`
- [x] `copilot-instructions.md` and `AGENTS.md` are generated with correct component counts
- [x] No Claude Code-specific syntax remains in agent/prompt output (`Task `, `$ARGUMENTS`, `<thinking>`, `/compound-engineering:`, `EnterPlanMode`)
- [x] All `tools` arrays use Copilot-compatible names (`read`, `edit`, `search`, `execute`, `web`, `agent`, `todo`)
- [x] Parallel dispatch blocks are converted to sequential numbered steps
- [x] Agent descriptions are plain text (no XML tags)
- [x] `model` field is omitted from all output frontmatter
- [x] Command names with `:` or `_` are normalized to `-`
- [x] Warning emitted for any output file exceeding 25,000 characters

### Quality Gates

- [x] All tests pass (`bun test`)
- [ ] Generated `.agent.md` files load in VS Code Copilot agent picker (manual verification)
- [ ] Generated `.prompt.md` files appear as `/slash-commands` in Copilot Chat (manual verification)
- [ ] Generated skills are discoverable by Copilot (manual verification)
- [ ] MCP server connects successfully (manual verification)

## Test Requirements

Following the existing test patterns (`tests/codex-converter.test.ts`, `tests/converter.test.ts`), use inline fixture `ClaudePlugin` objects:

**Converter tests (`tests/copilot-converter.test.ts`):**
1. Basic agent conversion — frontmatter fields, description sanitization, body passthrough
2. Agent with XML `<example>` description — verify XML stripped from description, moved to body
3. Command → prompt conversion — name normalization (`:` → `-`, `_` → `-`)
4. Tool mapping — `allowed-tools` with patterns like `Bash(ls:*)` mapped to Copilot names, case-insensitive
5. Tool mapping deduplication — `["Read", "Grep", "Glob"]` → `["read", "search"]` (not `["read", "search", "search"]`)
6. Content transformation: `Task` calls → sequential instructions (anchored to line start, preserves prefix)
7. Content transformation: `<thinking>` block removal
8. Content transformation: `$ARGUMENTS` replacement
9. Content transformation: `/compound-engineering:` namespace stripping
10. Content transformation: `/workflows:` colon-to-hyphen
11. Content transformation: parallel dispatch block rewriting (multiple input shapes)
12. `@agent-name` references pass through unchanged
13. Bare `/command-name` references pass through unchanged
14. MCP server passthrough (`ClaudeMcpServer` → `.vscode/mcp.json` structure)
15. Skill directory passthrough
16. Instructions generation with correct component counts
17. AGENTS.md generation with agent/prompt/skill tables
18. Model field omitted from all output
19. Hooks dropped (not present in bundle)

**Writer tests (`tests/copilot-writer.test.ts`):**
1. Output directory structure verification (`.github/agents/`, `.github/prompts/`, `.github/skills/`, `.vscode/`)
2. Agent files written as `{name}.agent.md`
3. Prompt files written as `{name}.prompt.md`
4. Skill directories copied wholesale
5. `mcp.json` written with correct JSON structure
6. `copilot-instructions.md` written to `.github/`
7. `AGENTS.md` written to output root

## Files to Create

| File | Purpose |
|------|---------|
| `docs/specs/github-copilot.md` | Copilot target format specification |
| `src/types/copilot.ts` | CopilotBundle type definitions (~30 lines) |
| `src/converters/claude-to-copilot.ts` | Converter logic + content transformations (~250 lines) |
| `src/targets/copilot.ts` | File writer for `.github/` structure (~60 lines) |
| `tests/copilot-converter.test.ts` | Converter unit tests (19 test cases) |
| `tests/copilot-writer.test.ts` | Writer output tests (7 test cases) |

## Files to Modify

| File | Change |
|------|--------|
| `src/targets/index.ts` | Register `copilot` target handler (~4 lines) |
| `src/commands/convert.ts` | Add `copilot` to `--to` help text |
| `src/commands/install.ts` | Add `copilot` to `--to` help text |
| `README.md` | Document `--to copilot` usage |
| `plugins/compound-engineering/CHANGELOG.md` | Document the addition |

## Dependencies & Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| No parallel execution in Copilot | HIGH | Sequential fallback (accepted by user). Document perf impact. |
| 30k char prompt limit | MEDIUM | Warn at 25k; defer splitting to iteration 2 after testing |
| External plugin dep (`ralph-wiggum`) | LOW | Drop with comment in output |
| Copilot prompt file format may change (public preview) | MEDIUM | Pin to documented spec; monitor updates |

## Follow-Up Work (Not in Scope)

- **Shared transformation module** — `transformContentForCodex` and `transformContentForCopilot` share patterns (Task calls, slash commands). Extract common transformations into `src/utils/content-transforms.ts`. Flag for follow-up, do not block this PR.
- **Skill content transformation** — Apply content transforms to SKILL.md bodies across all targets. Currently no converter does this.
- **30k character splitting** — If testing reveals files exceeding the limit, add splitting logic using `.github/instructions/` files with `applyTo` globs.

## References

### Internal
- Existing converters: `src/converters/claude-to-codex.ts`, `src/converters/claude-to-opencode.ts`
- Target registration: `src/targets/index.ts`
- Type definitions: `src/types/codex.ts`, `src/types/opencode.ts`
- Parser: `src/parsers/claude.ts`
- Frontmatter utility: `src/utils/frontmatter.ts`
- Test patterns: `tests/codex-converter.test.ts`, `tests/converter.test.ts`

### External
- [VS Code Custom Agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [VS Code Prompt Files](https://code.visualstudio.com/docs/copilot/customization/prompt-files)
- [VS Code Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [VS Code MCP Servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [GitHub Custom Agent Configuration Reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [VS Code Custom Instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
