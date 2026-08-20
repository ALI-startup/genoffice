/** Web / image search capability (backed by the shared main-process Serper + DuckDuckGo client). */

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
