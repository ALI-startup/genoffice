/**
 * Native <input type="color"> never fires a change event when the user picks the exact color the
 * input already holds (e.g.
 */
export function armColorInput(input: HTMLInputElement): void {
  const m = /^#([0-9a-fA-F]{6})$/.exec(input.value)
  if (!m) return
  const rgb = parseInt(m[1]!, 16) ^ 1
  input.value = `#${rgb.toString(16).padStart(6, '0')}`
}

/** Model color (#RRGGBB, optional AA) → <input type="color"> value; null when not a hex color. */
export function toPickerHex(color: string | undefined): string | null {
  if (!color) return null
  const m = /^#?([0-9a-fA-F]{6})/.exec(color)
  return m ? `#${m[1]!.toLowerCase()}` : null
}
