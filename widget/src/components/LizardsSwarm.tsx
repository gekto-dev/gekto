import { SwarmProvider, useSwarm, useSelectionRect } from '../context/SwarmContext'
import { GektoProvider } from '../context/GektoContext'
import { SelectionOverlay } from './SelectionOverlay'
import { Lizard, LIZARD_SIZE } from './Lizard'
import { MasterLizard } from './MasterLizard'
import { WhiteboardCurtain } from './whiteboard'
import { useStore } from '../store/store'

function SelectionRectOverlay() {
  const rect = useSelectionRect()
  return <SelectionOverlay rect={rect} />
}

function LizardsList() {
  // Get agents from global store
  const agents = useStore((s) => s.agents)
  const { visuals } = useSwarm()

  return (
    <>
      {Object.values(agents).filter(a => a.id !== 'master').map(agent => {
        const visual = visuals[agent.id]
        if (!visual) return null // Visual not yet created

        return (
          <Lizard
            key={agent.id}
            agentId={agent.id}
          />
        )
      })}
    </>
  )
}

function SwarmContent() {
  return (
    <GektoProvider>
      <WhiteboardCurtain />
      <MasterLizard />
      <LizardsList />
      <SelectionRectOverlay />
    </GektoProvider>
  )
}

export function LizardsSwarm() {
  return (
    <SwarmProvider>
      <SwarmContent />
    </SwarmProvider>
  )
}

export { LIZARD_SIZE }
