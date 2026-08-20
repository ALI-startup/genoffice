/** Renderer HTML → the restricted fragment docs' editor accepts. */
import { parseDocument } from 'htmlparser2'
import type { ChildNode, Element, Text } from 'domhandler'
import type { ParagraphInfo } from './outline'

/** Per-block alignment, positional over the emitted top-level blocks. */
export type BlockAlign = ReadonlyArray<'center' | 'right' | 'justify' | null>

export interface NormalizedHtml {
  /** The restricted fragment, ready for the editor's `parseHtmlFragment`. */
  html: string
  /** Alignment of each emitted top-level block, by index. */
  align: BlockAlign
  /** Images seen and dropped. */
  droppedImages: number
}

const isTag = (node: ChildNode): node is Element => node.type === 'tag'
const isText = (node: ChildNode): node is Text => node.type === 'text'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Inline tags the restricted set keeps, mapped to their canonical spelling. */
const INLINE_TAGS: Record<string, string> = {
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  u: 'u',
  s: 's',
  strike: 's',
  del: 's',
}

/** List markers the renderer bakes into the text. */
const BULLET_MARKER = /^[•·▪◦‣∙●○▶※*-]\s+/
const ORDERED_MARKER = /^(?:\d+|[a-z]|[ivxlcdm]+|[가-힣])\s*[.)]\s+/i

/** Ordinals accepted when *guessing* that an unmarked paragraph is a list item. */
const GUESSABLE_ORDERED = /^(?:\d{1,3}|[a-z]|[ivxlcdm]{1,4}|[가-힣])\s*[.)]\s+/i

/** Indent step the renderer emits per list level, in points. */
const INDENT_STEP_PT = 36

/** Left indent in points, read off the inline style the renderer writes. */
function paddingLeftPt(el: Element): number {
  const style = el.attribs?.style
  if (!style) return 0
  const match = /padding-left\s*:\s*([\d.]+)pt/i.exec(style)
  return match ? Number(match[1]) : 0
}

/** Concatenated text of an element, for marker sniffing. */
function textOf(node: ChildNode): string {
  if (isText(node)) return node.data
  if (!isTag(node)) return ''
  return (node.children as ChildNode[]).map(textOf).join('')
}

/** Guess whether an indented paragraph is really a list item. */
function guessListRole(el: Element): { ordered: boolean; level: number } | null {
  const indent = paddingLeftPt(el)
  if (indent < INDENT_STEP_PT) return null
  const text = (el.children as ChildNode[]).map(textOf).join('').replace(/^\s+/, '')
  const level = Math.max(0, Math.round(indent / INDENT_STEP_PT) - 1)
  if (BULLET_MARKER.test(text)) return { ordered: false, level }
  if (GUESSABLE_ORDERED.test(text)) return { ordered: true, level }
  return null
}

/** Every text node under an element, in document order. */
function textNodes(el: Element): Text[] {
  const out: Text[] = []
  const walk = (node: ChildNode): void => {
    if (isText(node)) {
      out.push(node)
      return
    }
    if (!isTag(node)) return
    for (const child of node.children as ChildNode[]) walk(child)
  }
  for (const child of el.children as ChildNode[]) walk(child)
  return out
}

/** Remove the baked-in list marker. */
function stripLeadingMarker(el: Element, ordered: boolean): void {
  const nodes = textNodes(el)
  if (nodes.length === 0) return
  const joined = nodes.map((n) => n.data).join('')
  const leading = joined.length - joined.replace(/^\s+/, '').length
  const marker = (ordered ? ORDERED_MARKER : BULLET_MARKER).exec(joined.slice(leading))
  if (!marker) return

  // Delete the leading whitespace and the marker together, walking the text
  // nodes until the full width has been consumed.
  let remaining = leading + marker[0].length
  for (const node of nodes) {
    if (remaining <= 0) break
    const take = Math.min(remaining, node.data.length)
    node.data = node.data.slice(take)
    remaining -= take
  }
}

interface InlineState {
  droppedImages: number
}

/** Serialize a node's children to restricted inline HTML. */
function inlineHtml(node: Element, state: InlineState): string {
  let out = ''
  for (const child of node.children as ChildNode[]) {
    if (isText(child)) {
      out += escapeHtml(child.data)
      continue
    }
    if (!isTag(child)) continue
    const tag = child.name.toLowerCase()
    if (tag === 'br') {
      out += '<br>'
      continue
    }
    if (tag === 'img') {
      state.droppedImages += 1
      continue
    }
    if (tag === 'a') {
      const href = child.attribs?.href
      // An anchor with no target is just styling; keep the text, drop the link.
      if (!href) {
        out += inlineHtml(child, state)
        continue
      }
      out += `<a href="${escapeHtml(href)}">${inlineHtml(child, state)}</a>`
      continue
    }
    const kept = INLINE_TAGS[tag]
    if (kept) {
      const inner = inlineHtml(child, state)
      // An empty emphasis wrapper would survive as a stray tag pair.
      out += inner ? `<${kept}>${inner}</${kept}>` : ''
      continue
    }
    out += inlineHtml(child, state)
  }
  return out
}

/** Cell content: one `<p>` per source paragraph, which the editor's table parser splits on. */
function cellHtml(cell: Element, state: InlineState): string {
  const paras: string[] = []
  for (const child of cell.children as ChildNode[]) {
    if (isTag(child) && child.name.toLowerCase() === 'p') {
      const inner = inlineHtml(child, state)
      if (inner.trim()) paras.push(inner)
    }
  }
  // Cells whose content is not wrapped in paragraphs fall back to the whole cell.
  if (paras.length === 0) {
    const inner = inlineHtml(cell, state)
    return inner.trim() ? `<p>${inner}</p>` : ''
  }
  return paras.map((p) => `<p>${p}</p>`).join('')
}

function tableHtml(table: Element, state: InlineState): string {
  const rows: Array<{ header: boolean; cells: string[] }> = []
  const collectRow = (tr: Element): void => {
    const cells: string[] = []
    let header = false
    for (const cell of tr.children as ChildNode[]) {
      if (!isTag(cell)) continue
      const tag = cell.name.toLowerCase()
      if (tag !== 'td' && tag !== 'th') continue
      if (tag === 'th') header = true
      cells.push(cellHtml(cell, state))
    }
    if (cells.length > 0) rows.push({ header, cells })
  }
  const walk = (node: Element): void => {
    for (const child of node.children as ChildNode[]) {
      if (!isTag(child)) continue
      if (child.name.toLowerCase() === 'tr') collectRow(child)
      else walk(child)
    }
  }
  walk(table)
  if (rows.length === 0) return ''

  const renderRow = (row: { header: boolean; cells: string[] }): string => {
    const tag = row.header ? 'th' : 'td'
    return `<tr>${row.cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`
  }
  // Only a genuine first-row header becomes <thead>; the editor's parser reads
  // header-ness off the first row's cell tags, so a mid-table header row must
  // stay in <tbody> as ordinary cells rather than be promoted.
  const [first, ...rest] = rows
  if (first.header) {
    const body = rest.map(renderRow).join('')
    return `<table><thead>${renderRow(first)}</thead>${body ? `<tbody>${body}</tbody>` : ''}</table>`
  }
  return `<table><tbody>${rows.map(renderRow).join('')}</tbody></table>`
}

/** An open list on the nesting stack. */
interface OpenList {
  tag: 'ul' | 'ol'
  level: number
  /** Whether this list sits inside an `<li>` of the list below it. */
  insideItem: boolean
}

/** Emits list items into correctly nested `<ul>`/`<ol>` markup. */
class ListBuilder {
  private stack: OpenList[] = []
  private parts: string[] = []
  private roots = 0

  get open(): boolean {
    return this.stack.length > 0
  }

  /** How many sibling lists the pending markup will contain. */
  get rootCount(): number {
    return this.roots
  }

  /** Close the innermost list, plus the item holding it when it was a sublist. */
  private close(): void {
    const closed = this.stack.pop()!
    this.parts.push(closed.insideItem ? `</${closed.tag}></li>` : `</${closed.tag}>`)
  }

  add(item: string, ordered: boolean, level: number): void {
    const tag = ordered ? 'ol' : 'ul'
    // Dedent: close sublists until the innermost list is at or above `level`.
    while (this.stack.length > 1 && this.stack[this.stack.length - 1].level > level) {
      this.close()
    }
    // An item shallower than the outermost list, which happens when a document's first list
    // paragraph is indented further than the ones after it.
    const outermost = this.stack[0]
    if (this.stack.length === 1 && outermost.level > level) outermost.level = level

    const top = this.stack[this.stack.length - 1]
    if (top && top.level === level && top.tag !== tag) {
      // Same depth, different kind: close this list and open the other one in its place.
      const { insideItem } = this.stack.pop()!
      this.parts.push(`</${top.tag}>`)
      this.parts.push(`<${tag}>`)
      this.stack.push({ tag, level, insideItem })
      // A new sibling at the outermost level is a second top-level block.
      if (this.stack.length === 1) this.roots += 1
    } else if (!top) {
      // Outermost list. `level` may be above zero when a document's first list
      // paragraph is already indented; it is still not inside any item.
      this.parts.push(`<${tag}>`)
      this.stack.push({ tag, level, insideItem: false })
      this.roots += 1
    } else if (top.level < level) {
      // A sublist belongs inside the preceding item, so reopen that item around
      // the nested list; a first item at a deeper level gets an empty one.
      if (this.parts[this.parts.length - 1]?.endsWith('</li>')) {
        this.parts[this.parts.length - 1] = this.parts[this.parts.length - 1].replace(/<\/li>$/, '')
      } else {
        this.parts.push('<li>')
      }
      this.parts.push(`<${tag}>`)
      this.stack.push({ tag, level, insideItem: true })
    }
    this.parts.push(`<li>${item}</li>`)
  }

  /** Close every open level and return the finished markup. */
  flush(): string {
    while (this.stack.length > 0) this.close()
    const html = this.parts.join('')
    this.parts = []
    this.roots = 0
    return html
  }
}

/** Convert renderer HTML to the restricted fragment. */
export function normalizeHwpxHtml(html: string, info: readonly ParagraphInfo[]): NormalizedHtml {
  const doc = parseDocument(html)
  const blocks = (doc.children as ChildNode[]).filter(isTag)
  const roles: readonly ParagraphInfo[] = info.length === blocks.length ? info : []

  const state: InlineState = { droppedImages: 0 }
  const out: string[] = []
  const align: Array<'center' | 'right' | 'justify' | null> = []
  const lists = new ListBuilder()

  /** Close any open list before a non-list block joins the output. */
  const closeList = (): void => {
    if (!lists.open) return
    const roots = lists.rootCount
    out.push(lists.flush())
    // One slot per sibling list produced, so `align` stays index-aligned with
    // the blocks the editor will build.
    for (let i = 0; i < roots; i += 1) align.push(null)
  }

  blocks.forEach((block, index) => {
    const tag = block.name.toLowerCase()
    const entry = roles[index]
    const declared = entry?.role ?? { kind: 'body' as const }
    // The package's own role wins; the marker guess only fills in for documents
    // that carry no list role at all (see guessListRole).
    const guessed = declared.kind === 'body' ? guessListRole(block) : null
    const role: ParagraphInfo['role'] = guessed ? { kind: 'list', ...guessed } : declared

    if (tag === 'table') {
      closeList()
      const table = tableHtml(block, state)
      if (table) {
        out.push(table)
        align.push(null)
      }
      return
    }

    if (role.kind === 'list') {
      stripLeadingMarker(block, role.ordered)
      const inner = inlineHtml(block, state)
      // An empty list paragraph is spacing, not an item.
      if (inner.trim()) {
        lists.add(inner, role.ordered, role.level)
        return
      }
      closeList()
      return
    }

    closeList()
    const inner = inlineHtml(block, state)
    // Blocks with no content are dropped rather than emitted empty.
    if (!inner.trim()) return

    if (role.kind === 'heading') {
      out.push(`<h${role.level}>${inner}</h${role.level}>`)
    } else {
      out.push(`<p>${inner}</p>`)
    }
    align.push(entry?.align ?? null)
  })

  closeList()

  return { html: out.join(''), align, droppedImages: state.droppedImages }
}
