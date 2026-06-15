import * as api from '../api';
import { Emitter } from '../emitter';
import type { Player } from '../engine/player';
import type { SectionTakes, TakeChain, TakesMap, TimedText } from '../types';

/* ----------------------------------------------------------------------------
   The post-production audio chain, shared by preview and audition (and mirrored
   by the ffmpeg export filter in server/render.mjs).

   buildChain wires the active effect nodes between `source` and the returned
   tail node, in the same order the export filter applies them. The caller
   connects the tail to its own sink (the master analyser). Given the same chain
   and the same worklet-load state it always builds the same graph, and it adds
   a node only for a non-default field, so an identity chain returns the source
   untouched.

   The gate is the one effect with no native Web Audio node: it is an
   AudioWorklet (src/audio/gate-worklet.js). The worklet module loads once and
   asynchronously, so buildChain takes a `gateReady` flag; when the module is
   not yet ready it skips the gate node (preview degrades to ungated) and the
   caller re-anchors once the module lands. The ffmpeg export is authoritative
   and always gates.

   Grow it one node per later effect; do not add parallel wiring elsewhere. */

/* default gate range (dB of attenuation when closed) when the field is absent;
   matches the ffmpeg side in server/render.mjs */
const GATE_DEFAULT_RANGE_DB = 60;
const GATE_DEFAULT_ATTACK_S = 0.005;
const GATE_DEFAULT_RELEASE_S = 0.15;

/* Encode the gate as it is actually wired into a source, so a gate edit (or the
   gate appearing once the worklet loads) forces a preview re-anchor. Empty
   string when no gate node is present (no gate field, or worklet not ready). */
export function gateKey(chain: TakeChain | undefined, gateReady: boolean): string {
  if (!chain?.gate || !gateReady) return '';
  const g = chain.gate;
  return [g.threshold, g.range ?? GATE_DEFAULT_RANGE_DB, g.attack ?? GATE_DEFAULT_ATTACK_S, g.release ?? GATE_DEFAULT_RELEASE_S].join(':');
}

export function buildChain(
  ctx: BaseAudioContext,
  source: AudioNode,
  chain: TakeChain | undefined,
  gateReady = false,
): AudioNode {
  let tail = source;
  /* high-pass is the chain head -- roll off rumble/plosives before everything else */
  if (chain?.highpass) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = chain.highpass.freq;
    /* leave Q at the default (~0.707, Butterworth), appropriate for a gentle rolloff */
    tail.connect(hp);
    tail = hp;
  }
  /* gate sits after highpass and before the compressor (same order as the
     ffmpeg agate). Inserted only when the worklet module is ready; otherwise
     skipped so preview still plays, and re-anchored once the module loads.
     Params are converted to the worklet's units (dB -> linear, kept in seconds)
     to mirror the agate conversions. */
  if (chain?.gate && gateReady) {
    const g = chain.gate;
    const node = new AudioWorkletNode(ctx, 'gate-processor', {
      parameterData: {
        threshold: Math.max(0, Math.min(1, Math.pow(10, g.threshold / 20))),
        range: Math.max(0, Math.min(1, Math.pow(10, -(g.range ?? GATE_DEFAULT_RANGE_DB) / 20))),
        attack: g.attack ?? GATE_DEFAULT_ATTACK_S,
        release: g.release ?? GATE_DEFAULT_RELEASE_S,
      },
    });
    tail.connect(node);
    tail = node;
  }
  /* compressor sits after the gate, before gain; gain doubles as make-up gain */
  if (chain?.comp) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = chain.comp.threshold; // dB, same scale as Web Audio
    comp.ratio.value = chain.comp.ratio;
    comp.attack.value = chain.comp.attack;       // seconds, same scale as Web Audio
    comp.release.value = chain.comp.release;     // seconds
    comp.knee.value = 6;                         // 6 dB soft knee
    tail.connect(comp);
    tail = comp;
  }
  const gainDb = chain?.gainDb ?? 0;
  if (gainDb !== 0) {
    const gain = ctx.createGain();
    gain.gain.value = Math.pow(10, gainDb / 20);
    tail.connect(gain);
    tail = gain;
  }
  return tail;
}

/* ============================================================================
   Voice takes: state, microphone recording, and the synced preview that plays
   each picked take during playback.

   A take covers one script line (a "section"), keyed by the line's stable id.
   Recording is scoped to a line: it seeks to the line's `from`, records, and
   stops when the playhead reaches the line's `to` (or the scene boundary, a
   pause, or a manual stop). Preview assembles a scene from its section takes:
   it finds the line covering the playhead and plays that line's candidate at
   `line.from + alignment offset`; gaps with no take are silent.

   Playback uses the Web Audio API rather than an <audio> element. Each take is
   fetched once and decoded into an in-memory AudioBuffer; playing from any
   position is then `source.start(0, offset)` — sample-accurate and instant,
   with no HTTP range request, no decode-on-seek, and no duration-header quirks.
   That makes pause/resume, scrubbing, and timeline jumps feel immediate; the
   old <audio>+currentTime approach paid a variable (sometimes multi-second)
   seek+buffer cost on every reposition.
============================================================================ */

interface PreviewNode {
  source: AudioBufferSourceNode;
  url: string;
  /** gain (dB) baked into this source's chain, so a gain edit forces a re-anchor */
  gainDb: number;
  /** high-pass freq baked into this source's chain; 0 = no filter; a change forces re-anchor */
  hpFreq: number;
  /** compressor threshold baked in; NaN = no compressor; a change forces re-anchor */
  compThreshold: number;
  /** gate state baked into this source's chain, encoded as a single key so any
      gate edit (or the gate appearing once the worklet loads) forces a
      re-anchor; '' = no gate node in this source */
  gateKey: string;
  /** take-time (seconds into the buffer) the source was started at */
  startOffset: number;
  /** ctx.currentTime when start() was called, to track the live position */
  startedAt: number;
}

/** number of count-in beats before recording starts (1 beat ~= 1 s) */
const COUNT_IN_BEATS = 3;

export class Takes {
  readonly events = new Emitter<{
    change: [];
    recording: [boolean];
    /** fired when the monitor is started or stopped; carries the AnalyserNode
        (when starting) or null (when stopping) */
    monitor: [AnalyserNode | null];
    /** fired each beat during the count-in (3, 2, 1) and 0 when recording
        actually starts; null when count-in is cancelled */
    countdown: [number | null];
  }>();
  map: TakesMap = {};
  previewEnabled = true;
  /** file currently auditioning from a takes-list row, or null */
  auditioning: string | null = null;
  /** line id currently recording, or null */
  recordingLine: string | null = null;
  /** line id currently in count-in, or null */
  countingLine: string | null = null;

  private readonly player: Player;
  private recorder: MediaRecorder | null = null;
  private recSceneIndex = -1;
  /** in-scene time at which the recording should auto-stop (line.to) */
  private recStopAt = Infinity;

  /** AbortController used to cancel an in-progress count-in */
  private countInAbort: AbortController | null = null;
  /** mic stream acquired during count-in (when monitor not already armed) */
  private countInStream: MediaStream | null = null;

  /* mic monitor: open stream + audio graph kept alive while armed */
  private monitorStream: MediaStream | null = null;
  private monitorSource: MediaStreamAudioSourceNode | null = null;
  private monitorAnalyser: AnalyserNode | null = null;
  get monitoring(): boolean { return this.monitorStream !== null; }

  /** The persistent post-processing analyser node (chainTail -> analyser ->
      destination).  Created on first use alongside the AudioContext; never torn
      down.  The UI attaches a playback Meter here. */
  get playbackAnalyser(): AnalyserNode { return this.masterAnalyser(); }

  /* Web Audio: one context, an in-memory decode cache, and at most one live
     source for the synced preview and one for list auditioning. */
  private ctx: AudioContext | null = null;
  private readonly ready = new Map<string, AudioBuffer | null>(); // null = decode failed
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();
  /* gate AudioWorklet module load state. The gate has no native node, so its
     module is loaded once and asynchronously; until it is 'ready' buildChain
     degrades to ungated preview. On 'failed' we permanently degrade and never
     retry. Mirrors the decode cache: an async resource lands, then sync() is
     called so the preview re-anchors with the gate. */
  private gateModuleState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private previewNode: PreviewNode | null = null;
  private auditionNode: AudioBufferSourceNode | null = null;
  /** ctx.currentTime when the live audition source was started */
  private auditionStartedAt = 0;
  /** seconds into the buffer the audition source started at (for scrubbing) */
  private auditionStartOffset = 0;
  /** persistent master analyser: chainTail -> masterAnalyser -> destination.
      Created once with the AudioContext, never torn down; both startPreview and
      startAudition route through it so the playback meter always reads the
      post-processed output level. */
  private _masterAnalyser: AnalyserNode | null = null;

  constructor(player: Player) {
    this.player = player;
    player.events.on('time', () => {
      /* stop a section recording the moment the playhead reaches the line end */
      if (this.recorder && this.player.localTime >= this.recStopAt) this.stopRecording();
      this.sync();
    });
    player.events.on('play', (p) => {
      if (p) void this.audioCtx().resume();
      if (!p && this.recorder) this.stopRecording();
      this.sync();
    });
    player.events.on('scene', () => {
      if (this.recorder && this.player.sceneIndex !== this.recSceneIndex) {
        this.player.setPlaying(false); // stops the recorder via the play hook
      }
      this.sync();
    });
  }

  get recording(): boolean { return this.recorder !== null; }
  get counting(): boolean { return this.countInAbort !== null; }

  async refresh(): Promise<void> {
    try { this.map = await api.fetchTakes(); } catch { this.map = {}; }
    this.sync(); // warm/realign the current section's take against the new picks
    this.events.emit('change');
  }

  section(sceneId: string, lineId: string): SectionTakes | undefined {
    return this.map[sceneId]?.[lineId];
  }

  candidate(sceneId: string, lineId: string): string | null {
    return this.map[sceneId]?.[lineId]?.candidate ?? null;
  }

  offset(sceneId: string, lineId: string): number {
    return this.map[sceneId]?.[lineId]?.offset ?? 0;
  }

  /** the candidate take's audio chain for a section, or undefined if identity.
      Both preview and audition play the candidate, so this is the chain heard. */
  chain(sceneId: string, lineId: string): TakeChain | undefined {
    return this.map[sceneId]?.[lineId]?.chain;
  }

  /** the line whose [from, to) window contains a scene-local time, or null */
  lineAt(scene: { lines: TimedText[] }, local: number): TimedText | null {
    for (const ln of scene.lines) if (local >= ln.from && local < ln.to) return ln;
    return null;
  }

  /* ---------------------------- recording ------------------------------- */

  /** Record one section. `lineId` defaults to the line under the playhead;
      returns an error string or null. Seeks to the line's `from`, records, and
      auto-stops at the line's `to`. */
  async startRecording(lineId?: string): Promise<string | null> {
    if (this.recorder) return null;
    const scene = this.player.scene;
    const line = lineId
      ? scene.lines.find((ln) => ln.id === lineId)
      : (this.lineAt(scene, this.player.localTime) ?? scene.lines[0]);
    if (!line || !line.id) return 'no line to record (add a narration line first)';

    /* reuse the monitor stream when already armed; otherwise open a new one */
    let stream: MediaStream;
    const reusingMonitor = this.monitorStream !== null;
    if (reusingMonitor) {
      stream = this.monitorStream!;
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        return 'microphone blocked: ' + (e instanceof Error ? e.message : String(e));
      }
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    this.recSceneIndex = this.player.sceneIndex;
    this.recStopAt = line.to;
    const sceneId = scene.id;
    const lid = line.id;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      /* only stop the stream if it was not the monitor stream; monitor stream
         is released separately via stopMonitor() */
      if (!reusingMonitor) stream.getTracks().forEach((t) => t.stop());
      this.recorder = null;
      this.recordingLine = null;
      this.recStopAt = Infinity;
      this.events.emit('recording', false);
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 1000) return; // discarded, effectively empty
      await api.uploadTake(sceneId, lid, blob, 'webm');
      await this.refresh();
    };
    this.recorder = rec;
    this.recordingLine = lid;
    this.stopPreview();
    this.stopAudition();
    this.player.seekScene(this.recSceneIndex, line.from); // align take with line start
    rec.start();
    this.player.setPlaying(true);
    this.events.emit('recording', true);
    return null;
  }

  stopRecording(): void {
    this.cancelCountIn();
    if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
    if (this.player.playing) this.player.setPlaying(false);
  }

  /** Play a short metronome click via Web Audio to ctx.destination.
      This goes to the speaker/headphones only; it is NOT on the mic capture
      stream (MediaRecorder records the input MediaStream, not ctx.destination),
      so the click can never bleed into the take. */
  private playClick(ctx: AudioContext, when: number, accent: boolean): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1200 : 900;
    gain.gain.setValueAtTime(accent ? 0.55 : 0.35, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.07);
  }

  /** Start the count-in then begin recording.  Both the panel rec buttons and
      the `r` shortcut call this instead of calling startRecording directly.
      Returns an error string or null (same contract as startRecording). */
  async startRecordingWithCountIn(lineId?: string): Promise<string | null> {
    if (this.recorder || this.countInAbort) return null;

    /* resolve the target line up-front so we can show the beat overlay */
    const scene = this.player.scene;
    const line = lineId
      ? scene.lines.find((ln) => ln.id === lineId)
      : (this.lineAt(scene, this.player.localTime) ?? scene.lines[0]);
    if (!line || !line.id) return 'no line to record (add a narration line first)';
    const lid = line.id;

    /* open the mic now so the user gets the permission prompt before the
       count-in, and we can reuse it in startRecording */
    let stream: MediaStream | null = null;
    if (!this.monitorStream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e) {
        return 'microphone blocked: ' + (e instanceof Error ? e.message : String(e));
      }
      this.countInStream = stream;
    }

    /* set up the abort token used by cancelCountIn() */
    const abort = new AbortController();
    this.countInAbort = abort;
    this.countingLine = lid;

    const ctx = this.audioCtx();
    void ctx.resume();

    /* schedule COUNT_IN_BEATS clicks; one accent on beat 1 */
    const beatDur = 1.0; // seconds per beat
    const t0 = ctx.currentTime + 0.05; // small lead to avoid the first click being clipped
    for (let i = 0; i < COUNT_IN_BEATS; i++) {
      this.playClick(ctx, t0 + i * beatDur, i === 0);
    }

    /* emit countdown numbers and wait for each beat */
    for (let beat = COUNT_IN_BEATS; beat >= 1; beat--) {
      if (abort.signal.aborted) {
        this.cleanUpCountIn();
        return null;
      }
      this.events.emit('countdown', beat);
      await new Promise<void>((res) => {
        const id = window.setTimeout(res, beatDur * 1000);
        abort.signal.addEventListener('abort', () => { clearTimeout(id); res(); }, { once: true });
      });
    }

    if (abort.signal.aborted) {
      this.cleanUpCountIn();
      return null;
    }

    /* count-in finished -- clear the count-in state before handing off */
    this.countInAbort = null;
    this.countingLine = null;
    this.countInStream = null; // ownership transfers to startRecording
    this.events.emit('countdown', 0);

    /* if the monitor stream was armed before we started, startRecording will
       reuse it; otherwise pass the stream we opened during the count-in by
       temporarily installing it as the monitor stream so startRecording reuses it */
    let installedTempMonitor = false;
    if (!this.monitorStream && stream) {
      /* temporarily wire up a minimal monitor entry so startRecording reuses
         the stream instead of re-requesting the mic */
      this.monitorStream = stream;
      installedTempMonitor = true;
    }

    const err = await this.startRecording(lid);

    /* if we installed a temporary monitor entry and startRecording did NOT take
       ownership (it would have set monitorStream = null on error, but it doesn't
       reset monitorStream in the success path -- it only stops non-monitor
       streams on onstop), clean up if an error occurred */
    if (installedTempMonitor && err) {
      stream!.getTracks().forEach((t) => t.stop());
      this.monitorStream = null;
    } else if (installedTempMonitor && !err) {
      /* startRecording successfully reused the stream; when recording stops
         (onstop) it will call getTracks().stop() on the stream because it
         checks reusingMonitor based on the snapshot it took.  We need to make
         sure we don't leave a dangling monitorStream reference after recording
         ends.  The onstop handler already clears recorder/recordingLine/recStopAt;
         we add a one-shot listener to clear monitorStream if it is still our
         temp one. */
      const tempStream = stream!;
      const unsub = this.events.on('recording', (_on: boolean) => {
        if (this.monitorStream === tempStream) {
          /* stop tracks and clear the reference -- no real monitor armed */
          tempStream.getTracks().forEach((t) => t.stop());
          this.monitorStream = null;
        }
        unsub();
      });
    }

    return err;
  }

  /** Cancel an in-progress count-in.  Safe to call when not counting. */
  cancelCountIn(): void {
    if (!this.countInAbort) return;
    this.countInAbort.abort();
    /* cleanUpCountIn is called from within the async startRecordingWithCountIn
       loop once it observes the abort; we also call it here to handle the case
       where the abort fires between beats */
    this.cleanUpCountIn();
  }

  private cleanUpCountIn(): void {
    this.countInAbort = null;
    this.countingLine = null;
    /* release any mic stream we opened just for the count-in */
    if (this.countInStream) {
      this.countInStream.getTracks().forEach((t) => t.stop());
      this.countInStream = null;
    }
    this.events.emit('countdown', null);
  }

  /* -------------------------- mic monitor ------------------------------- */

  /** Open the microphone for monitoring (level check before / during recording).
      Creates MediaStreamAudioSourceNode -> AnalyserNode; does NOT connect to
      ctx.destination so there is zero feedback.  Emits 'monitor' with the
      AnalyserNode so the panel can mount the Meter and LiveWaveform widgets.
      Returns an error string on failure, or null on success. */
  async startMonitor(): Promise<string | null> {
    if (this.monitorStream) return null; // already armed
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      return 'microphone blocked: ' + (e instanceof Error ? e.message : String(e));
    }
    const ctx = this.audioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    /* intentionally NOT connected to ctx.destination -- no feedback */
    this.monitorStream = stream;
    this.monitorSource = source;
    this.monitorAnalyser = analyser;
    this.events.emit('monitor', analyser);
    return null;
  }

  /** Release the monitor stream and tear down the audio graph.
      Safe to call when not armed. */
  stopMonitor(): void {
    if (!this.monitorStream) return;
    /* disconnect the graph: source -> analyser */
    this.monitorSource?.disconnect();
    this.monitorAnalyser?.disconnect();
    this.monitorStream.getTracks().forEach((t) => t.stop());
    this.monitorStream = null;
    this.monitorSource = null;
    this.monitorAnalyser = null;
    this.events.emit('monitor', null);
  }

  /* ----------------------- audition (list playback) --------------------- */

  toggleAudition(sceneId: string, lineId: string, file: string): void {
    if (this.auditioning === file) { this.stopAudition(); return; }
    this.stopPreview();
    this.stopAudition();
    this.auditioning = file;
    this.events.emit('change');
    void this.startAudition(new URL(api.takeUrl(sceneId, lineId, file), location.href).href, file, sceneId, lineId, 0);
  }

  /** Restart the audition for `file` from `fromSec` seconds into the buffer.
      Used by the scrubbable take strip; clicking the waveform calls this. If a
      different take is currently auditioning it is replaced. Re-uses the
      decode cache so seeking is cheap. */
  scrubAudition(sceneId: string, lineId: string, file: string, fromSec: number): void {
    this.stopPreview();
    this.stopAudition();
    this.auditioning = file;
    this.events.emit('change');
    void this.startAudition(
      new URL(api.takeUrl(sceneId, lineId, file), location.href).href,
      file,
      sceneId,
      lineId,
      Math.max(0, fromSec),
    );
  }

  /** Current position within the auditioning buffer, in seconds. Returns -1
      if no audition is playing. Cheap; safe to poll at RAF rate. */
  auditionPosition(): number {
    if (!this.auditionNode || !this.ctx) return -1;
    return this.auditionStartOffset + (this.ctx.currentTime - this.auditionStartedAt);
  }

  private async startAudition(url: string, file: string, sceneId: string, lineId: string, fromSec = 0): Promise<void> {
    const ctx = this.audioCtx();
    void ctx.resume();
    const buf = await this.load(url);
    if (this.auditioning !== file) return; // toggled off (or replaced) while loading
    if (!buf) { this.auditioning = null; this.events.emit('change'); return; }
    const source = ctx.createBufferSource();
    source.buffer = buf;
    /* same chain as the synced preview/export so an audition is true to mix;
       routes through the master analyser so the playback meter reads it. The
       gate worklet may still be loading; gateReady() kicks the load and the
       audition simply starts ungated (a short take is rarely worth re-anchoring) */
    buildChain(ctx, source, this.chain(sceneId, lineId), this.gateReady()).connect(this.masterAnalyser());
    source.onended = () => {
      if (this.auditionNode !== source) return;
      this.auditionNode = null;
      this.auditioning = null;
      this.events.emit('change');
    };
    this.auditionNode = source;
    this.auditionStartOffset = fromSec;
    this.auditionStartedAt = ctx.currentTime;
    source.start(0, fromSec);
  }

  private stopAudition(): void {
    const source = this.auditionNode;
    if (source) {
      this.auditionNode = null;
      source.onended = null;
      try { source.stop(); } catch { /* already stopped */ }
      source.disconnect();
    }
    if (this.auditioning !== null) {
      this.auditioning = null;
      this.events.emit('change');
    }
  }

  /* ------------------------- synced preview ----------------------------- */

  setPreviewEnabled(on: boolean): void {
    this.previewEnabled = on;
    this.sync();
  }

  /** Reconcile the live preview source with the playhead. Cheap to call often
      (every animation frame during playback): a no-op when already in sync.
      Assembles the scene from its sections: plays the candidate of the line
      under the playhead, anchored at line.from + the user-set offset. */
  private sync(): void {
    if (!this.previewEnabled || this.recorder) { this.stopPreview(); return; }
    const scene = this.player.scene;
    const local = this.player.localTime;
    const line = this.lineAt(scene, local);
    const file = line?.id ? this.candidate(scene.id, line.id) : null;
    this.warmNext();            // pre-decode the next section/scene for a snappy boundary
    if (!line || !line.id || !file) { this.stopPreview(); return; } // gap or no take: silent
    const lineId = line.id;

    const url = new URL(api.takeUrl(scene.id, line.id, file), location.href).href;
    const buf = this.peek(url); // kicks off the decode if needed; warms the cache while paused

    /* take time = how far into this line the playhead is, minus the alignment */
    const t = local - line.from - this.offset(scene.id, line.id);
    if (!this.player.playing || t < 0 || !buf || t >= buf.duration) {
      this.stopPreview();
      return;
    }

    /* Already playing this take roughly where it should be, with the same chain?
       Leave it running -- the AudioContext and the player both advance on real
       time, so they stay in lockstep. Re-anchor when the position has genuinely
       drifted (a scrub or a timeline jump) or when a chain field was edited, so
       the change is audible immediately. */
    const currentChain = this.chain(scene.id, lineId);
    const gainDb = currentChain?.gainDb ?? 0;
    const hpFreq = currentChain?.highpass?.freq ?? 0;
    const compThreshold = currentChain?.comp?.threshold ?? NaN;
    /* gateReady() also kicks the worklet load when a gate is present but the
       module is not yet ready; the load's sync() callback re-anchors with it */
    const gKey = gateKey(currentChain, this.gateReady());
    if (
      this.previewNode &&
      this.previewNode.url === url &&
      this.previewNode.gainDb === gainDb &&
      this.previewNode.hpFreq === hpFreq &&
      this.previewNode.gateKey === gKey &&
      /* NaN !== NaN is true, so either both absent or both equal threshold */
      (isNaN(this.previewNode.compThreshold) ? isNaN(compThreshold) : this.previewNode.compThreshold === compThreshold)
    ) {
      const pos = this.previewNode.startOffset
        + (this.audioCtx().currentTime - this.previewNode.startedAt);
      if (Math.abs(pos - t) <= 0.35) return;
    }
    this.startPreview(url, buf, t, currentChain);
  }

  private startPreview(url: string, buf: AudioBuffer, t: number, chain: TakeChain | undefined): void {
    this.stopPreview();
    const ctx = this.audioCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buf;
    /* same chain as audition/export; snapshot chain fields used for re-anchor
       detection; routes through the master analyser so the playback meter reads it.
       gateReady() reflects (and kicks) the worklet load; the gate is wired only
       when ready, so gateKey is '' while loading and changes once it lands */
    const ready = this.gateReady();
    buildChain(ctx, source, chain, ready).connect(this.masterAnalyser());
    const gainDb = chain?.gainDb ?? 0;
    const hpFreq = chain?.highpass?.freq ?? 0;
    const compThreshold = chain?.comp?.threshold ?? NaN;
    const gKey = gateKey(chain, ready);
    const node: PreviewNode = { source, url, gainDb, hpFreq, compThreshold, gateKey: gKey, startOffset: t, startedAt: ctx.currentTime };
    source.onended = () => { if (this.previewNode === node) this.previewNode = null; };
    this.previewNode = node;
    source.start(0, t);
  }

  private stopPreview(): void {
    const node = this.previewNode;
    if (!node) return;
    this.previewNode = null;
    node.source.onended = null;
    try { node.source.stop(); } catch { /* already stopped */ }
    node.source.disconnect();
  }

  /* --------------------------- decode cache ----------------------------- */

  private audioCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  /** Ensure the gate AudioWorklet module is loaded, returning whether it is
      ready right now. Loads once, asynchronously; on success it calls sync() so
      the preview re-anchors WITH the gate (the same pattern the decode cache
      uses when a buffer lands). A load failure logs once and permanently
      degrades to ungated preview without breaking playback. The worklet file is
      shipped as a module asset the Vite-compatible way: a `new URL(...,
      import.meta.url)` reference Vite rewrites to the built worklet chunk. */
  private gateReady(): boolean {
    if (this.gateModuleState === 'ready') return true;
    if (this.gateModuleState === 'idle') {
      this.gateModuleState = 'loading';
      const ctx = this.audioCtx();
      const url = new URL('./gate-worklet.js', import.meta.url).href;
      ctx.audioWorklet.addModule(url).then(() => {
        this.gateModuleState = 'ready';
        this.sync(); // re-anchor so a pending gate becomes audible
      }).catch((e) => {
        this.gateModuleState = 'failed';
        console.warn('[takes] gate worklet failed to load; preview stays ungated', e);
      });
    }
    return false;
  }

  /** Return (and lazily create) the persistent master analyser node, wired to
      ctx.destination.  Called by startPreview/startAudition to get the sink. */
  private masterAnalyser(): AnalyserNode {
    const ctx = this.audioCtx();
    if (!this._masterAnalyser) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.connect(ctx.destination);
      this._masterAnalyser = analyser;
    }
    return this._masterAnalyser;
  }

  /** Pre-decode the next section's take (and the next scene's first take) so
      crossing a line or scene boundary is instant. */
  private warmNext(): void {
    const warm = (sceneId: string, lineId: string | undefined): void => {
      const file = lineId ? this.candidate(sceneId, lineId) : null;
      if (lineId && file) this.peek(new URL(api.takeUrl(sceneId, lineId, file), location.href).href);
    };
    const scene = this.player.scene;
    const local = this.player.localTime;
    /* the next line in this scene that starts after the playhead */
    const next = scene.lines.find((ln) => ln.from > local);
    if (next) warm(scene.id, next.id);
    const nextScene = this.player.project.scenes[this.player.sceneIndex + 1];
    if (nextScene) warm(nextScene.id, nextScene.lines[0]?.id);
  }

  /** Synchronous cache peek for the hot sync() path; starts a decode on miss. */
  private peek(url: string): AudioBuffer | null {
    if (this.ready.has(url)) return this.ready.get(url) ?? null;
    void this.load(url);
    return null;
  }

  /** Fetch + decode a take once, caching the result (including failures, so a
      bad URL isn't re-fetched on every frame). Re-syncs when one lands so the
      synced preview can pick it up the moment it's ready. */
  private load(url: string): Promise<AudioBuffer | null> {
    if (this.ready.has(url)) return Promise.resolve(this.ready.get(url) ?? null);
    const existing = this.pending.get(url);
    if (existing) return existing;
    const p = (async (): Promise<AudioBuffer | null> => {
      let buf: AudioBuffer | null = null;
      try {
        const resp = await fetch(url);
        if (resp.ok) buf = await this.audioCtx().decodeAudioData(await resp.arrayBuffer());
      } catch { /* leave buf null — cached as a failed decode */ }
      this.ready.set(url, buf);
      this.pending.delete(url);
      return buf;
    })();
    this.pending.set(url, p);
    void p.then(() => this.sync());
    return p;
  }
}
