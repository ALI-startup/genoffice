/** Escaped-quote lexer fix. */
import { LexerTreeBuilder, type sequenceNodeType } from '@univerjs/engine-formula'

import type { UniverRuntime } from './univer-state'

export interface SequenceNodeLike {
  nodeType: sequenceNodeType
  token: string
  startIndex: number
  endIndex: number
}

export type SequenceEntry = SequenceNodeLike | string

/// Mirror of _nodeMaker's input preprocessing.
function formulaBody(formula: string): string {
  const flattened = formula.replace(/\r\n$|\r|\n/g, ' ')
  return flattened.startsWith('=') ? flattened.slice(1) : flattened
}

/// Slot index → character index in `body`, replicating the lexer's states:
/// an escaped "" inside a string yields one slot; '' inside a quoted sheet
/// name yields two; quotes are literal inside [table refs] and vice versa.
function buildSlotMap(body: string): number[] {
  const map: number[] = []
  let inDouble = false
  let inSingle = false
  let bracketDepth = 0
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]
    map.push(at)
    if (inDouble) {
      if (char === '"') {
        if (body[at + 1] === '"') at += 1
        else inDouble = false
      }
    } else if (inSingle) {
      if (char === "'") {
        if (body[at + 1] === "'") {
          map.push(at + 1)
          at += 1
        } else inSingle = false
      }
    } else if (char === '"' && bracketDepth === 0) {
      inDouble = true
    } else if (char === "'") {
      inSingle = true
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1
    }
  }
  return map
}

export function fixSequenceNodes(
  formula: string,
  nodes: SequenceEntry[] | undefined | null,
): SequenceEntry[] | undefined | null {
  if (!nodes) return nodes
  const body = formulaBody(formula)
  const reassembled = nodes.map((node) => (typeof node === 'string' ? node : node.token)).join('')
  if (reassembled === body) return nodes
  const map = buildSlotMap(body)
  let changed = false
  const fixed = nodes.map((node) => {
    if (typeof node === 'string') return node
    const startIndex = map[node.startIndex]
    const boundary = map[node.endIndex + 1] ?? body.length
    if (startIndex === undefined) return node
    const endIndex = boundary - 1
    if (startIndex === node.startIndex && endIndex === node.endIndex) return node
    changed = true
    return { ...node, startIndex, endIndex, token: body.slice(startIndex, endIndex + 1) }
  })
  return changed ? fixed : nodes
}

export function wrapLexer(lexer: LexerTreeBuilder): { dispose(): void } {
  const original = lexer.sequenceNodesBuilder.bind(lexer) as (
    formula: string,
  ) => SequenceEntry[] | undefined | null
  const wrapped = (formula: string) => fixSequenceNodes(formula, original(formula))
  ;(lexer as { sequenceNodesBuilder: typeof wrapped }).sequenceNodesBuilder = wrapped
  return {
    dispose() {
      delete (lexer as { sequenceNodesBuilder?: typeof wrapped }).sequenceNodesBuilder
    },
  }
}

/// Wrap the injector's LexerTreeBuilder singleton — sheets-ui (commit
/// normalization), sheets-formula-ui (highlight), and engine-formula
/// (autofill/F4 offset rewrites) all resolve the same instance.
export function installFormulaLexerFix(runtime: UniverRuntime): { dispose(): void } {
  return wrapLexer(runtime.univer.__getInjector().get(LexerTreeBuilder))
}
