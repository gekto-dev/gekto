// ServerStateProvider — establishes WebSocket connection and provides server state
// Must be the outermost provider in the component tree.

import { type ReactNode } from 'react'
import { useServerState } from '../hooks/useServerState'

// Create a context-like global so useServerState can be called from hooks
// that aren't inside this provider. The actual WS connection is managed
// by the useServerState hook's internal useEffect.

interface ServerStateProviderProps {
  children: ReactNode
}

export function ServerStateProvider({ children }: ServerStateProviderProps) {
  // This call establishes the WebSocket connection and starts
  // receiving state_snapshot and typed action messages.
  useServerState()

  return <>{children}</>
}
