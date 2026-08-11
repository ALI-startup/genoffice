/**
 * Web / image search capability (backed by the shared main-process
 * Serper + DuckDuckGo client).
 *
 * Every member is required. The table records which preloads currently forward
 * each channel, not what the host can do — like the AI channels, these handlers
 * are registered process-wide and any preload can forward them:
 *
 * | method      | pdf | docs | slides | sheets |
 * | ----------- | --- | ---- | ------ | ------ |
 * | webSearch   | no  | yes  | yes    | yes    |
 * | imageSearch | no  | yes  | yes    | no     |
 * | fetchImage  | no  | yes  | no     | no     |
 *
 * Result-shape note: docs declares an optional `error` field (the failure
 * reason carried when `method === 'error'`); slides and sheets omit it. The
 * port takes the docs shape — the extra optional field is the superset and the
 * transport already sends it. (Optional *data* fields are fine; optional
 * *methods* are what we are eliminating.)
 */

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export interface WebSearchResult {
  results: WebSearchHit[]
  answer?: string
  method: string
  /** Failure reason when method === 'error'. */
  error?: string
}

export interface ImageSearchHit {
  title: string
  imageUrl: string
  sourceUrl: string
  source: string
  width?: number
  height?: number
}

export interface ImageSearchResult {
  images: ImageSearchHit[]
  method: string
  /** Failure reason when method === 'error'. */
  error?: string
}

export interface FetchedImage {
  /** Raw base64, without the data: prefix. */
  base64: string
  mime: string
}

export interface SearchPort {
  webSearch(query: string, maxResults?: number): Promise<WebSearchResult>
  imageSearch(query: string, maxResults?: number): Promise<ImageSearchResult>
  /** Download a remote image through the host (bypasses renderer CORS). */
  fetchImage(url: string): Promise<FetchedImage | null>
}
