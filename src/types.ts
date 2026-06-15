export interface ScheduleEntry {
  id: string;
  enter: number;
  exit?: number;
  /** class to toggle; defaults to "on" */
  cls?: string;
}

export interface TimedText {
  from: number;
  to: number;
  text: string;
  /** stable line id, used to key per-section voice takes. Optional on disk for
      backward compatibility; filled in on the first timing write. Only lines
      (not captions) carry one in practice. */
  id?: string;
}

export interface SceneData {
  id: string;
  title: string;
  len: number;
  behaviors: string[];
  schedule: ScheduleEntry[];
  captions: TimedText[];
  lines: TimedText[];
  html: string;
  css: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  default: boolean;
}

export interface ProjectData {
  id: string;
  name: string;
  width: number;
  height: number;
  theme: string;
  scenes: SceneData[];
}

export interface TakeInfo {
  file: string;
  size: number;
  created: number;
}

/** The persisted post-production "audio chain" for one take: an ordered set of
    effects applied identically in preview, audition and export. It starts with
    just gain and grows one field per later effect (highpass, gate, comp). Every
    field is optional so an identity chain (all defaults) writes nothing.

    Chain order (head to tail): highpass -> gate -> compressor -> gain. */
export interface TakeChain {
  /** high-pass filter at the chain head; rolls off low-frequency rumble and
      plosives. freq is clamped to 20..300 Hz. Absent = filter bypassed. */
  highpass?: { freq: number };
  /** noise gate; sits after highpass and before the compressor. Attenuates the
      signal while it sits below the threshold (room tone, hiss between phrases)
      and passes it through unchanged during speech. threshold: dB (-80..0),
      range: dB of attenuation when closed (0..80, ~60 default), attack: seconds
      (0..0.5, ~0.005 default), release: seconds (0..2, ~0.15 default). Object
      present = enabled; absent = gate bypassed. */
  gate?: { threshold: number; range?: number; attack?: number; release?: number };
  /** dynamic range compressor; sits after the gate and before the gain node.
      threshold: dB (-60..0), ratio: 1..20, attack: seconds (0..1),
      release: seconds (0..2). Absent = compressor bypassed. */
  comp?: { threshold: number; ratio: number; attack: number; release: number };
  /** gain in dB applied to the take; 0 = unchanged. Clamped to about -24..+24.
      This node is also used as make-up gain after the compressor. */
  gainDb?: number;
}

export interface SectionTakes {
  candidate: string | null;
  /** seconds the candidate take is shifted against the line (mic latency trim) */
  offset: number;
  /** the candidate take's audio chain (gain etc.); absent if it is identity */
  chain?: TakeChain;
  takes: TakeInfo[];
}

/** takes grouped by scene, then by line id (a "section"). */
export type TakesMap = Record<string, Record<string, SectionTakes>>;

export interface ExportStatus {
  state: 'idle' | 'starting' | 'rendering' | 'done' | 'error';
  phase?: string;
  frame?: number;
  totalFrames?: number;
  message?: string;
  output?: string | null;
}
