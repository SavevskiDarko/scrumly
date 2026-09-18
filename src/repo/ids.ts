let counter = 0
/** Time-ordered, collision-resistant enough for a single-user database. */
export function newId(): string {
  counter = (counter + 1) % 4096
  return (
    Date.now().toString(36) +
    counter.toString(36).padStart(3, '0') +
    Math.random().toString(36).slice(2, 7)
  )
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
