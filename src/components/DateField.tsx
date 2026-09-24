import { useEffect, useRef, useState } from 'react'
import { formatDate, parseDateInput } from '../lib/dates'

/**
 * A date field that reads dd/mm/yyyy.
 *
 * `<input type="date">` cannot be made to do this. Chromium draws it from the
 * machine's regional format, not from the page and not from the app: on a US
 * locale it renders 09/28/2026 next to Scrumly's own text reading 28/09/2026,
 * which is the one combination guaranteed to be misread. Electron's --lang
 * switch does not reach it either — it moves navigator.language and Intl, and
 * leaves the control exactly where it was.
 *
 * So the text is ours. The native control is still here, visually hidden, for
 * the one thing it is better at: its calendar popup, opened by the button. The
 * grid it draws is a grid whatever the locale, so nothing is misread there.
 *
 * The value in and out is always ISO 'YYYY-MM-DD'. Nothing below the UI ever
 * sees dd/mm/yyyy.
 */
export function DateField({
  value,
  onCommit,
  style,
  label,
  clearable = false,
}: {
  value: string | null
  /** Fired once, on commit — not per keystroke. null only when clearable. */
  onCommit: (iso: string | null) => void
  style?: React.CSSProperties
  label?: string
  clearable?: boolean
}) {
  const [text, setText] = useState(() => (value ? formatDate(value) : ''))
  const [bad, setBad] = useState(false)
  const editing = useRef(false)
  const picker = useRef<HTMLInputElement>(null)

  // Follow the stored value while the field is not being typed in. Without the
  // guard, a save landing mid-edit would rewrite the box under the cursor.
  useEffect(() => {
    if (editing.current) return
    setText(value ? formatDate(value) : '')
    setBad(false)
  }, [value])

  function commit() {
    editing.current = false
    const raw = text.trim()

    if (!raw) {
      if (clearable) { onCommit(null); setBad(false); return }
      setText(value ? formatDate(value) : '')
      setBad(false)
      return
    }

    const iso = parseDateInput(raw)
    if (!iso) {
      // Keep what they typed and mark it, rather than silently discarding it.
      // They are one character from correct far more often than they are wrong.
      setBad(true)
      return
    }
    setBad(false)
    setText(formatDate(iso))
    if (iso !== value) onCommit(iso)
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...style }}>
      <input
        className="input"
        inputMode="numeric"
        placeholder="dd/mm/yyyy"
        aria-label={label}
        aria-invalid={bad || undefined}
        style={{ width: '100%', minWidth: 0, borderColor: bad ? 'var(--alert)' : undefined }}
        value={text}
        onFocus={() => { editing.current = true }}
        onChange={(e) => { setText(e.target.value); if (bad) setBad(false) }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') {
            editing.current = false
            setText(value ? formatDate(value) : '')
            setBad(false)
          }
        }}
      />
      <button
        type="button"
        className="btn ghost sm"
        style={{ flex: 'none', padding: '0 6px' }}
        aria-label={label ? `Pick ${label}` : 'Pick a date'}
        // showPicker needs a click to have happened, which it has.
        onClick={() => picker.current?.showPicker?.()}
      >
        ▾
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        // Not display:none — a hidden control cannot open its own picker.
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
        value={value ?? ''}
        onChange={(e) => {
          const iso = e.target.value
          if (!iso) { if (clearable) onCommit(null); return }
          setText(formatDate(iso))
          setBad(false)
          if (iso !== value) onCommit(iso)
        }}
      />
    </span>
  )
}
