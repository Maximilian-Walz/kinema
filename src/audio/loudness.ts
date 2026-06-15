/* Loudness measurement for take normalization (ticket 08).
   Measures RMS and true peak of the RAW audio file (never the gained output)
   so re-running normalization is idempotent: the same raw file always yields
   the same measurement and therefore the same target gain.

   RMS is computed over all samples of the first channel (or the mix of all
   channels). True peak is the maximum absolute sample value. Both are returned
   in dBFS (decibels relative to full scale): 0 dBFS = maximum digital level.

   Target and ceiling constants are defined here so they are easy to change
   without touching UI code. */

/** Target RMS level in dBFS. Takes are raised or lowered to this level. */
export const TARGET_RMS_DB = -18;

/** Peak ceiling in dBFS. The applied gain is capped so the take's measured
    peak never exceeds this level after normalization. */
export const CEILING_DB = -1;

/** Gain slider range used everywhere in the chain (must match the slider
    in panels.ts and the comment in types.ts). */
export const GAIN_MIN_DB = -24;
export const GAIN_MAX_DB = 24;

export interface LoudnessResult {
  rmsDb: number;
  peakDb: number;
}

/* Cache keyed by URL -- measurement is always on the raw file so the URL is
   stable. A failed decode caches null so a bad URL is not re-fetched every
   time. */
const cache = new Map<string, Promise<LoudnessResult | null>>();

/** Fetch and decode `url`, compute RMS and true peak over the whole take, and
    return both in dBFS. The result is cached so repeated calls for the same URL
    are free. Returns null only if the fetch or decode fails (error is logged). */
export function measureLoudness(url: string): Promise<LoudnessResult | null> {
  let p = cache.get(url);
  if (!p) {
    p = measure(url);
    cache.set(url, p);
  }
  return p;
}

async function measure(url: string): Promise<LoudnessResult | null> {
  let arrayBuf: ArrayBuffer;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    arrayBuf = await resp.arrayBuffer();
  } catch (e) {
    console.warn('[loudness] fetch failed:', url, e);
    return null;
  }

  let audio: AudioBuffer;
  try {
    /* OfflineAudioContext only needs one frame for decodeAudioData; we just
       want the decoded PCM data, not to render anything. Mirror the pattern
       used in waveform.ts. */
    const ctx = new OfflineAudioContext(1, 1, 44100);
    audio = await ctx.decodeAudioData(arrayBuf);
  } catch (e) {
    console.warn('[loudness] decode failed:', url, e);
    return null;
  }

  /* Mix all channels down to mono for the measurement by averaging them.
     For mono takes this is a no-op. */
  const numCh = audio.numberOfChannels;
  const len = audio.length;
  let sumSq = 0;
  let peak = 0;

  if (numCh === 1) {
    const ch = audio.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      sumSq += v * v;
      if (a > peak) peak = a;
    }
  } else {
    /* accumulate across channels then divide by channel count */
    const channels: Float32Array[] = [];
    for (let c = 0; c < numCh; c++) channels.push(audio.getChannelData(c));
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < numCh; c++) s += channels[c][i];
      s /= numCh;
      const a = s < 0 ? -s : s;
      sumSq += s * s;
      if (a > peak) peak = a;
    }
  }

  const rmsLinear = len > 0 ? Math.sqrt(sumSq / len) : 0;

  /* Convert to dBFS: 20 * log10(amplitude). Guard against 0 with a floor of
     -120 dBFS so silent takes get a defined value rather than -Infinity. */
  const DB_FLOOR = -120;
  const rmsDb = rmsLinear > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rmsLinear)) : DB_FLOOR;
  const peakDb = peak > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(peak)) : DB_FLOOR;

  return { rmsDb, peakDb };
}

/** Compute the normalized gain for a take given its measured loudness.
    Formula: gainDb = TARGET_RMS_DB - rmsDb, then capped so
    peakDb + gainDb <= CEILING_DB, then clamped to [GAIN_MIN_DB, GAIN_MAX_DB].
    Returns the gain in dB. */
export function computeNormalizeGain(result: LoudnessResult): number {
  const uncapped = TARGET_RMS_DB - result.rmsDb;
  /* peak cap: ensure peakDb + gainDb <= CEILING_DB */
  const maxAllowed = CEILING_DB - result.peakDb;
  const capped = Math.min(uncapped, maxAllowed);
  /* clamp to the slider / chain range */
  return Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, capped));
}
