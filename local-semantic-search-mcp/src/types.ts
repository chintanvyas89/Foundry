export interface Chunk {
  file: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  text: string;
  contentHash: string;
}

export interface IndexedChunk extends Chunk {
  id: string;
  embedding: Float32Array;
}

export interface SearchResult extends Chunk {
  score: number;
}
