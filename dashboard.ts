#!/usr/bin/env bun
/**
 * lb dashboard — local HTTP server that serves a live agent dashboard.
 *
 * Usage: bun run dashboard.ts [--port 3333]
 *
 * Serves a single HTML page that polls /api/state every 3 seconds.
 * The API shells out to `lb list --json` and probes running agent ports.
 */

const DASHBOARD_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "3333", 10)

async function getLbState(): Promise<any[]> {
  try {
    const proc = Bun.spawn(["lb", "list", "--json"], { stdout: "pipe", stderr: "pipe" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return JSON.parse(text.trim())
  } catch {
    return []
  }
}

async function probeAgent(port: number, sessionId: string): Promise<{ status: string; messageCount: number; lastMessage: string | null }> {
  try {
    const resp = await fetch(`http://localhost:${port}/session/${sessionId}/message`, { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) return { status: "unreachable", messageCount: 0, lastMessage: null }
    const messages = (await resp.json()) as any[]
    if (messages.length === 0) return { status: "idle", messageCount: 0, lastMessage: null }

    const last = messages[messages.length - 1]
    const role = last?.info?.role || last?.role
    const msgStatus = last?.info?.status || last?.status
    const parts = last?.parts || last?.info?.parts || []
    const lastText = parts.find((p: any) => p.type === "text")?.text?.slice(0, 200) ?? null

    let status = "idle"
    if (role === "assistant" && (msgStatus === "completed" || msgStatus === "done")) status = "finished"
    else if (role === "assistant" && msgStatus === "streaming") status = "running"
    else if (role === "user") status = "running"

    return { status, messageCount: messages.length, lastMessage: lastText }
  } catch {
    return { status: "unreachable", messageCount: 0, lastMessage: null }
  }
}

function parseAgentMeta(desc: string): { port: number; tmux: string; session: string } | null {
  const portMatch = desc.match(/Port:\s*(\d+)/)
  const tmuxMatch = desc.match(/tmux:\s*(\S+?)(?:,|$)/)
  const sessionMatch = desc.match(/session:\s*(\S+?)(?:,|$)/)
  if (portMatch && tmuxMatch && sessionMatch) {
    return {
      port: parseInt(portMatch[1], 10),
      tmux: tmuxMatch[1],
      session: sessionMatch[1],
    }
  }
  return null
}

async function buildState() {
  const issues = await getLbState()
  const enriched = await Promise.all(
    issues.map(async (issue) => {
      const meta = parseAgentMeta(issue.description || "")
      let agent = null
      if (meta && issue.status === "in_progress") {
        agent = {
          ...meta,
          ...(await probeAgent(meta.port, meta.session)),
        }
      }
      return { ...issue, agent }
    })
  )
  return enriched
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lb dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
    background: #0a0a0a;
    color: #e0e0e0;
    padding: 24px;
    min-height: 100vh;
  }
  h1 {
    font-size: 14px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 2px;
    margin-bottom: 24px;
  }
  .meta {
    font-size: 11px;
    color: #444;
    margin-bottom: 20px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: 12px;
  }
  .card {
    background: #111;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 16px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: #333; }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .issue-id {
    font-size: 13px;
    font-weight: 700;
    color: #fff;
  }
  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge.in_progress { background: #1a3a2a; color: #4ade80; }
  .badge.in_review { background: #1a2a3a; color: #60a5fa; }
  .badge.done { background: #1a1a2a; color: #888; }
  .badge.todo_refined { background: #2a2a1a; color: #facc15; }
  .badge.todo_needs_refinement { background: #2a1a1a; color: #f87171; }
  .badge.todo_bug { background: #2a1a1a; color: #fb923c; }
  .title {
    font-size: 12px;
    color: #aaa;
    margin-bottom: 8px;
    line-height: 1.4;
  }
  .agent-status {
    font-size: 11px;
    padding: 8px 10px;
    background: #0a0f0a;
    border: 1px solid #1a2a1a;
    border-radius: 4px;
    margin-top: 8px;
  }
  .agent-status .label { color: #666; }
  .agent-status .value { color: #4ade80; }
  .agent-status .value.running { color: #facc15; }
  .agent-status .value.finished { color: #60a5fa; }
  .agent-status .value.unreachable { color: #f87171; }
  .agent-status .value.idle { color: #888; }
  .last-msg {
    font-size: 10px;
    color: #555;
    margin-top: 6px;
    line-height: 1.3;
    max-height: 40px;
    overflow: hidden;
  }
  .time {
    font-size: 10px;
    color: #444;
    margin-top: 6px;
  }
  .section-label {
    font-size: 11px;
    font-weight: 600;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 24px 0 12px;
  }
  .pulse {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 6px;
    animation: pulse 2s infinite;
  }
  .pulse.live { background: #4ade80; }
  .pulse.working { background: #facc15; }
  .pulse.dead { background: #f87171; animation: none; }
  .pulse.off { background: #333; animation: none; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .empty {
    color: #333;
    font-size: 12px;
    padding: 40px;
    text-align: center;
  }
  .counts {
    display: flex;
    gap: 16px;
    margin-bottom: 20px;
  }
  .count-box {
    padding: 12px 16px;
    background: #111;
    border: 1px solid #222;
    border-radius: 6px;
    text-align: center;
    min-width: 80px;
  }
  .count-box .num {
    font-size: 24px;
    font-weight: 700;
    color: #fff;
  }
  .count-box .lbl {
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-top: 2px;
  }
</style>
</head>
<body>
<h1>lb agent dashboard</h1>
<div class="meta" id="meta">loading...</div>
<div class="counts" id="counts"></div>
<div id="sections"></div>

<script>
const STATUS_ORDER = ['in_progress', 'in_review', 'todo_refined', 'todo_bug', 'todo_needs_refinement', 'done']
const STATUS_LABELS = {
  in_progress: 'In Progress',
  in_review: 'In Review',
  todo_refined: 'Ready',
  todo_bug: 'Bug',
  todo_needs_refinement: 'Needs Refinement',
  done: 'Done'
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + 'm ago'
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + 'h ago'
  return Math.floor(hrs / 24) + 'd ago'
}

function pulseClass(agent) {
  if (!agent) return 'off'
  if (agent.status === 'running') return 'working'
  if (agent.status === 'finished' || agent.status === 'idle') return 'live'
  return 'dead'
}

function renderCard(issue) {
  const a = issue.agent
  let agentHtml = ''
  if (a) {
    agentHtml = \`
      <div class="agent-status">
        <span class="pulse \${pulseClass(a)}"></span>
        <span class="label">status:</span> <span class="value \${a.status}">\${a.status}</span>
        &nbsp;&middot;&nbsp;
        <span class="label">port:</span> <span class="value">\${a.port}</span>
        &nbsp;&middot;&nbsp;
        <span class="label">msgs:</span> <span class="value">\${a.messageCount}</span>
        \${a.lastMessage ? '<div class="last-msg">' + escHtml(a.lastMessage) + '</div>' : ''}
      </div>
    \`
  }
  return \`
    <div class="card">
      <div class="card-header">
        <span class="issue-id">\${a ? '<span class="pulse ' + pulseClass(a) + '"></span>' : ''}\${issue.id}</span>
        <span class="badge \${issue.status}">\${issue.status.replace(/_/g, ' ')}</span>
      </div>
      <div class="title">\${escHtml(issue.title)}</div>
      \${agentHtml}
      <div class="time">updated \${timeAgo(issue.updated_at)}</div>
    </div>
  \`
}

function escHtml(s) {
  if (!s) return ''
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

async function refresh() {
  try {
    const resp = await fetch('/api/state')
    const issues = await resp.json()

    // Counts
    const counts = {}
    issues.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1 })
    const activeAgents = issues.filter(i => i.agent && i.agent.status !== 'unreachable').length
    document.getElementById('counts').innerHTML =
      '<div class="count-box"><div class="num">' + activeAgents + '</div><div class="lbl">Active Agents</div></div>' +
      '<div class="count-box"><div class="num">' + (counts.in_progress || 0) + '</div><div class="lbl">In Progress</div></div>' +
      '<div class="count-box"><div class="num">' + (counts.in_review || 0) + '</div><div class="lbl">In Review</div></div>' +
      '<div class="count-box"><div class="num">' + (counts.todo_refined || 0) + '</div><div class="lbl">Ready</div></div>' +
      '<div class="count-box"><div class="num">' + (counts.done || 0) + '</div><div class="lbl">Done</div></div>'

    // Group by status
    const grouped = {}
    issues.forEach(i => {
      if (!grouped[i.status]) grouped[i.status] = []
      grouped[i.status].push(i)
    })

    let html = ''
    STATUS_ORDER.forEach(status => {
      const items = grouped[status]
      if (!items || items.length === 0) return
      html += '<div class="section-label">' + (STATUS_LABELS[status] || status) + ' (' + items.length + ')</div>'
      html += '<div class="grid">'
      items.forEach(i => { html += renderCard(i) })
      html += '</div>'
    })

    if (!html) html = '<div class="empty">No issues found. Run lb create to get started.</div>'
    document.getElementById('sections').innerHTML = html
    document.getElementById('meta').textContent = 'Last updated: ' + new Date().toLocaleTimeString() + ' \u00b7 polling every 3s'
  } catch (e) {
    document.getElementById('meta').textContent = 'Error: ' + e.message
  }
}

refresh()
setInterval(refresh, 3000)
</script>
</body>
</html>`

Bun.serve({
  port: DASHBOARD_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/api/state") {
      const state = await buildState()
      return new Response(JSON.stringify(state), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      })
    }

    return new Response(HTML, {
      headers: { "Content-Type": "text/html" },
    })
  },
})

console.log(`lb dashboard running at http://localhost:${DASHBOARD_PORT}`)
