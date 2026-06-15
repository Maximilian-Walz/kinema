import type { MicMonitor } from "../audio/monitor";
import type { Takes } from "../audio/takes";
import { el } from "./dom";

/* ============================================================================
   Top-of-app recording banner. Slides in when a take is being captured and
   pins itself above all mode content (stage, transport, dock) so the user
   never loses the "you are recording" cue when switching modes.

   Mounts the shared MicMonitor meter inline so the operator can still see the
   input level while the rest of the UI is doing other things.

   Lives outside the grid via position:fixed; #app simply gets a top-padding
   class while the banner is visible so the stage doesn't disappear under it.
============================================================================ */

export class RecBar {
  private readonly element: HTMLElement;
  private readonly micMonitor: MicMonitor;
  private monitorHost: HTMLElement;

  constructor(takes: Takes, micMonitor: MicMonitor) {
    this.micMonitor = micMonitor;

    this.monitorHost = el("div", { class: "rb-monitor" });
    const dot = el("span", { class: "rb-dot" });
    const label = el("span", { class: "rb-label", text: "recording take" });
    const stop = el("button", { class: "rb-stop", text: "\u25a0 stop" });
    stop.onclick = () => takes.stopRecording();

    this.element = el("div", { id: "recbar" },
      dot, label, this.monitorHost, stop,
    );
    this.element.style.display = "none";
    document.body.appendChild(this.element);

    takes.events.on("recording", (on) => this.onRecording(on));
  }

  private onRecording(on: boolean): void {
    this.element.style.display = on ? "flex" : "none";
    document.body.classList.toggle("recording", on);
    if (on) {
      const meterEl = this.micMonitor.meterEl;
      if (meterEl) {
        this.monitorHost.replaceChildren(meterEl);
        this.micMonitor.start();
      }
    } else {
      this.monitorHost.replaceChildren();
    }
  }
}
