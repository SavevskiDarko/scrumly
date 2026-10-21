import { db } from '../db/schema'
import type { ExternalLink, ID } from '../db/types'
import { newId } from './ids'

/*
 * Links from a task to wherever its work lives outside Scrumly: the pull
 * request, the design, the vendor's ticket. Web links only. They are clicked
 * straight out of the task drawer, and the desktop app hands http and https to
 * the real browser and refuses everything else, so any other kind stored here
 * would be a link that does nothing at best.
 */

export const NOT_A_LINK = 'That is not a web link. Paste the whole address, starting https://.'

/**
 * A scheme written at the front, which is how mailto:, file: and javascript:
 * arrive. A colon followed by a digit is a port instead, as in example.com:8080.
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i

/**
 * The address a pasted link is stored and opened as, or null when it is not an
 * http or https one. Typed without its https://, as "github.com/acme/pay/pull/12"
 * often is, it is taken as https.
 */
export function webUrl(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const scheme = SCHEME.exec(text)?.[1].toLowerCase()
  if (scheme && scheme !== 'http' && scheme !== 'https') return null
  let url: URL
  try {
    url = new URL(scheme ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  // Without a scheme, a word on its own would otherwise become https://word/.
  if (!scheme && !url.hostname.includes('.')) return null
  return url.href
}

/** Where a link goes, as a person would say it: github.com, not https://www.github.com/. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export type ExternalLinkResult = { ok: true; link: ExternalLink } | { ok: false; reason: string }

export const externalLinks = {
  /** In the order they were added: ids are time-ordered, and equal keys come back by id. */
  forTask: (taskId: ID) => db.externalLinks.where('taskId').equals(taskId).toArray(),

  /** The label is optional. Left blank it is the site's name, which is what most people would type anyway. */
  async add(taskId: ID, input: { url: string; label?: string }): Promise<ExternalLinkResult> {
    const url = webUrl(input.url)
    if (!url) return { ok: false, reason: NOT_A_LINK }
    return db.transaction('rw', db.tasks, db.externalLinks, async (): Promise<ExternalLinkResult> => {
      if (!(await db.tasks.get(taskId))) return { ok: false, reason: 'That task is gone' }
      // The same address twice is a second click on Add, not a second link.
      const same = (await externalLinks.forTask(taskId)).find((l) => l.url === url)
      if (same) return { ok: false, reason: `That link is already here, as ${same.label}.` }
      const link: ExternalLink = { id: newId(), taskId, label: input.label?.trim() || linkHost(url), url }
      await db.externalLinks.add(link)
      return { ok: true, link }
    })
  },

  remove: (id: ID) => db.externalLinks.delete(id),
}
