<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Gekto server (`server/`). A singleton client module at `server/src/posthog.ts` initializes `posthog-node` using environment variables and manages a persistent distinct ID (resolved from the user's onboarding email, or a persisted install UUID in `.gekto-install-id`). This session added three new events — `terminal session started`, `all agents killed`, and `all agents cleared` — covering the remaining untracked user actions in `server/src/terminal.ts` and `server/src/agents/agentWebSocket.ts`. Error tracking via `captureException` is wired to both `uncaughtException` and `unhandledRejection` process handlers in `server/src/proxy.ts`.

| Event name | Description | File |
|---|---|---|
| `onboarding completed` | User completed initial setup (project type, port, email) | `server/src/proxy.ts` |
| `proxy started` | Gekto proxy server started and listening | `server/src/proxy.ts` |
| `gekto message sent` | User sent a message to the Gekto AI planning assistant | `server/src/agents/agentWebSocket.ts` |
| `plan created` | Gekto AI created or updated an execution plan | `server/src/agents/agentWebSocket.ts` |
| `plan tasks generated` | Task breakdown generated for a plan | `server/src/agents/agentWebSocket.ts` |
| `plan executed` | User triggered execution of a plan | `server/src/agents/agentWebSocket.ts` |
| `plan canceled` | User canceled an in-progress plan | `server/src/agents/agentWebSocket.ts` |
| `task started` | An agent started processing a coding task | `server/src/agents/agentWebSocket.ts` |
| `task completed` | An agent completed a coding task successfully | `server/src/agents/agentWebSocket.ts` |
| `task failed` | An agent failed to complete a coding task | `server/src/agents/agentWebSocket.ts` |
| `agent message sent` | User sent a message directly to a lizard coding agent | `server/src/agents/agentWebSocket.ts` |
| `agent reset` | User reset an agent's conversation history | `server/src/agents/agentWebSocket.ts` |
| `files reverted` | User reverted file changes made by an agent | `server/src/agents/agentWebSocket.ts` |
| `terminal session started` | User opened an embedded terminal session | `server/src/terminal.ts` |
| `all agents killed` | User stopped all running agent processes at once | `server/src/agents/agentWebSocket.ts` |
| `all agents cleared` | User cleared all worker agents from the canvas and state | `server/src/agents/agentWebSocket.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard — Analytics basics**: https://us.posthog.com/project/399377/dashboard/1514519
- **Daily Active Users** (trend): https://us.posthog.com/project/399377/insights/M2PSGinw
- **Onboarding Conversion Funnel** (funnel): https://us.posthog.com/project/399377/insights/THjqXViA
- **Plan Execution vs Cancellation** (trend): https://us.posthog.com/project/399377/insights/r7PKnICa
- **Task Success vs Failure Rate** (trend): https://us.posthog.com/project/399377/insights/mWLsy83i
- **Feature Engagement Overview** (trend): https://us.posthog.com/project/399377/insights/u3oyKUOe

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
