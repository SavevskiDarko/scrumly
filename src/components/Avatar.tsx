import type { Person } from '../db/types'
import { useDarkMode } from '../hooks/useDarkMode'

const PALETTE = [
  ['#DCE6F7', '#26457E'], ['#E2EEE3', '#2A5B3A'], ['#F6E6DC', '#7C4A25'],
  ['#EDE2F2', '#5A3573'], ['#DDEDF0', '#1F5560'], ['#F3E5E9', '#7A3049'],
  ['#E9EAD9', '#4F5622'], ['#E4E6EC', '#39405A'],
]
const PALETTE_DARK = [
  ['#24334F', '#B7CBF0'], ['#22392B', '#9CCBA8'], ['#3E2F24', '#E0B591'],
  ['#332740', '#C4A8D9'], ['#1E3940', '#9AC9D2'], ['#3B2530', '#DFA6B6'],
  ['#343722', '#C6CD93'], ['#2A2E3D', '#B3B9CD'],
]

export function Avatar({
  person, size = 24, dim = false,
}: { person?: Pick<Person, 'initials' | 'colorSeed' | 'name'> | null; size?: number; dim?: boolean }) {
  const dark = useDarkMode()
  const style: React.CSSProperties = {
    width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)),
    opacity: dim ? 0.55 : 1,
  }
  if (!person) {
    return <span className="avatar ghost" style={style} aria-label="Unassigned" title="Unassigned" />
  }
  const set = dark ? PALETTE_DARK : PALETTE
  const [bg, fg] = set[person.colorSeed % set.length]
  return (
    <span className="avatar" style={{ ...style, background: bg, color: fg }} title={person.name} aria-label={person.name}>
      {person.initials}
    </span>
  )
}
