import { Fragment } from 'react'
import { setParam } from '../hooks/useRoute'

/*
 * Just enough Markdown for what the assistant writes: paragraphs, headings,
 * lists, tables, quotes, code, bold, italics and links — and task keys, which
 * open the task. Written here rather than pulled in, for the same reason as
 * the command palette: it is short, and a parser library would be most of the
 * panel's weight.
 */

/** Task key -> task id, for the keys that exist. Anything else stays plain text. */
export type KeyLinks = ReadonlyMap<string, string>

export const KEY_PATTERN = /\b[A-Z][A-Z0-9]{0,9}-\d+\b/g

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s\n][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\b[A-Z][A-Z0-9]{0,9}-\d+\b)/g

export function Inline({ text, keys }: { text: string; keys: KeyLinks }) {
  const out: React.ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const [whole, code, bold, italic, link, key] = m
    if (code) out.push(<code key={n++}>{code.slice(1, -1)}</code>)
    else if (bold) out.push(<strong key={n++}><Inline text={bold.slice(2, -2)} keys={keys} /></strong>)
    else if (italic) out.push(<em key={n++}><Inline text={italic.slice(1, -1)} keys={keys} /></em>)
    else if (link) {
      const [, label, href] = link.match(/^\[([^\]]+)\]\((.+)\)$/) ?? []
      out.push(<a key={n++} href={href} target="_blank" rel="noreferrer">{label}</a>)
    } else if (key && keys.has(key)) {
      const id = keys.get(key)!
      out.push(<button key={n++} className="md-key" onClick={() => setParam('task', id)}>{key}</button>)
    } else out.push(whole)
    last = at + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

export function Markdown({ text, keys }: { text: string; keys: KeyLinks }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let n = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push(<pre key={n++} className="md-pre">{body.join('\n')}</pre>)
      continue
    }

    const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (heading) {
      blocks.push(<p key={n++} className="md-h"><Inline text={heading[1]} keys={keys} /></p>)
      i++
      continue
    }

    if (/^\s*\|/.test(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cellsOf(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cellsOf(lines[i++]))
      blocks.push(
        <div key={n++} className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{head.map((c, j) => <th key={j}><Inline text={c} keys={keys} /></th>)}</tr></thead>
            <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline text={c} keys={keys} /></td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }

    const bullet = /^(\s*)[-*•]\s+(.*)$/
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/
    const listKind = bullet.test(line) ? bullet : numbered.test(line) ? numbered : null
    if (listKind) {
      const items: { text: string; deep: boolean }[] = []
      while (i < lines.length) {
        const m = lines[i].match(listKind)
        if (m) { items.push({ text: m[2], deep: m[1].length >= 2 }); i++; continue }
        // A wrapped item continues on an indented line.
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
          items[items.length - 1].text += ` ${lines[i].trim()}`
          i++
          continue
        }
        break
      }
      const List = listKind === bullet ? 'ul' : 'ol'
      blocks.push(
        <List key={n++} className="md-list">
          {items.map((it, j) => <li key={j} className={it.deep ? 'deep' : undefined}><Inline text={it.text} keys={keys} /></li>)}
        </List>,
      )
      continue
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push(<blockquote key={n++} className="md-quote"><Inline text={body.join(' ')} keys={keys} /></blockquote>)
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|[-*•]\s|\d+[.)]\s|>|\|)/.test(lines[i])) para.push(lines[i++].trim())
    if (!para.length) para.push(lines[i++].trim())
    blocks.push(
      <p key={n++}>
        {para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}<Inline text={p} keys={keys} /></Fragment>)}
      </p>,
    )
  }
  return <div className="md">{blocks}</div>
}
