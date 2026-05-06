# Gekto

[![Discord](https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/RDcWJJKE)

Visual orchestrator for coding agents. Run many agents in parallel on an infinite canvas, plan work visually, and ship faster.

---

## What is Gekto

Gekto is a local-first canvas UI that sits on top of coding agents like Claude Code. Instead of driving one agent at a time from a terminal, you orchestrate a swarm — drafting plans, splitting work across agents, watching diffs land, and shipping in bulk. Run `npx gekto` in any project and a browser canvas opens with your repo wired in.

## Features

- **Infinite canvas** — every agent, plan, and task lives on a single tldraw-powered canvas you can pan and zoom forever.
- **Parallel execution** — spin up 10+ agents at once. Conflicts are resolved automatically as work merges back.
- **Plan-driven development** — draft a plan, iterate on it, then dispatch it. Plans become the source of truth for every agent.
- **Planner agent** — a dedicated agent that turns a goal into a structured, reviewable plan you can edit before running.
- **Seamless delegation** — Gekto picks the right agent for each task and feeds it the plan's context automatically.
- **Diff & revert** — every edit is captured. Review diffs inline, revert any change at any time, never lose work.
- **In-browser terminal** — full PTY shell (Ctrl+C, arrow keys, colors) injected into your app via proxy.
- **Local & private** — chats, plans, and history are persisted on your machine. Nothing ships to a backend.

## Supported Agents

| Agent | Status |
| --- | --- |
| Claude Code | Available |
| OpenAI Codex | Coming soon |
| Gemini CLI | Coming soon |
| Cursor Agent | Coming soon |

## Getting Started

### Requirements

- **Node.js 18+** (recommended: 20 or 22) — `node-pty` requires native build tools
- **[Bun](https://bun.sh)** — used for the dev workflow
- macOS: `xcode-select --install` · Linux: `apt install build-essential` · Windows: Visual Studio Build Tools

### Run locally

```bash
# Clone
git clone git@github.com:gekto-dev/gekto.git
cd gekto

# Install workspace deps (test-app, widget, server)
bun install
cd test-app && bun install && cd ..
cd widget && bun install && cd ..
cd server && bun install && cd ..

# Start everything: test-app (5173) + widget dev + proxy (3200)
bun run dev
```

Open `http://localhost:3200` — the test app loads with the Gekto widget injected.

### Individual processes

```bash
bun run dev:test-app    # demo app on :5173
bun run dev:widget      # widget vite dev server
bun run dev:proxy       # proxy + widget injection on :3200
```

### Build & preview

```bash
bun run build    # build widget + server
bun run preview  # build, then run test-app + proxy against the build
bun run bundle   # produce a publishable bundle
```

## Team

- [Alex](https://x.com/justalexagain)
- [Stan](https://x.com/stankungurov)

## License

MIT
