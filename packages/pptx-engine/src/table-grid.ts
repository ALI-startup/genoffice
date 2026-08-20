/** Table grid-column accounting shared by parse (style lookups) and pptx-render (cell geometry). */

/** Starting grid column of each tc in a row. */
export function tableRowGridCols(row: Array<{ gridSpan?: number; merged?: boolean }>): number[] {
  const cols: number[] = []
  let c = 0
  row.forEach((cell, i) => {
    cols.push(c)
    const span = cell.gridSpan ?? 1
    const followers = span > 1 ? row.slice(i + 1, i + span) : []
    c += followers.length === span - 1 && followers.every((f) => f.merged) ? 1 : span
  })
  return cols
}
