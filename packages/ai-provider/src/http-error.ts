/** Detail text for a non-OK HTTP response body. */
export function httpBodyDetail(body: string): string {
  const head = body.trimStart().slice(0, 30).toLowerCase()
  const isHtml = ['<!doctype', '<html', '<head', '<body'].some((tag) => head.startsWith(tag))
  if (isHtml) {
    return 'the service returned a web page instead of an API response (likely a temporary network or gateway block) — check your connection and retry'
  }
  return body.slice(0, 500)
}
