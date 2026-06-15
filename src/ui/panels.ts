import * as api from "../api";
import { computeNormalizeGain, measureLoudness } from "../audio/loudness";
import type { MicMonitor, PlaybackMeter } from "../audio/monitor";
import { TakeStrip } from "../audio/take-strip";
import type { Takes } from "../audio/takes";
import { fmt, type Player } from "../engine/player";
import type { History } from "../history";
import type { TimingSync } from "../timings";
import type { SceneData, SectionTakes, TakeChain } from "../types";
import { el } from "./dom";
import type { Mode, WorkspaceMode } from "./workspace-mode";

/* ============================================================================
   Side panel: SCRIPT (teleprompter), TAKES, EXPORT tabs.
   Recording auto-switches to SCRIPT so the narration is readable while
   speaking; a red bar with the stop button stays visible.
============================================================================ */

type Tab = "script" | "takes";

/* Default tab per workspace mode. T3/T4/T5 will replace each side-panel
   render with a mode-specific view; until then the mode just steers which of
   the existing tabs is shown so the bulky takes UI only appears in TUNE. */
const MODE_DEFAULT_TAB: Record<Mode, Tab> = {
  record: "script",
  tune: "takes",
  time: "script",
};

export class SidePanel {
  private readonly player: Player;
  private readonly takes: Takes;
  private readonly sync: TimingSync;
  private readonly history: History;
  private readonly mode: WorkspaceMode;
  private readonly micMonitor: MicMonitor;
  private readonly playbackMeter: PlaybackMeter;
  private readonly body: HTMLElement;
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = "script";
  /** debounce timers for per-section gain writes, keyed sceneId/lineId/file */
  private readonly chainTimers = new Map<string, number>();

  /** TakeStrip instances currently rendered (record + tune modes). Destroyed
      on every body render so their RAF loops stop. */
  private readonly takeStrips: TakeStrip[] = [];

  /** overlay element sitting over #hud showing the countdown number */
  private countdownOverlay: HTMLElement | null = null;

  constructor(
    root: HTMLElement,
    player: Player,
    takes: Takes,
    sync: TimingSync,
    history: History,
    mode: WorkspaceMode,
    micMonitor: MicMonitor,
    playbackMeter: PlaybackMeter,
  ) {
    this.player = player;
    this.takes = takes;
    this.sync = sync;
    this.history = history;
    this.mode = mode;
    this.micMonitor = micMonitor;
    this.playbackMeter = playbackMeter;

    const nav = el("div", { class: "sp-tabs" });
    (["script", "takes"] as Tab[]).forEach((t) => {
      const b = el("button", { text: t.toUpperCase() });
      b.onclick = () => this.show(t);
      this.tabButtons.set(t, b);
      nav.appendChild(b);
    });

    this.body = el("div", { class: "sp-body" });
    root.append(nav, this.body);

    player.events.on("scene", () => this.render());
    player.events.on("time", () => this.tick());
    player.events.on("timings", () => {
      if (this.tab === "script") this.render();
    });
    takes.events.on("change", () => {
      if (this.tab === "takes") this.render();
    });
    takes.events.on("countdown", (n) => this.onCountdown(n));

    takes.events.on("recording", (on) => {
      /* once recording starts, clear any remaining overlay */
      this.removeCountdownOverlay();
      /* recbar UI is owned by the top-level RecBar singleton now (T9).
         We only steer side-panel focus: drag the panel back to SCRIPT in
         non-RECORD modes so the operator can read the narration. */
      if (on && this.mode.mode !== "record") this.show("script");
      else if (!on && this.tab === "takes") this.render();
    });

    takes.events.on("monitor", () => {
      /* MicMonitor singleton has already (re)bound the widgets; just re-render
         the takes panel so the monitor block picks up the new state */
      if (this.tab === "takes") this.render();
    });

    this.show(MODE_DEFAULT_TAB[this.mode.mode]);
  }

  /** Called by main.ts after a mode switch. Picks the mode's default tab and
      re-renders. Recording / count-in are not interrupted -- the recording
      handler will still drag focus back to SCRIPT mid-take. */
  onModeChange(): void {
    if (this.takes.recording || this.takes.counting) return;
    this.show(MODE_DEFAULT_TAB[this.mode.mode]);
  }

  show(tab: Tab): void {
    /* leaving the TAKES tab while the monitor is armed (but not recording):
       stop the monitor so the OS mic indicator turns off */
    if (this.tab === "takes" && tab !== "takes" && !this.takes.recording) {
      if (this.takes.monitoring) this.takes.stopMonitor();
    }
    this.tab = tab;
    this.tabButtons.forEach((b, t) => b.classList.toggle("active", t === tab));
    this.render();
  }

  /* ------------------------------- render -------------------------------- */

  private render(): void {
    this.destroyTakeStrips();
    this.body.innerHTML = "";
    if (this.mode.mode === "record") {
      this.renderRecordSide();
      return;
    }
    if (this.mode.mode === "tune") {
      this.renderTuneSide();
      return;
    }
    /* TIME mode: side panel is the teleprompter. EXPORT now lives as a
       transport button (T8), so the tab routing only ever picks SCRIPT or
       TAKES from here. */
    if (this.mode.mode === "time") {
      this.renderScript();
      return;
    }
    if (this.tab === "script") this.renderScript();
    else this.renderTakes();
  }

  /* SCRIPT ----------------------------------------------------------------- */

  private lineEls: { div: HTMLElement; from: number; to: number }[] = [];

  private renderScript(): void {
    const scene = this.player.scene;
    const si = this.player.sceneIndex;
    this.lineEls = [];
    this.body.appendChild(
      el("div", { class: "sp-scenetitle", text: `${si + 1} · ${scene.title}` }),
    );
    const list = el("div", { class: "sp-lines" });
    scene.lines.forEach((ln, idx) => {
      const div = el(
        "div",
        { class: "sp-line", title: "click = jump · double-click = edit" },
        el("span", {
          class: "sp-linetime",
          text: `${fmt(ln.from)} – ${fmt(ln.to)}`,
        }),
        ln.text,
      );
      /* merge this line up into the previous one (granularity control) */
      if (idx > 0) {
        const merge = el("button", {
          class: "sp-merge",
          text: "⤴ merge up",
          title: "merge this line into the previous one",
        });
        merge.onclick = (e) => {
          e.stopPropagation();
          this.mergeUp(scene, idx);
        };
        div.appendChild(merge);
      }
      div.onclick = () => this.player.seek(this.player.offsets[si] + ln.from);
      div.ondblclick = () => {
        if (div.querySelector("textarea")) return;
        const ta = el("textarea", { class: "sp-edit" }) as HTMLTextAreaElement;
        ta.value = ln.text;
        ta.onclick = (e) => e.stopPropagation();
        const finish = (commit: boolean): void => {
          if (commit && ta.value !== ln.text) {
            const before = this.history.snapshot(scene);
            ln.text = ta.value;
            this.history.commit(scene, before);
            this.sync.changed(scene);
          }
          this.render();
        };
        ta.onblur = () => finish(true);
        ta.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") finish(false);
        };
        div.appendChild(ta);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      };
      list.appendChild(div);
      this.lineEls.push({ div, from: ln.from, to: ln.to });
    });
    this.body.appendChild(list);
  }

  /* merge line `idx` into the previous one: text joined, span widened to cover
     both, the merged-away line dropped, the surviving line keeps its id (and so
     its takes). The dropped line's takes are abandoned; warn first. */
  private mergeUp(scene: SceneData, idx: number): void {
    const a = scene.lines[idx - 1];
    const b = scene.lines[idx];
    if (!a || !b) return;
    const bHasTakes =
      !!(b.id && this.takes.section(scene.id, b.id)?.takes.length);
    if (
      bHasTakes && !confirm(
        "The merged-away line has recorded takes. Merging keeps the first line's " +
          "takes and drops the second line's takes. Continue?",
      )
    ) return;
    const before = this.history.snapshot(scene);
    a.text = (a.text + " " + b.text).trim();
    a.to = b.to;
    scene.lines.splice(idx, 1);
    this.history.commit(scene, before);
    this.sync.changed(scene);
    this.render();
  }

  /* TAKES ------------------------------------------------------------------ */

  private renderTakes(): void {
    const scene = this.player.scene;
    this.body.appendChild(
      el("div", { class: "sp-scenetitle", text: `takes · ${scene.title}` }),
    );

    /* ---- mic monitor block (input level, ticket 02) ---- */
    this.appendMonitorBlock();

    /* ---- playback meter block (post-processed output level, ticket 04) ---- */
    this.appendPlaybackMeterBlock();

    if (!scene.lines.length) {
      this.body.appendChild(
        el("div", {
          class: "sp-dim",
          text: "no narration lines in this scene yet",
        }),
      );
    }

    /* one block per section (script line): the line, its record button, and its
       take list with a candidate star. Recording auto-stops at the line end. */
    scene.lines.forEach((ln) => {
      const lineId = ln.id;
      const sect = lineId ? this.takes.section(scene.id, lineId) : undefined;
      const recording = this.takes.recording &&
        this.takes.recordingLine === lineId;
      const countingThis = this.takes.counting &&
        this.takes.countingLine === lineId;
      const block = el("div", {
        class: "sp-section" + (sect?.takes.length ? " has-takes" : ""),
      });

      const head = el("div", { class: "sp-sectionhead" });
      const dot = el("span", {
        class: "sp-sectiondot" + (sect?.takes.length ? " on" : ""),
        title: sect?.takes.length ? "recorded" : "no take yet",
      });
      const label = el("span", {
        class: "sp-sectiontext",
        title: ln.text,
        text: `${fmt(ln.from)}–${fmt(ln.to)} · ${ln.text}`,
      });
      const recClass = "sp-rec" +
        (recording ? " live" : countingThis ? " counting" : "");
      const recText = recording ? "■ stop" : countingThis ? "… wait" : "● rec";
      const rec = el("button", {
        class: recClass,
        text: recText,
        title:
          "record this line with 3-2-1 count-in (seeks to its start, stops at its end)",
      });
      rec.onclick = async () => {
        if (this.takes.recording || this.takes.counting) {
          this.takes.stopRecording();
          return;
        }
        const err = await this.takes.startRecordingWithCountIn(lineId);
        if (err) this.status(err);
      };
      head.append(dot, label, rec);
      block.appendChild(head);

      const list = el("div", { class: "sp-takes" });
      if (!sect || !sect.takes.length) {
        list.appendChild(el("div", { class: "sp-dim", text: "no takes yet" }));
      } else {
        sect.takes.forEach((tk, n) => {
          const row = el("div", {
            class: "sp-take" + (tk.file === sect.candidate ? " cand" : ""),
          });
          const play = el("button", {
            text: this.takes.auditioning === tk.file ? "⏸" : "▶",
          });
          play.onclick = () =>
            this.takes.toggleAudition(scene.id, lineId!, tk.file);
          const name = el("span", {
            class: "sp-takename",
            text: `take ${n + 1} · ${
              new Date(tk.created).toLocaleTimeString()
            }`,
            title: tk.file,
          });
          const star = el("button", {
            class: "sp-star",
            text: tk.file === sect.candidate ? "★" : "☆",
            title: "pick as the take used in preview and export",
          });
          star.onclick = async () => {
            await api.pickTake(scene.id, lineId!, tk.file);
            await this.takes.refresh();
          };
          const del = el("button", { text: "✕", title: "move to trash" });
          del.onclick = async () => {
            if (!confirm("Move this take to trash?")) return;
            await api.deleteTake(scene.id, lineId!, tk.file);
            await this.takes.refresh();
          };
          row.append(play, name, star, del);
          list.appendChild(row);
        });
      }
      block.appendChild(list);
      /* "post" controls for the candidate take (gain, high-pass), applied in
         preview, audition and export. Only shown once a take is picked. */
      if (sect && sect.candidate && lineId) {
        this.appendPostControls(block, scene.id, lineId, sect);
      }
      this.body.appendChild(block);
    });

    const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = this.takes.previewEnabled;
    cb.onchange = () => this.takes.setPreviewEnabled(cb.checked);
    this.body.appendChild(
      el(
        "label",
        { class: "sp-checkbox" },
        cb,
        " play picked takes during playback",
      ),
    );
    this.body.appendChild(el("div", { class: "sp-status" }));
  }

  /** Render the arm-mic toggle and, when armed, the live Meter + scrolling
  /** Render the arm-mic toggle and, when armed, mount the shared live
      waveform + level meter from MicMonitor. The singleton owns lifecycle;
      this view just supplies a host element. */
  private appendMonitorBlock(): void {
    const armed = this.takes.monitoring;
    const block = el("div", { class: "sp-monitor" + (armed ? " armed" : "") });

    const armBtn = el("button", {
      class: "sp-arm" + (armed ? " live" : ""),
      text: armed ? "disarm mic" : "arm mic / monitor",
      title: armed
        ? "disarm the microphone (releases the device)"
        : "open the mic for level monitoring before recording (no speaker feedback)",
    });
    armBtn.onclick = async () => {
      if (armed) {
        this.takes.stopMonitor();
      } else {
        const err = await this.takes.startMonitor();
        if (err) this.status(err);
      }
    };
    block.appendChild(armBtn);

    if (armed && this.micMonitor.active) {
      const vis = el("div", { class: "sp-monitor-vis" });
      /* shared singleton: replaces children of `vis` with waveform + meter */
      this.micMonitor.attach(vis);

      /* clip warning -- shown via CSS when the meter's clip LED is lit */
      const clipWarn = el("div", {
        class: "sp-monitor-clip",
        text: "input clipping -- lower your level",
      });

      /* poll the clip LED state at ~8 Hz to toggle the warning */
      const clipLed = this.micMonitor.meterClipEl;
      if (clipLed) {
        const pollClip = (): void => {
          const clipping = clipLed.classList.contains("clipped");
          clipWarn.classList.toggle("visible", clipping);
        };
        const intervalId = window.setInterval(pollClip, 120);
        /* clean up when the block is detached (next render tears it down) */
        const observer = new MutationObserver(() => {
          if (!block.isConnected) {
            clearInterval(intervalId);
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }

      block.appendChild(vis);
      block.appendChild(clipWarn);
    }

    this.body.appendChild(block);
  }

  /** Render the playback level meter block (post-processing output). The
      PlaybackMeter singleton owns the Meter; this view supplies the host. */
  private appendPlaybackMeterBlock(): void {
    const block = el("div", { class: "sp-playback-meter" });
    const label = el("span", { class: "sp-playback-label", text: "playback" });

    /* "match all takes" button -- measures every picked take across all scenes
       and sets each gain to the shared -18 dBFS RMS target (peak-capped at -1
       dBFS). Idempotent: measurement is always on the raw file. */
    const matchBtn = el("button", {
      class: "sp-normalize-all",
      text: "match all takes",
      title:
        "normalize every picked take to -18 dBFS RMS (peak ceiling -1 dBFS)",
    });
    matchBtn.onclick = () =>
      void this.matchAllTakes(matchBtn as HTMLButtonElement);

    const meterHost = el("div", { class: "sp-playback-meter-host" });
    this.playbackMeter.attach(meterHost);

    block.append(label, meterHost, matchBtn);
    this.body.appendChild(block);
  }

  /** Measure and normalize every picked take across all scenes to TARGET_RMS_DB.
      Progress is shown on the button text while running. Re-running is idempotent
      because measurement is always on the raw file. */
  private async matchAllTakes(btn: HTMLButtonElement): Promise<void> {
    /* collect all (sceneId, lineId, file) triples that have a picked take */
    const jobs: Array<{ sceneId: string; lineId: string; file: string }> = [];
    for (const [sceneId, lines] of Object.entries(this.takes.map)) {
      for (const [lineId, sect] of Object.entries(lines)) {
        if (sect.candidate) {
          jobs.push({ sceneId, lineId, file: sect.candidate });
        }
      }
    }
    if (!jobs.length) {
      this.status("no picked takes to normalize");
      return;
    }

    btn.disabled = true;
    const origText = btn.textContent ?? "match all takes";
    let done = 0;
    const total = jobs.length;
    btn.textContent = `normalizing 0/${total}`;

    let errors = 0;
    for (const { sceneId, lineId, file } of jobs) {
      const url =
        new URL(api.takeUrl(sceneId, lineId, file), location.href).href;
      const result = await measureLoudness(url);
      if (!result) {
        errors++;
        done++;
        btn.textContent = `normalizing ${done}/${total}`;
        continue;
      }
      const gainDb = computeNormalizeGain(result);
      /* merge gain into the existing chain; preserve all other effects */
      const prev = this.takes.chain(sceneId, lineId) ?? {};
      const next: TakeChain = { ...prev, gainDb };
      if (next.gainDb === 0) delete next.gainDb;
      /* update local map so preview/audition picks up the change immediately */
      const target = (this.takes.map[sceneId] ||= {})[lineId] ||= {
        candidate: file,
        offset: 0,
        takes: [],
      };
      target.chain = Object.keys(next).length ? next : undefined;
      /* persist to disk (no debounce; these writes are intentional) */
      await api.setTakeChain(sceneId, lineId, file, target.chain ?? {}).catch(
        (e) => {
          errors++;
          console.warn("[normalize] setTakeChain failed:", e);
        },
      );
      done++;
      btn.textContent = `normalizing ${done}/${total}`;
    }

    /* re-render so the gain sliders reflect the new values */
    this.takes.events.emit("change");
    btn.disabled = false;
    btn.textContent = origText;
    if (errors) {
      this.status(
        `normalized ${total - errors}/${total} takes (${errors} failed)`,
      );
    } else this.status(`normalized ${total} takes to -18 dBFS`);
  }

  /* The candidate take's post chain: high-pass toggle + freq slider, then gate
     toggle + controls, then compressor toggle + controls, then gain slider. The
     sections appear in the canonical chain order (highpass -> gate -> compressor
     -> gain), matching buildChain and the ffmpeg filter. The write is debounced like
     timing edits; the local map is updated immediately so preview/audition pick
     the new chain up on the next sync without waiting for the round-trip. */
  private appendPostControls(
    block: HTMLElement,
    sceneId: string,
    lineId: string,
    sect: SectionTakes,
  ): void {
    const file = sect.candidate!;
    const post = el("div", { class: "sp-post" });

    /* Collapsible card builder. Each effect lives in a <details> element so
       we get open/close for free; the <summary> shows the effect name, a
       small live summary string ("off", "+2.0 dB", "voice · -24 dB · 3:1"),
       and a chevron. The summary updater is returned so the per-effect paint
       functions can refresh it whenever the chain changes. Default open state
       is set per call -- we open only effects that are currently enabled. */
    const mkCard = (
      name: string,
      defaultOpen: boolean,
    ): {
      card: HTMLDetailsElement;
      body: HTMLElement;
      setSummary: (text: string, on: boolean) => void;
    } => {
      const card = el("details", { class: "sp-post-card" }) as HTMLDetailsElement;
      if (defaultOpen) card.open = true;
      const summary = document.createElement("summary");
      summary.className = "sp-post-summary";
      const nameEl = el("span", { class: "sp-post-name", text: name });
      const valEl = el("span", { class: "sp-post-vsum", text: "off" });
      const chev = el("span", { class: "sp-post-chev", text: "▾" });
      summary.append(nameEl, valEl, chev);
      card.appendChild(summary);
      const body = el("div", { class: "sp-post-body" });
      card.appendChild(body);
      return {
        card,
        body,
        setSummary: (text: string, on: boolean) => {
          valEl.textContent = text;
          card.classList.toggle("on", on);
        },
      };
    };

    /* shared write helper -- reads current local chain state, merges a partial
       update, persists it locally and debounces the API call */
    const writeChain = (patch: Partial<TakeChain>): void => {
      const target = (this.takes.map[sceneId] ||= {})[lineId] ||= { ...sect };
      const prev = target.chain ?? {};
      const next = { ...prev, ...patch };
      /* drop fields that are at their identity value so the chain stays minimal */
      if ((next.gainDb ?? 0) === 0) delete next.gainDb;
      if (!next.highpass) delete next.highpass;
      if (!next.gate) delete next.gate;
      if (!next.comp) delete next.comp;
      target.chain = Object.keys(next).length ? next : undefined;
      const key = `${sceneId}/${lineId}/${file}`;
      clearTimeout(this.chainTimers.get(key));
      this.chainTimers.set(
        key,
        window.setTimeout(() => {
          void api.setTakeChain(sceneId, lineId, file, target.chain ?? {})
            .catch((e) => this.status(String(e)));
        }, 400),
      );
    };

    /* shared labelled-slider row builder, used by the gate and compressor
       sections. The readout reflects the live slider value; callers wire the
       oninput that also persists the change. */
    const mkPostSlider = (
      label: string,
      min: number,
      max: number,
      step: number,
      unit: string,
      titleStr: string,
    ): {
      row: HTMLElement;
      slider: HTMLInputElement;
      readout: HTMLSpanElement;
    } => {
      const row = el("div", { class: "sp-post-row sp-post-comprow" });
      const lbl = el("span", {
        class: "sp-postlabel sp-postlabel-sm",
        text: label,
      });
      const slider = el("input", {
        type: "range",
        min: String(min),
        max: String(max),
        step: String(step),
        class: "sp-comp-slider",
        title: titleStr,
      }) as HTMLInputElement;
      const readout = el("span", { class: "sp-postval" }) as HTMLSpanElement;
      const fmtVal = (v: number): string =>
        v.toFixed(step < 1 ? (step < 0.01 ? 3 : 2) : 0) + " " + unit;
      slider.oninput = (): void => {
        readout.textContent = fmtVal(Number(slider.value));
      };
      readout.textContent = fmtVal(min);
      row.append(lbl, slider, readout);
      return { row, slider, readout };
    };

    /* --- high-pass section --- */
    const hpCard = mkCard("high-pass", !!this.takes.chain(sceneId, lineId)?.highpass);
    const hpRow = el("div", { class: "sp-post-row" });
    const hpLabel = el("span", { class: "sp-postlabel", text: "cutoff" });
    const hpToggle = el("input", {
      type: "checkbox",
      class: "sp-hp-toggle",
      title:
        "roll off low-frequency rumble and plosives (applies in preview, audition and export)",
    }) as HTMLInputElement;
    const hpFreqSlider = el("input", {
      type: "range",
      min: "20",
      max: "300",
      step: "5",
      class: "sp-hpfreq",
      title: "high-pass cutoff frequency in Hz (20..300)",
    }) as HTMLInputElement;
    const hpReadout = el("span", { class: "sp-postval" });

    const DEFAULT_HP_FREQ = 80;

    const currentHp = (): { freq: number } | undefined =>
      this.takes.chain(sceneId, lineId)?.highpass;
    const paintHp = (hp: { freq: number } | undefined): void => {
      hpToggle.checked = !!hp;
      hpFreqSlider.value = String(hp?.freq ?? DEFAULT_HP_FREQ);
      hpFreqSlider.disabled = !hp;
      hpReadout.textContent = hp ? hp.freq + " Hz" : "off";
      hpCard.setSummary(hp ? hp.freq + " Hz" : "off", !!hp);
    };

    hpToggle.onchange = (): void => {
      const freq = Math.max(
        20,
        Math.min(300, Number(hpFreqSlider.value) || DEFAULT_HP_FREQ),
      );
      const hp = hpToggle.checked ? { freq } : undefined;
      paintHp(hp);
      writeChain({ highpass: hp });
    };
    hpFreqSlider.oninput = (): void => {
      const freq = Math.max(20, Math.min(300, Number(hpFreqSlider.value)));
      const hp = { freq };
      paintHp(hp);
      writeChain({ highpass: hp });
    };

    paintHp(currentHp());
    hpRow.append(hpLabel, hpToggle, hpFreqSlider, hpReadout);
    hpCard.body.appendChild(hpRow);

    /* --- noise gate section --- */
    /* conservative voice preset used when the user enables the gate: a low
       threshold and partial attenuation (range) so it shuts room tone in the
       gaps without clipping word onsets or chattering. Sits after highpass and
       before the compressor (same position as the ffmpeg agate). */
    const GATE_VOICE: NonNullable<TakeChain["gate"]> = {
      threshold: -45,
      range: 40,
      attack: 0.005,
      release: 0.18,
    };

    const gateCard = mkCard("gate", !!this.takes.chain(sceneId, lineId)?.gate);
    const gateSection = el("div", { class: "sp-post-gate" });

    const gateToggleRow = el("div", { class: "sp-post-row" });
    const gateLabel = el("span", { class: "sp-postlabel", text: "enabled" });
    const gateToggle = el("input", {
      type: "checkbox",
      class: "sp-gate-toggle",
      title:
        "mute room tone and hiss between phrases (applies in preview, audition and export)",
    }) as HTMLInputElement;
    gateToggleRow.append(gateLabel, gateToggle);
    gateSection.appendChild(gateToggleRow);

    const gateControls = el("div", { class: "sp-post-gate-controls" });

    const gateThr = mkPostSlider(
      "threshold",
      -80,
      0,
      1,
      "dB",
      "gate threshold in dB (-80..0); the signal is attenuated while it sits below this",
    );
    const gateRange = mkPostSlider(
      "range",
      0,
      80,
      1,
      "dB",
      "attenuation applied when the gate is closed, in dB (0..80); lower = gentler",
    );

    gateControls.append(gateThr.row, gateRange.row);
    gateSection.appendChild(gateControls);

    const currentGate = (): NonNullable<TakeChain["gate"]> | undefined =>
      this.takes.chain(sceneId, lineId)?.gate;

    const paintGate = (
      gate: NonNullable<TakeChain["gate"]> | undefined,
    ): void => {
      const on = !!gate;
      gateToggle.checked = on;
      gateControls.style.display = on ? "" : "none";
      if (gate) {
        gateThr.slider.value = String(gate.threshold);
        gateThr.readout.textContent = gate.threshold.toFixed(0) + " dB";
        gateRange.slider.value = String(gate.range ?? GATE_VOICE.range);
        gateRange.readout.textContent =
          (gate.range ?? GATE_VOICE.range!).toFixed(0) + " dB";
      }
      gateCard.setSummary(
        gate ? `${gate.threshold.toFixed(0)} dB / -${(gate.range ?? GATE_VOICE.range!).toFixed(0)} dB` : "off",
        on,
      );
    };

    const readGateFromSliders = (): NonNullable<TakeChain["gate"]> => ({
      threshold: Math.max(-80, Math.min(0, Number(gateThr.slider.value))),
      range: Math.max(0, Math.min(80, Number(gateRange.slider.value))),
      attack: GATE_VOICE.attack,
      release: GATE_VOICE.release,
    });

    gateToggle.onchange = (): void => {
      const gate = gateToggle.checked ? { ...GATE_VOICE } : undefined;
      paintGate(gate);
      writeChain({ gate });
    };
    const applyGateSliders = (): void => {
      writeChain({ gate: readGateFromSliders() });
    };
    gateThr.slider.oninput = (): void => {
      gateThr.readout.textContent = Number(gateThr.slider.value).toFixed(0) +
        " dB";
      applyGateSliders();
    };
    gateRange.slider.oninput = (): void => {
      gateRange.readout.textContent =
        Number(gateRange.slider.value).toFixed(0) + " dB";
      applyGateSliders();
    };

    paintGate(currentGate());
    gateCard.body.appendChild(gateSection);

    /* --- compressor section --- */
    /* sensible voice preset used when the user enables the compressor */
    const COMP_VOICE: NonNullable<TakeChain["comp"]> = {
      threshold: -24,
      ratio: 3,
      attack: 0.01,
      release: 0.15,
    };
    /* additional presets: [label, values] */
    const COMP_PRESETS: Array<[string, NonNullable<TakeChain["comp"]>]> = [
      ["voice", { threshold: -24, ratio: 3, attack: 0.01, release: 0.15 }],
      ["podcast", { threshold: -18, ratio: 4, attack: 0.005, release: 0.10 }],
      ["gentle", { threshold: -30, ratio: 2, attack: 0.02, release: 0.25 }],
      ["hard", { threshold: -12, ratio: 8, attack: 0.003, release: 0.08 }],
    ];

    const compCard = mkCard("compressor", !!this.takes.chain(sceneId, lineId)?.comp);
    const compSection = el("div", { class: "sp-post-comp" });

    /* toggle row */
    const compToggleRow = el("div", { class: "sp-post-row" });
    const compLabel = el("span", { class: "sp-postlabel", text: "enabled" });
    const compToggle = el("input", {
      type: "checkbox",
      class: "sp-comp-toggle",
      title:
        "enable dynamic range compressor (evens out voice dynamics; applies in preview, audition and export)",
    }) as HTMLInputElement;

    /* preset selector */
    const compPresetSel = el("select", {
      class: "sp-comp-preset",
      title: "load a compressor preset",
    }) as HTMLSelectElement;
    const blankOpt = el("option", {
      value: "",
      text: "preset",
    }) as HTMLOptionElement;
    compPresetSel.appendChild(blankOpt);
    COMP_PRESETS.forEach(([name]) => {
      compPresetSel.appendChild(el("option", { value: name, text: name }));
    });

    compToggleRow.append(compLabel, compToggle, compPresetSel);
    compSection.appendChild(compToggleRow);

    /* detail rows (threshold, ratio, attack, release) */
    const compControls = el("div", { class: "sp-post-comp-controls" });

    const thrCtrl = mkPostSlider(
      "threshold",
      -60,
      0,
      1,
      "dB",
      "compressor threshold in dB (-60..0); levels above this are compressed",
    );
    const ratCtrl = mkPostSlider(
      "ratio",
      1,
      20,
      0.5,
      ":1",
      "compression ratio (1..20); higher = more aggressive",
    );
    const atkCtrl = mkPostSlider(
      "attack",
      0,
      1,
      0.005,
      "s",
      "compressor attack time in seconds (0..1)",
    );
    const relCtrl = mkPostSlider(
      "release",
      0,
      2,
      0.01,
      "s",
      "compressor release time in seconds (0..2)",
    );

    compControls.append(thrCtrl.row, ratCtrl.row, atkCtrl.row, relCtrl.row);
    compSection.appendChild(compControls);

    /* helpers to read the current compressor from local state and sync the UI */
    const currentComp = (): NonNullable<TakeChain["comp"]> | undefined =>
      this.takes.chain(sceneId, lineId)?.comp;

    const paintComp = (
      comp: NonNullable<TakeChain["comp"]> | undefined,
    ): void => {
      const on = !!comp;
      compToggle.checked = on;
      compControls.style.display = on ? "" : "none";
      compPresetSel.disabled = !on;
      if (comp) {
        thrCtrl.slider.value = String(comp.threshold);
        thrCtrl.readout.textContent = comp.threshold.toFixed(0) + " dB";
        ratCtrl.slider.value = String(comp.ratio);
        ratCtrl.readout.textContent = comp.ratio.toFixed(1) + " :1";
        atkCtrl.slider.value = String(comp.attack);
        atkCtrl.readout.textContent = comp.attack.toFixed(3) + " s";
        relCtrl.slider.value = String(comp.release);
        relCtrl.readout.textContent = comp.release.toFixed(2) + " s";
      }
      blankOpt.selected = true;
      compCard.setSummary(
        comp ? `${comp.threshold.toFixed(0)} dB · ${comp.ratio.toFixed(1)}:1` : "off",
        on,
      );
    };

    const readCompFromSliders = (): NonNullable<TakeChain["comp"]> => ({
      threshold: Math.max(-60, Math.min(0, Number(thrCtrl.slider.value))),
      ratio: Math.max(1, Math.min(20, Number(ratCtrl.slider.value))),
      attack: Math.max(0, Math.min(1, Number(atkCtrl.slider.value))),
      release: Math.max(0, Math.min(2, Number(relCtrl.slider.value))),
    });

    compToggle.onchange = (): void => {
      const comp = compToggle.checked ? COMP_VOICE : undefined;
      paintComp(comp);
      writeChain({ comp });
    };

    const applyCompSliders = (): void => {
      const comp = readCompFromSliders();
      writeChain({ comp });
    };

    thrCtrl.slider.oninput = (): void => {
      thrCtrl.readout.textContent = Number(thrCtrl.slider.value).toFixed(0) +
        " dB";
      applyCompSliders();
    };
    ratCtrl.slider.oninput = (): void => {
      ratCtrl.readout.textContent = Number(ratCtrl.slider.value).toFixed(1) +
        " :1";
      applyCompSliders();
    };
    atkCtrl.slider.oninput = (): void => {
      atkCtrl.readout.textContent = Number(atkCtrl.slider.value).toFixed(3) +
        " s";
      applyCompSliders();
    };
    relCtrl.slider.oninput = (): void => {
      relCtrl.readout.textContent = Number(relCtrl.slider.value).toFixed(2) +
        " s";
      applyCompSliders();
    };

    compPresetSel.onchange = (): void => {
      const preset = COMP_PRESETS.find(([name]) =>
        name === compPresetSel.value
      );
      if (!preset) return;
      const comp = { ...preset[1] };
      paintComp(comp);
      writeChain({ comp });
    };

    paintComp(currentComp());
    compCard.body.appendChild(compSection);
    /* --- gain section --- */
    const gainCard = mkCard(
      "gain",
      (this.takes.chain(sceneId, lineId)?.gainDb ?? 0) !== 0,
    );
    const gainRow = el("div", { class: "sp-post-row" });
    const gainLabel = el("span", { class: "sp-postlabel", text: "level" });
    const gainSlider = el("input", {
      type: "range",
      min: "-24",
      max: "24",
      step: "0.5",
      class: "sp-gain",
      title:
        "make the picked take louder or quieter (applies in preview, audition and export); also serves as make-up gain after the compressor",
    }) as HTMLInputElement;
    const gainReadout = el("span", { class: "sp-postval" });
    const gainReset = el("button", {
      class: "sp-postreset",
      text: "⟲",
      title: "reset gain to 0 dB",
    });

    const currentGain = (): number =>
      this.takes.chain(sceneId, lineId)?.gainDb ?? 0;
    const fmtDb = (db: number): string =>
      (db > 0 ? "+" : "") + db.toFixed(1) + " dB";
    const paintGain = (db: number): void => {
      gainSlider.value = String(db);
      gainReadout.textContent = fmtDb(db);
      gainReset.disabled = db === 0;
      gainCard.setSummary(db === 0 ? "0 dB" : fmtDb(db), db !== 0);
    };

    const applyGain = (db: number): void => {
      const clamped = Math.max(-24, Math.min(24, db));
      paintGain(clamped);
      writeChain({ gainDb: clamped === 0 ? 0 : clamped });
    };

    gainSlider.oninput = () => applyGain(Number(gainSlider.value));
    gainReset.onclick = () => applyGain(0);

    paintGain(currentGain());
    gainRow.append(gainLabel, gainSlider, gainReadout, gainReset);

    /* --- normalize button (sets gain to reach -18 dBFS RMS, peak-capped at -1
         dBFS). Measures the raw file, so re-running is idempotent. --- */
    const normRow = el("div", { class: "sp-post-row" });
    const normBtn = el("button", {
      class: "sp-normalize",
      text: "normalize",
      title:
        "set gain to reach -18 dBFS RMS (peak ceiling -1 dBFS); re-running gives the same result",
    });
    const normStatus = el("span", { class: "sp-postval" });

    normBtn.onclick = async () => {
      normBtn.disabled = true;
      normStatus.textContent = "measuring...";
      const url =
        new URL(api.takeUrl(sceneId, lineId, file), location.href).href;
      const result = await measureLoudness(url);
      if (!result) {
        normStatus.textContent = "decode failed";
        normBtn.disabled = false;
        return;
      }
      const gainDb = computeNormalizeGain(result);
      /* apply via the shared helper so the existing chain is merged (not clobbered) */
      applyGain(gainDb);
      normStatus.textContent = `RMS ${result.rmsDb.toFixed(1)} dB -> ${
        gainDb > 0 ? "+" : ""
      }${gainDb.toFixed(1)} dB`;
      normBtn.disabled = false;
    };

    normRow.append(normBtn, normStatus);

    gainCard.body.append(gainRow, normRow);

    post.append(hpCard.card, gateCard.card, compCard.card, gainCard.card);
    block.appendChild(post);
  }

  /* ------------------------------- countdown overlay --------------------- */

  /** Handle a countdown event from Takes.  n = 3/2/1 during count-in, 0 when
      recording starts (overlay removed by the recording handler), null when
      cancelled. */
  private onCountdown(n: number | null): void {
    if (n === null || n === 0) {
      this.removeCountdownOverlay();
      if (this.tab === "takes") this.render(); // reset rec button appearance
      return;
    }
    /* create the overlay on first beat */
    if (!this.countdownOverlay) {
      this.countdownOverlay = this.createCountdownOverlay();
    }
    this.countdownOverlay.textContent = String(n);
    this.countdownOverlay.classList.remove("cd-pop");
    /* force a reflow so re-adding the class re-triggers the animation */
    void this.countdownOverlay.offsetWidth;
    this.countdownOverlay.classList.add("cd-pop");
    /* also re-render the TAKES panel in real time so the button label updates */
    if (this.tab === "takes") this.render();
  }

  private createCountdownOverlay(): HTMLElement {
    const el2 = document.createElement("div");
    el2.className = "sp-countdown";
    /* mount over #hud (inside #stagearea) so it is always visible */
    const stagearea = document.getElementById("stagearea") ?? document.body;
    stagearea.appendChild(el2);
    return el2;
  }

  private removeCountdownOverlay(): void {
    if (this.countdownOverlay) {
      this.countdownOverlay.remove();
      this.countdownOverlay = null;
    }
  }

  private status(html: string): void {
    const elStatus = this.body.querySelector<HTMLElement>(".sp-status");
    if (elStatus) elStatus.innerHTML = html;
  }

  /* highlight + autoscroll the current script line ------------------------ */

  private tick(): void {
    if (this.mode.mode === "record" || this.mode.mode === "tune") {
      const id = this.activeLineId();
      if (id !== this.lastRecordLineId) {
        this.lastRecordLineId = id;
        this.render();
      }
      return;
    }
    if (this.tab !== "script" || !this.lineEls.length) return;
    const local = this.player.localTime;
    for (const le of this.lineEls) {
      const cur = local >= le.from && local < le.to;
      le.div.classList.toggle("current", cur);
      le.div.classList.toggle("done", local >= le.to);
      if (cur && this.player.playing) {
        le.div.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  /* RECORD side: compact takes for the line under the cursor ------------- */

  private lastRecordLineId: string | null = null;

  /** id of the script line under the cursor, or null if the cursor sits in
      a gap (no line covers `local`). */
  private activeLineId(): string | null {
    const local = this.player.localTime;
    for (const ln of this.player.scene.lines) {
      if (local >= ln.from && local < ln.to) return ln.id ?? null;
    }
    return null;
  }

  private renderRecordSide(): void {
    const scene = this.player.scene;
    const activeId = this.activeLineId();
    this.lastRecordLineId = activeId;

    this.body.appendChild(
      el("div", { class: "sp-scenetitle", text: `takes \u00b7 ${scene.title}` }),
    );

    /* current line card: last 2 takes with audition/star/delete */
    const activeLine = scene.lines.find((ln) => ln.id === activeId) ?? null;
    const activeSect = activeLine?.id ? this.takes.section(scene.id, activeLine.id) : undefined;
    const card = el("div", { class: "sp-rec-card" });
    if (activeLine) {
      card.appendChild(
        el("div", {
          class: "sp-rec-card-line",
          text: activeLine.text || "(empty line)",
          title: `${fmt(activeLine.from)}\u2013${fmt(activeLine.to)}`,
        }),
      );
      const recent = (activeSect?.takes ?? []).slice(-2).reverse();
      if (recent.length === 0) {
        card.appendChild(el("div", { class: "sp-dim", text: "no takes yet for this line" }));
      } else {
        const takesEl = el("div", { class: "sp-takes" });
        recent.forEach((tk, i) => {
          const total = activeSect!.takes.length;
          const ord = total - i; // most-recent first
          takesEl.appendChild(this.takeRow(scene.id, activeLine.id!, activeSect!, tk, ord, { withStrip: true }));
        });
        card.appendChild(takesEl);
      }
    } else {
      card.appendChild(
        el("div", { class: "sp-dim", text: "play or seek to a script line to record" }),
      );
    }
    this.body.appendChild(card);

    /* section dots: one compact row per line, clickable to jump the cursor */
    const dots = el("div", { class: "sp-rec-sections" });
    scene.lines.forEach((ln) => {
      const sect = ln.id ? this.takes.section(scene.id, ln.id) : undefined;
      const has = !!sect?.takes.length;
      const isActive = ln.id === activeId;
      const row = el("button", {
        class: "sp-rec-section" + (isActive ? " active" : "") + (has ? " has-takes" : ""),
        title: ln.text,
      });
      row.appendChild(el("span", { class: "sp-sectiondot" + (has ? " on" : "") }));
      row.appendChild(
        el("span", { class: "sp-rec-section-time", text: fmt(ln.from) }),
      );
      row.appendChild(
        el("span", { class: "sp-rec-section-text", text: ln.text || "(empty)" }),
      );
      if (sect?.takes.length) {
        row.appendChild(
          el("span", { class: "sp-rec-section-count", text: `${sect.takes.length}` }),
        );
      }
      row.onclick = () => {
        this.player.seek(this.player.offsets[this.player.sceneIndex] + ln.from + 0.001);
      };
      dots.appendChild(row);
    });
    this.body.appendChild(dots);
  }

  /* TUNE side: playback meter + post chain for the line under the cursor.
     The take browsing UI lives in TuneView; the side panel is dedicated to
     output level and the picked take's post processing. */
  private renderTuneSide(): void {
    const scene = this.player.scene;
    const activeId = this.activeLineId();
    this.lastRecordLineId = activeId;

    this.body.appendChild(
      el("div", { class: "sp-scenetitle", text: `post \u00b7 ${scene.title}` }),
    );

    /* always-visible playback meter + "match all takes" */
    this.appendPlaybackMeterBlock();

    if (!activeId) {
      this.body.appendChild(
        el("div", { class: "sp-dim", text: "seek to a script line to adjust its post chain" }),
      );
      return;
    }
    const activeLine = scene.lines.find((ln) => ln.id === activeId);
    const sect = this.takes.section(scene.id, activeId);
    const block = el("div", { class: "sp-section has-takes" });
    block.appendChild(
      el("div", {
        class: "sp-rec-card-line",
        text: activeLine?.text || "(empty line)",
        title: activeLine ? `${fmt(activeLine.from)}\u2013${fmt(activeLine.to)}` : "",
      }),
    );
    if (!sect?.candidate) {
      block.appendChild(
        el("div", { class: "sp-dim", text: "pick a take in the comparator to edit its post chain" }),
      );
    } else {
      this.appendPostControls(block, scene.id, activeId, sect);
    }
    this.body.appendChild(block);
  }

  /** A compact take row: play, name, star, delete + scrubbable waveform.
      Used by renderRecordSide and (in T4) the TUNE comparator. */
  private takeRow(
    sceneId: string,
    lineId: string,
    sect: SectionTakes,
    tk: SectionTakes["takes"][number],
    ord: number,
    opts: { withStrip?: boolean } = {},
  ): HTMLElement {
    const wrap = el("div", { class: "sp-take-wrap" });
    const row = el("div", { class: "sp-take" + (tk.file === sect.candidate ? " cand" : "") });
    const play = el("button", {
      text: this.takes.auditioning === tk.file ? "\u23f8" : "\u25b6",
      title: "audition this take",
    });
    play.onclick = () => this.takes.toggleAudition(sceneId, lineId, tk.file);
    const name = el("span", {
      class: "sp-takename",
      text: `take ${ord} \u00b7 ${new Date(tk.created).toLocaleTimeString()}`,
      title: tk.file,
    });
    const star = el("button", {
      class: "sp-star",
      text: tk.file === sect.candidate ? "\u2605" : "\u2606",
      title: "pick as the take used in preview and export",
    });
    star.onclick = async () => {
      await api.pickTake(sceneId, lineId, tk.file);
      await this.takes.refresh();
    };
    const del = el("button", { text: "\u2715", title: "move to trash" });
    del.onclick = async () => {
      if (!confirm("Move this take to trash?")) return;
      await api.deleteTake(sceneId, lineId, tk.file);
      await this.takes.refresh();
    };
    row.append(play, name, star, del);
    wrap.appendChild(row);
    if (opts.withStrip) {
      const strip = new TakeStrip(this.takes, sceneId, lineId, tk.file, { height: 36 });
      wrap.appendChild(strip.element);
      this.takeStrips.push(strip);
    }
    return wrap;
  }

  /** Destroy active TakeStrip instances so their RAF loops stop and the
      decode cache references are released for the next render. */
  private destroyTakeStrips(): void {
    for (const s of this.takeStrips) s.destroy();
    this.takeStrips.length = 0;
  }
}
