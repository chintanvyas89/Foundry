export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Unit-length copy of a vector. Used when blending several vectors (query,
// pinned results, a typed note) into one search direction so that each
// contributes by its assigned weight, not by its raw magnitude.
export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

// Weighted sum of unit-normalized vectors — the blended query direction for
// relevance feedback. Magnitude is irrelevant downstream (cosine re-normalizes),
// only the direction matters.
export function blend(components: Array<{ vec: Float32Array; weight: number }>): Float32Array {
  const dim = components[0].vec.length;
  const out = new Float32Array(dim);
  for (const { vec, weight } of components) {
    const u = normalize(vec);
    for (let i = 0; i < dim; i++) out[i] += u[i] * weight;
  }
  return out;
}
