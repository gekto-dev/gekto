import { WebSocket, WebSocketServer } from 'ws'
import type { Server } from 'http'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import * as pty from 'node-pty'
import * as os from 'node:os'
import { getPostHog, getDistinctId } from './posthog.js'

interface TerminalSession {
  pty: pty.IPty | null
  ws: WebSocket
  cols: number
  rows: number
}

const sessions = new Map<WebSocket, TerminalSession>()

export function setupTerminalWebSocket(server: Server, path: string = '/__gekto/terminal') {
  const wss = new WebSocketServer({ noServer: true })

  // Handle WebSocket upgrade for terminal path
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url || ''

    if (url === path || url.startsWith(path + '?')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    }
    // Other upgrade requests (like Vite HMR) are handled elsewhere
  })

  wss.on('connection', (ws: WebSocket) => {
    getPostHog().capture({
      distinctId: getDistinctId(),
      event: 'terminal session started',
    })

    // Create session but don't spawn PTY yet - wait for resize
    const session: TerminalSession = {
      pty: null,
      ws,
      cols: 80,
      rows: 24,
    }
    sessions.set(ws, session)

    const spawnShell = () => {
      if (session.pty) return // Already spawned

      try {
        const shell = process.env.SHELL || '/bin/bash'
        const isZsh = shell.endsWith('zsh')
        // For zsh: pass -c to run unsetopt first, then exec interactive shell
        const args = isZsh ? ['-c', 'unsetopt PROMPT_SP PROMPT_CR; exec zsh -i'] : []
        const ptyProcess = pty.spawn(shell, args, {
          name: 'xterm-256color',
          cols: session.cols,
          rows: session.rows,
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERM: 'xterm',
            COLUMNS: String(session.cols),
            LINES: String(session.rows),
          } as Record<string, string>,
        })

        session.pty = ptyProcess

        // PTY output → WebSocket
        ptyProcess.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data }))
          }
        })

        ptyProcess.onExit(({ exitCode }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
            ws.close()
          }
          sessions.delete(ws)
        })

      } catch (err) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Failed to start terminal: ${err}`
        }))
        ws.close()
      }
    }

    // WebSocket → PTY
    ws.on('message', (message: Buffer | string) => {
      try {
        const msg = JSON.parse(message.toString())

        switch (msg.type) {
          case 'input':
            session.pty?.write(msg.data)
            break
          case 'resize':
            if (msg.cols && msg.rows) {
              session.cols = msg.cols
              session.rows = msg.rows
              if (session.pty) {
                session.pty.resize(msg.cols, msg.rows)
              } else {
                // First resize - spawn the shell now
                spawnShell()
              }
            }
            break
        }
      } catch {
        // If not JSON, treat as raw input
        session.pty?.write(message.toString())
      }
    })

    ws.on('close', () => {
      session.pty?.kill()
      sessions.delete(ws)
    })

    ws.on('error', () => {
      session.pty?.kill()
      sessions.delete(ws)
    })
  })

  return wss
}
