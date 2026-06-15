import { LiveWaveform } from "./live-waveform";
import { Meter } from "./meter";
import type { Takes } from "./takes";

/* ============================================================================
   Shared mic-monitor and playback-meter widget singletons.

   The Meter and LiveWaveform are heavy enough that we don't want them rebuilt
   every time a view re-renders, and their canvases are single-parent DOM
   nodes -- multiple views can't legally show the same instance at once.

   MicMonitor owns ONE pair of widgets (one Meter + one LiveWaveform) that
   live for the entire app lifetime. Both are bound to a routing AnalyserNode
   we own here, not directly to the mic. When the mic arms we connect the
   mic's source to that router; when it disarms we disconnect. The widgets
   never change, never get destroyed, and always show the same DOM nodes at
   the same dimensions -- so a "placeholder" is just the same widget drawing
   silence. No swap, no size drift, by construction.
============================================================================ */

export class MicMonitor {
    private readonly takes: Takes;

    /* the persistent widget pair + the analyser they read from */
    private meter: Meter | null = null;
    private waveform: LiveWaveform | null = null;
    private routerAnalyser: AnalyserNode | null = null;

    /* the currently-connected mic source (when armed), so we can disconnect
       it cleanly when the mic is released */
    private boundSource: AudioNode | null = null;

    private currentHost: HTMLElement | null = null;

    constructor(takes: Takes) {
        this.takes = takes;
        takes.events.on("monitor", (analyser) => this.bind(analyser));
    }

    /** True while the mic is armed. Widgets ALWAYS exist regardless. */
    get active(): boolean {
        return this.boundSource !== null;
    }

    /** Mount the meter + live waveform inside `host`, replacing whatever was
      already there. Safe to call repeatedly. Works whether the mic is armed
      or not -- when disarmed the widgets just draw silence at the same
      dimensions. */
    attach(host: HTMLElement): void {
        this.ensureWidgets();
        if (!this.meter || !this.waveform) return;
        if (this.currentHost && this.currentHost !== host) {
            this.currentHost.replaceChildren();
        }
        this.currentHost = host;
        host.replaceChildren();
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
    get meterEl(): HTMLElement | null {
        this.ensureWidgets();
        return this.meter?.element ?? null;
    }
    get waveformEl(): HTMLCanvasElement | null {
        this.ensureWidgets();
        return this.waveform?.canvas ?? null;
    }
    get meterClipEl(): HTMLElement | null {
        return this.meter?.element.querySelector(".vs-meter-clip") ?? null;
    }

    /** Start the widget animation loops. */
    start(): void {
        this.ensureWidgets();
        this.meter?.start();
        this.waveform?.start();
    }

    /** Lazily build the persistent widget pair the first time anyone asks for
        them. We use the Takes AudioContext (which is created on the first audio
        operation) and a silent router analyser; the meter reads silence until a
        real mic source is connected. */
    private ensureWidgets(): void {
        if (this.meter && this.waveform && this.routerAnalyser) return;
        const ctx = this.takes.getAudioContext();
        this.routerAnalyser = ctx.createAnalyser();
        this.routerAnalyser.fftSize = 2048;
        /* NOT connected to ctx.destination -- no feedback */
        this.meter = new Meter(this.routerAnalyser, {
            orientation: "horizontal",
            width: 120,
            height: 14,
        });
        this.waveform = new LiveWaveform(this.routerAnalyser, {
            width: 200,
            height: 40,
        });
    }

    /** Called when Takes emits 'monitor' with the live analyser node (or null).
        Instead of rebuilding the widgets, we route the source from the live
        analyser INTO our persistent router so the widgets read live audio. */
    private bind(analyser: AnalyserNode | null): void {
        this.ensureWidgets();
        /* disconnect any previously-bound source */
        if (this.boundSource && this.routerAnalyser) {
            try {
                this.boundSource.disconnect(this.routerAnalyser);
            } catch {
                /* ignore: source may already be disconnected */
            }
            this.boundSource = null;
        }
        if (analyser && this.routerAnalyser) {
            /* The analyser Takes hands us IS connected to the mic source.
               Plumb it into our router so the widgets see the same signal. */
            analyser.connect(this.routerAnalyser);
            this.boundSource = analyser;
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
            orientation: "horizontal",
            width: 120,
            height: 14,
        });
        this.meter.start();
    }

    get element(): HTMLElement {
        return this.meter.element;
    }

    /** Reparent the meter element into `host`. Single-parent DOM, so this
      detaches from whichever view had it last. */
    attach(host: HTMLElement): void {
        if (
            this.currentHost === host &&
            this.meter.element.parentElement === host
        ) return;
        this.currentHost = host;
        host.appendChild(this.meter.element);
    }
}
