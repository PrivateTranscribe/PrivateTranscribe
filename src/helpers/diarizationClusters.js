// Small-cluster handling for automatic speaker counting.
//
// Complete-linkage clustering leaves outlier segments (laughter, crosstalk,
// noise) as their own tiny clusters, which the transcript then shows as extra
// speakers. pyannote solves this with `min_cluster_size`: clusters below the
// floor are dissolved and each is attached to the closest large cluster by
// voice similarity. This module holds the pure logic; the manager supplies
// embeddings from the same speaker model the diarizer already uses.

function clusterId(segment) {
  return String(segment.speaker ?? segment.label ?? segment.speakerLabel ?? 0);
}

function clusterDurations(segments = []) {
  const durations = new Map();
  for (const segment of segments) {
    const seconds = Math.max(0, Number(segment.end) - Number(segment.start));
    if (!Number.isFinite(seconds)) continue;
    const id = clusterId(segment);
    durations.set(id, (durations.get(id) || 0) + seconds);
  }
  return durations;
}

// Floor is the larger of an absolute number of seconds and a share of all
// speech, so a two-minute clip and a two-hour meeting both get sensible cuts.
// The largest cluster is never dissolved.
function selectSmallClusters(durations, options = {}) {
  const minSeconds = Math.max(0, Number(options.minClusterSeconds) || 0);
  const minShare = Math.min(1, Math.max(0, Number(options.minClusterShare) || 0));
  const total = [...durations.values()].reduce((sum, value) => sum + value, 0);
  const floor = Math.max(minSeconds, minShare * total);
  const small = new Set();
  const large = new Set();
  if (floor <= 0 || durations.size < 2) {
    for (const id of durations.keys()) large.add(id);
    return { small, large, floor };
  }
  let largest = null;
  for (const [id, seconds] of durations) {
    if (!largest || seconds > durations.get(largest)) largest = id;
    if (seconds < floor) small.add(id);
    else large.add(id);
  }
  if (large.size === 0) {
    small.delete(largest);
    large.add(largest);
  }
  return { small, large, floor };
}

function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!norm) return Float32Array.from(vector);
  return Float32Array.from(vector, (value) => value / norm);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

// Duration-weighted mean of unit vectors. Weights guard against very short
// segments whose embeddings are unreliable.
function centroid(entries) {
  const usable = entries.filter((entry) => entry.vector && entry.vector.length);
  if (!usable.length) return null;
  const sum = new Float64Array(usable[0].vector.length);
  let totalWeight = 0;
  for (const entry of usable) {
    const unit = normalize(entry.vector);
    const weight = Math.max(0.05, Number(entry.weight) || 0);
    for (let i = 0; i < sum.length; i += 1) sum[i] += unit[i] * weight;
    totalWeight += weight;
  }
  if (!totalWeight) return null;
  return normalize(Float32Array.from(sum, (value) => value / totalWeight));
}

// Pick the segments worth embedding for a centroid: the longest few. This bounds
// the extra native work on long meetings.
function representativeSegments(segments, id, limit = 12) {
  return segments
    .filter((segment) => clusterId(segment) === id)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, limit);
}

// Relabel every segment of a small cluster to its most similar large cluster.
// A small cluster without a usable centroid keeps its own label.
function reassignSmallClusters(segments, small, large, centroids) {
  const merges = [];
  const target = new Map();
  for (const id of small) {
    const own = centroids.get(id);
    if (!own) continue;
    let best = null;
    for (const candidate of large) {
      const other = centroids.get(candidate);
      if (!other) continue;
      const similarity = cosine(own, other);
      if (!best || similarity > best.similarity) best = { to: candidate, similarity };
    }
    if (!best) continue;
    target.set(id, best.to);
    merges.push({ from: id, to: best.to, similarity: Number(best.similarity.toFixed(3)) });
  }
  const relabeled = segments.map((segment) => {
    const id = clusterId(segment);
    return target.has(id) ? { ...segment, speaker: target.get(id) } : segment;
  });
  return { segments: relabeled, merges };
}

module.exports = {
  centroid,
  clusterDurations,
  clusterId,
  cosine,
  normalize,
  reassignSmallClusters,
  representativeSegments,
  selectSmallClusters,
};
