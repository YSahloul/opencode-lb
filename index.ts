/**
 * opencode-lb — OpenCode plugin for linear-beads orchestration
 *
 * Gives the orchestrator agent tools to manage background worktree agents
 * and hooks to react to lifecycle events (completion, compaction, errors).
 */

import { type Plugin, tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { AgentRegistry } from "./registry"
import {
  dispatch,
  checkAgent,
  followupAgent,
  abortAgent,
  cleanupAgent,
  listAgents,
  reconstructRegistry,
} from "./orchestrator"
import { LB_GUIDANCE, getLbContext } from "./context"
import { COMMANDS, AGENT_CONFIG } from "./commands"
import { LifecycleEmitter } from "./lifecycle"
export type { LifecycleEmitter, LifecycleEventType, LifecyclePayload, LifecycleHandler } from "./lifecycle"

type OpencodeClient = PluginInput["client"]

export const LbPlugin: Plugin = async ({ client, $ }) => {
  const registry = new AgentRegistry()
  const emitter = new LifecycleEmitter()

  // ── Default toast handlers ──────────────────────────────────────────────
  emitter.on("agent:claimed", async ({ issueId }) => {
    await client.tui.showToast({
      body: {
        title: `${issueId} claimed`,
        message: "Background agent starting…",
        variant: "info",
        duration: 4000,
      },
    })
  })

  emitter.on("agent:running", async ({ issueId, branch }) => {
    await client.tui.showToast({
      body: {
        title: `${issueId} running`,
        message: `Agent is live on branch ${branch ?? issueId}.`,
        variant: "success",
        duration: 4000,
      },
    })
  })

  emitter.on("agent:finished", async ({ issueId }) => {
    await client.tui.showToast({
      body: {
        title: `${issueId} finished`,
        message: "Background agent done. Run lb_check or lb_cleanup.",
        variant: "success",
        duration: 6000,
      },
    })
  })

  emitter.on("agent:errored", async ({ issueId, error }) => {
    await client.tui.showToast({
      body: {
        title: `${issueId} errored`,
        message: error ?? "Agent unreachable or crashed.",
        variant: "error",
        duration: 8000,
      },
    })
  })

  emitter.on("agent:aborted", async ({ issueId }) => {
    await client.tui.showToast({
      body: {
        title: `${issueId} aborted`,
        message: "Agent operation aborted.",
        variant: "warning",
        duration: 5000,
      },
    })
  })

  emitter.on("agent:closed", async ({ issueId }) => {
    await client.tui.showToast({
      body: {
        title: `${issueId} closed`,
        message: "Issue marked done.",
        variant: "success",
        duration: 4000,
      },
    })
  })

  // Reconstruct state from tmux + lb on startup
  await reconstructRegistry($, registry)

  const injectedSessions = new Set<string>()

  return {
    // ── Tools ──────────────────────────────────────────────────────────
    tool: {
      lb_dispatch: tool({
        description:
          "Dispatch an lb issue to a background worktree agent. Creates worktree, launches opencode serve in tmux, creates session, sends the task prompt. Returns agent metadata (port, sessionId, tmux, branch).",
        args: {
          issueId: tool.schema.string().describe("Linear issue ID (e.g. AGE-42)"),
          prompt: tool.schema.string().describe("Task prompt to send to the background agent"),
          model: tool.schema
            .string()
            .optional()
            .describe("Model ID (default: claude-sonnet-4-6)"),
          provider: tool.schema
            .string()
            .optional()
            .describe("Provider ID (default: anthropic)"),
          slug: tool.schema
            .string()
            .optional()
            .describe("Short slug for branch name (default: derived from issue title)"),
          skipWorktree: tool.schema
            .boolean()
            .optional()
            .describe("Skip worktree creation and run in repo root (for read-only tasks)"),
        },
        async execute(args) {
          return await dispatch($, registry, emitter, args)
        },
      }),

      lb_check: tool({
        description:
          "Check on a background worktree agent. Returns recent messages showing what it's doing.",
        args: {
          issueId: tool.schema.string().describe("Linear issue ID (e.g. AGE-42)"),
          lines: tool.schema
            .number()
            .optional()
            .describe("Number of recent messages to fetch (default: 10)"),
        },
        async execute(args) {
          return await checkAgent($, registry, args.issueId, args.lines)
        },
      }),

      lb_followup: tool({
        description:
          "Send a follow-up message to a running background agent.",
        args: {
          issueId: tool.schema.string().describe("Linear issue ID"),
          message: tool.schema.string().describe("Follow-up instructions to send"),
        },
        async execute(args) {
          return await followupAgent($, registry, args.issueId, args.message)
        },
      }),

      lb_abort: tool({
        description:
          "Abort a background agent's current operation. Server stays running for new messages.",
        args: {
          issueId: tool.schema.string().describe("Linear issue ID"),
        },
        async execute(args) {
          return await abortAgent($, registry, emitter, args.issueId)
        },
      }),

      lb_cleanup: tool({
        description:
          "Clean up a background agent: kill tmux session, delete worktree, update lb status.",
        args: {
          issueId: tool.schema.string().describe("Linear issue ID"),
          status: tool.schema
            .enum(["in_review", "todo_refined", "done"])
            .optional()
            .describe("Status to set on the issue (default: in_review)"),
          force: tool.schema
            .boolean()
            .optional()
            .describe("Force delete worktree without safety checks"),
        },
        async execute(args) {
          return await cleanupAgent($, registry, emitter, args.issueId, args.status, args.force)
        },
      }),

      lb_agents: tool({
        description:
          "List all running background agents with their status, port, session, and branch.",
        args: {},
        async execute() {
          return await listAgents($, registry)
        },
      }),
    },

    // ── Hooks ──────────────────────────────────────────────────────────

    // Inject lb context on first message in a session
    "chat.message": async (_input, output) => {
      const sessionID = output.message.sessionID
      if (injectedSessions.has(sessionID)) return
      injectedSessions.add(sessionID)

      const context = await getLbContext($, registry)
      if (!context) return

      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            model: output.message.model,
            agent: output.message.agent,
            parts: [
              {
                type: "text",
                text: `${context}\n\n${LB_GUIDANCE}`,
                synthetic: true,
              },
            ],
          },
        })
      } catch {
        // Silent — TUI may not be available
      }
    },

    // React to lifecycle events
    event: async ({ event }) => {
      // Re-inject context after compaction
      if (event.type === "session.compacted") {
        const sessionID = event.properties.sessionID
        const context = await getLbContext($, registry)
        if (!context) return

        try {
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: `${context}\n\n${LB_GUIDANCE}`,
                  synthetic: true,
                },
              ],
            },
          })
        } catch {}
      }

      // On session idle, poll background agents and sync
      if (event.type === "session.idle") {
        await pollBackgroundAgents($, client, registry, emitter)
      }
    },

    // Register commands and agent
    config: async (config) => {
      config.command = { ...config.command, ...COMMANDS }
      config.agent = { ...config.agent, ...AGENT_CONFIG }
    },
  }
}

/**
 * Poll all tracked background agents. Emit lifecycle events on state changes.
 */
async function pollBackgroundAgents(
  $: PluginInput["$"],
  _client: OpencodeClient,
  registry: AgentRegistry,
  emitter: LifecycleEmitter,
) {
  for (const [issueId, agent] of registry.entries()) {
    try {
      const resp = await fetch(
        `http://localhost:${agent.port}/session/${agent.sessionId}/status`,
      )
      if (!resp.ok) {
        // Non-OK response — agent may be errored
        await emitter.emit("agent:errored", {
          issueId,
          branch: agent.branch,
          port: agent.port,
          error: `HTTP ${resp.status} from agent status endpoint`,
        })
        continue
      }
      const status = await resp.json()

      // Check if agent session is idle (done working)
      if (status?.status === "idle" || status?.idle === true) {
        await emitter.emit("agent:finished", {
          issueId,
          branch: agent.branch,
          port: agent.port,
        })
      }
    } catch {
      // Agent not reachable — may have been cleaned up externally
      await emitter.emit("agent:errored", {
        issueId,
        branch: agent.branch,
        port: agent.port,
        error: "Agent unreachable — may have been cleaned up externally",
      })
    }
  }

  // Sync lb quietly
  try {
    await $`lb sync`.quiet()
  } catch {}
}
