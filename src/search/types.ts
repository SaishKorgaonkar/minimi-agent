export interface SearchQuery {
  query: string;
  /** Only results published on/after this instant. */
  after?: Date;
  /** Only results published before this instant. */
  before?: Date;
  /** 'news' prefers recent announcements; 'general' is normal web search. */
  topic?: 'general' | 'news';
  maxResults?: number;
  /** The user's country (ISO 3166-1 alpha-2): providers rank local results higher. */
  country?: string;
  /** Ask the provider for freshly crawled content (slower; used when re-verifying). */
  fresh?: boolean;
}

export interface RawResult {
  url: string;
  title: string;
  snippet: string;
  /** Full or partial page text, when the provider returns it. */
  text?: string;
  publishedAt?: string | null;
  provider: string;
  rank: number;
}

export interface SearchProvider {
  name: string;
  /** How many requests this provider serves at once on our key; extra requests queue. */
  maxConcurrent?: number;
  search(q: SearchQuery, signal: AbortSignal): Promise<RawResult[]>;
}

/** What the model sees for each source. */
export interface Evidence {
  n: number;
  url: string;
  title: string;
  publishedAt: string | null;
  fetchedAt: number;
  passages: string[];
  foundBy: string[];
}
