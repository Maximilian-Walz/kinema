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

export type TakesMap = Record<string, { candidate: string | null; takes: TakeInfo[] }>;

export interface ExportStatus {
  state: 'idle' | 'starting' | 'rendering' | 'done' | 'error';
  phase?: string;
  frame?: number;
  totalFrames?: number;
  message?: string;
  output?: string | null;
}
