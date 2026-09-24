import type { DepInfo } from '../hooks/useDependencies'
import { DEPENDENCY_LABEL } from '../repo'

/**
 * Nothing when everything waited on has landed. Red only when the schedule
 * says it will not land in time, or says nothing at all.
 */
export function DepChip({ info, long = false }: { info: DepInfo | null; long?: boolean }) {
  if (!info || info.open === 0) return null
  const warn = info.state === 'late' || info.state === 'unscheduled'
  return (
    <span className={`chip${warn ? ' warn' : ''}`} style={{ padding: '0 7px' }} title={info.detail}>
      waits on {info.open}{long ? ` · ${DEPENDENCY_LABEL[info.state].toLowerCase()}` : ''}
    </span>
  )
}
