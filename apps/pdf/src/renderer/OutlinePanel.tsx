import type { ReactElement } from 'react'
import { openExternalUrl } from '@samugen/platform-web'

export interface OutlineNode {
  title: string
  bold?: boolean
  italic?: boolean
  dest?: unknown
  url?: string
  items?: OutlineNode[]
}

function Item({
  node,
  depth,
  onGo,
}: {
  node: OutlineNode
  depth: number
  onGo: (n: OutlineNode) => void
}): ReactElement {
  return (
    <>
      <button
        className="pdf-outline-item"
        style={{
          paddingLeft: 10 + depth * 14,
          fontWeight: node.bold ? 600 : 400,
          fontStyle: node.italic ? 'italic' : undefined,
        }}
        title={node.title}
        onClick={() => onGo(node)}
      >
        {node.title}
      </button>
      {node.items?.map((c, i) => (
        <Item key={i} node={c} depth={depth + 1} onGo={onGo} />
      ))}
    </>
  )
}

/** Outline (bookmark) tree: click jumps to internal destinations; url entries open external links */
export function OutlinePanel({
  outline,
  onGoToDest,
}: {
  outline: OutlineNode[]
  onGoToDest: (dest: unknown) => void
}): ReactElement {
  const onGo = (n: OutlineNode) => {
    // A URL out of the document: gated, because `window.open` would take `javascript:`.
    if (n.url) openExternalUrl(n.url, { allowedProtocols: ['http:', 'https:', 'mailto:'] })
    else if (n.dest != null) onGoToDest(n.dest)
  }
  return (
    <div className="pdf-outline">
      {outline.map((n, i) => (
        <Item key={i} node={n} depth={0} onGo={onGo} />
      ))}
    </div>
  )
}
