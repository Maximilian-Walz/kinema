import * as api from '../api';
import { Emitter } from '../emitter';
import type { Player } from '../engine/player';
import type { TakesMap } from '../types';

/* ============================================================================
   Voice takes: state, microphone recording, and the synced preview that plays
   each scene's picked take during playback.

   Playback uses the Web Audio API rather than an <audio> element. Each take is
   fetched once and decoded into an in-memory AudioBuffer; playing from any
   position is then `source.start(0, offset)` — sample-accurate and instant,
   with no HTTP range request, no decode-on-seek, and no duration-header quirks.
   That makes pause/resume, scrubbing, and timeline jumps feel immediate; the
   old <audio>+currentTime approach paid a variable (sometimes multi-second)
   seek+buffer cost on every reposition.

   Recording always restarts the current scene so the take aligns with scene
   t=0, and stops at the scene boundary, on pause, or manually.
============================================================================ */

interface PreviewNode {
  source: AudioBufferSourceNode;
  url: string;
  /** take-time (seconds into the buffer) the source was started at */
  startOffset: number;
  /** ctx.currentTime when start() was called, to track the live position */
  startedAt: number;
}

export class Takes {
  readonly events = new Emitter<{ change: []; recording: [boolean] }>();
  map: TakesMap = {};
  previewEnabled = true;
  auditioning: string | null = null;

  private readonly player: Player;
  private recorder: MediaRecorder | null = null;
  private recSceneIndex = -1;

  /* Web Audio: one context, an in-memory decode cache, and at most one live
     source for the synced preview and one for list auditioning. */
  private ctx: AudioContext | null = null;
  private readonly ready = new Map<string, AudioBuffer | null>(); // null = decode failed
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();
  private previewNode: PreviewNode | null = null;
  private auditionNode: AudioBufferSourceNode | null = null;

  constructor(player: Player) {
    this.player = player;
    player.events.on('time', () => this.sync());
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

  async refresh(): Promise<void> {
    try { this.map = await api.fetchTakes(); } catch { this.map = {}; }
    this.sync(); // warm/realign the current scene's take against the new picks
    this.events.emit('change');
  }

  candidate(sceneId: string): string | null {
    return this.map[sceneId]?.candidate ?? null;
  }

  offset(sceneId: string): number {
    return this.map[sceneId]?.offset ?? 0;
  }

  /* ---------------------------- recording ------------------------------- */

  async startRecording(): Promise<string | null> {
    if (this.recorder) return null;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      return 'microphone blocked: ' + (e instanceof Error ? e.message : String(e));
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    this.recSceneIndex = this.player.sceneIndex;
    const sceneId = this.player.scene.id;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      this.recorder = null;
      this.events.emit('recording', false);
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 1000) return; // discarded, effectively empty
      await api.uploadTake(sceneId, blob, 'webm');
      await this.refresh();
    };
    this.recorder = rec;
    this.stopPreview();
    this.stopAudition();
    this.player.seekScene(this.recSceneIndex); // align take with scene t=0
    rec.start();
    this.player.setPlaying(true);
    this.events.emit('recording', true);
    return null;
  }

  stopRecording(): void {
    if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
    if (this.player.playing) this.player.setPlaying(false);
  }

  /* ----------------------- audition (list playback) --------------------- */

  toggleAudition(sceneId: string, file: string): void {
    if (this.auditioning === file) { this.stopAudition(); return; }
    this.stopPreview();
    this.stopAudition();
    this.auditioning = file;
    this.events.emit('change');
    void this.startAudition(new URL(api.takeUrl(sceneId, file), location.href).href, file);
  }

  private async startAudition(url: string, file: string): Promise<void> {
    const ctx = this.audioCtx();
    void ctx.resume();
    const buf = await this.load(url);
    if (this.auditioning !== file) return; // toggled off (or replaced) while loading
    if (!buf) { this.auditioning = null; this.events.emit('change'); return; }
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.auditionNode !== source) return;
      this.auditionNode = null;
      this.auditioning = null;
      this.events.emit('change');
    };
    this.auditionNode = source;
    source.start(0);
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
      (every animation frame during playback): a no-op when already in sync. */
  private sync(): void {
    if (!this.previewEnabled || this.recorder) { this.stopPreview(); return; }
    const sceneId = this.player.scene.id;
    const file = this.candidate(sceneId);
    if (!file) { this.stopPreview(); return; }

    const url = new URL(api.takeUrl(sceneId, file), location.href).href;
    const buf = this.peek(url); // kicks off the decode if needed; warms the cache while paused
    this.warmNext();            // pre-decode the next scene so its boundary is snappy too

    /* take time = scene time minus the user-set alignment offset */
    const t = this.player.localTime - this.offset(sceneId);
    if (!this.player.playing || t < 0 || !buf || t >= buf.duration) {
      this.stopPreview();
      return;
    }

    /* Already playing this take roughly where it should be? Leave it running —
       the AudioContext and the player both advance on real time, so they stay
       in lockstep. Only re-anchor when the position has genuinely drifted
       (e.g. a scrub or a jump on the timeline). */
    if (this.previewNode && this.previewNode.url === url) {
      const pos = this.previewNode.startOffset
        + (this.audioCtx().currentTime - this.previewNode.startedAt);
      if (Math.abs(pos - t) <= 0.35) return;
    }
    this.startPreview(url, buf, t);
  }

  private startPreview(url: string, buf: AudioBuffer, t: number): void {
    this.stopPreview();
    const ctx = this.audioCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);
    const node: PreviewNode = { source, url, startOffset: t, startedAt: ctx.currentTime };
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

  /** Pre-decode the next scene's take so crossing the boundary is instant. */
  private warmNext(): void {
    const next = this.player.project.scenes[this.player.sceneIndex + 1];
    if (!next) return;
    const file = this.candidate(next.id);
    if (file) this.peek(new URL(api.takeUrl(next.id, file), location.href).href);
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
