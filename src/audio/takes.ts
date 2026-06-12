import * as api from '../api';
import { Emitter } from '../emitter';
import type { Player } from '../engine/player';
import type { TakesMap } from '../types';

/* ============================================================================
   Voice takes: state, microphone recording, and the synced preview that plays
   each scene's picked take during playback.

   Recording always restarts the current scene so the take aligns with scene
   t=0, and stops at the scene boundary, on pause, or manually.
============================================================================ */

export class Takes {
  readonly events = new Emitter<{ change: []; recording: [boolean] }>();
  map: TakesMap = {};
  previewEnabled = true;

  private readonly player: Player;
  private readonly preview = new Audio();
  private recorder: MediaRecorder | null = null;
  private recSceneIndex = -1;
  private readonly audition = new Audio();
  auditioning: string | null = null;

  constructor(player: Player) {
    this.player = player;
    this.audition.onended = this.audition.onpause = () => {
      this.auditioning = null;
      this.events.emit('change');
    };
    player.events.on('time', () => this.syncPreview(false));
    player.events.on('play', (p) => {
      if (!p && this.recorder) this.stopRecording();
      this.syncPreview(true);
    });
    player.events.on('scene', () => {
      if (this.recorder && this.player.sceneIndex !== this.recSceneIndex) {
        this.player.setPlaying(false); // stops the recorder via the play hook
      }
      this.syncPreview(true);
    });
  }

  get recording(): boolean { return this.recorder !== null; }

  async refresh(): Promise<void> {
    try { this.map = await api.fetchTakes(); } catch { this.map = {}; }
    this.events.emit('change');
  }

  candidate(sceneId: string): string | null {
    return this.map[sceneId]?.candidate ?? null;
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
    this.preview.pause();
    this.audition.pause();
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
    if (this.auditioning === file) { this.audition.pause(); return; }
    this.preview.pause();
    this.audition.src = api.takeUrl(sceneId, file);
    void this.audition.play();
    this.auditioning = file;
    this.events.emit('change');
  }

  /* ------------------------- synced preview ----------------------------- */

  setPreviewEnabled(on: boolean): void {
    this.previewEnabled = on;
    this.syncPreview(true);
  }

  private syncPreview(hard: boolean): void {
    if (!this.previewEnabled || this.recorder) { this.preview.pause(); return; }
    const file = this.candidate(this.player.scene.id);
    if (!file) { this.preview.pause(); return; }
    const abs = new URL(api.takeUrl(this.player.scene.id, file), location.href).href;
    if (this.preview.src !== abs) { this.preview.src = abs; hard = true; }
    const t = this.player.localTime;
    if (this.player.playing) {
      if (hard || Math.abs(this.preview.currentTime - t) > 0.35) this.preview.currentTime = t;
      if (this.preview.paused) void this.preview.play().catch(() => {});
    } else {
      this.preview.pause();
    }
  }
}
