import type { Takes } from './takes';
import { LiveWaveform } from './live-waveform';
import { Meter } from './meter';

/* ============================================================================
   Shared mic-monitor and playback-meter widget singletons.

   The Meter and LiveWaveform are heavy enough that we don't want them rebuilt
   every time a view re-renders, and their canvases are single-parent DOM
   nodes -- multiple views can't legally show the same instance at once.

   So we own one Meter + LiveWaveform per audio source (mic monitor and the
   master playback bus) here, give views a tiny mount/unmount API, and let the
   widgets follow whichever view is currently asking. The lifetimes are tied to
   the analyser nodes, not to any individual view -- arming the mic creates the
   pair, disarming destroys them.
============================================================================ */

export class MicMonitor {
  private meter: Meter | null = null;
  private waveform: LiveWaveform | null = null;
  private currentHost: HTMLElement | null = null;

  constructor(takes: Takes) {
    takes.events.on('monitor', (analyser) => this.bind(analyser));
  }

  /** True while the mic is armed (the analyser exists). */
  get active(): boolean { return this.meter !== null; }

  /** Mount the meter + live waveform inside `host`, replacing whatever was
      already there. Safe to call repeatedly. No-op while the mic is disarmed. */
  attach(host: HTMLElement): void {
    if (!this.meter || !this.waveform) return;
    if (this.currentHost && this.currentHost !== host) this.currentHost.replaceChildren();
    this.currentHost = host;
    host.replaceChildren();
    /* waveform first (taller), then meter underneath -- views can re-style via
       parent class; this module owns lifecycle, not layout */
    host.append(this.waveform.canvas, this.meter.element);
    this.meter.start();
    this.waveform.start();
  }

  /** Detach from any host. Widgets keep running in memory; the next attach()
      will resume drawing into the new host. */
  detach(): void {
    if (this.currentHost) {
      this.currentHost.replaceChildren();
      this.currentHost = null;
    }
  }

  /** Direct access for callers that want to place meter and waveform in
      different containers (e.g. the recbar wants only the meter inline). */
  get meterEl(): HTMLElement | null { return this.meter?.element ?? null; }
  get waveformEl(): HTMLCanvasElement | null { return this.waveform?.canvas ?? null; }
  get meterClipEl(): HTMLElement | null {
    return this.meter?.element.querySelector('.vs-meter-clip') ?? null;
  }

  /** Start the widget animation loops (no-op while disarmed). Callers should
      invoke after mounting elements that were obtained via meterEl/waveformEl. */
  start(): void { this.meter?.start(); this.waveform?.start(); }

  private bind(analyser: AnalyserNode | null): void {
    /* tear down whatever is currently bound; the canvases are single-parent
       DOM nodes so we have to dispose them before re-creating */
    if (this.currentHost) { this.currentHost.replaceChildren(); this.currentHost = null; }
    if (this.meter) { this.meter.stop(); this.meter = null; }
    if (this.waveform) { this.waveform.stop(); this.waveform = null; }
    if (analyser) {
      this.meter = new Meter(analyser, { orientation: 'horizontal', width: 120, height: 14 });
      this.waveform = new LiveWaveform(analyser, { width: 200, height: 40 });
    }
  }
}

/* ----------------------------------------------------------------------------
   The playback meter is simpler: the master analyser is created once with the
   AudioContext and never torn down, so we build the Meter once and let any
   view mount/unmount it freely. */

export class PlaybackMeter {
  private readonly meter: Meter;
  private currentHost: HTMLElement | null = null;

  constructor(takes: Takes) {
    this.meter = new Meter(takes.playbackAnalyser, {
      orientation: 'horizontal', width: 120, height: 14,
    });
    this.meter.start();
  }

  get element(): HTMLElement { return this.meter.element; }

  /** Reparent the meter element into `host`. Single-parent DOM, so this
      detaches from whichever view had it last. */
  attach(host: HTMLElement): void {
    if (this.currentHost === host && this.meter.element.parentElement === host) return;
    this.currentHost = host;
    host.appendChild(this.meter.element);
  }
}
