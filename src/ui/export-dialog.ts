import * as api from "../api";
import type { Player } from "../engine/player";
import { el } from "./dom";

/* ============================================================================
   Export dialog. Modal overlay launched from the transport bar.

   - Format: fps (15 / 30 / 60) + scope ("this scene" / "full video")
   - Start: kicks off the export, swaps the form for a progress bar + status
   - Done: shows a link to the produced MP4
   - Close: dismisses the modal; the export keeps running in the background
     and the next open of the dialog (or boot) picks polling back up

   Polling lives here so an export survives mode switches and dialog close.
============================================================================ */

export class ExportDialog {
    private readonly player: Player;
    private overlay: HTMLElement | null = null;
    private form!: HTMLElement;
    private progress!: HTMLElement;
    private bar!: HTMLElement;
    private status!: HTMLElement;
    private cancelBtn!: HTMLButtonElement;
    private startBtns: HTMLButtonElement[] = [];
    private fpsSel!: HTMLSelectElement;
    private pollTimer: number | null = null;
    private isRunning = false;
    /** mirror of the transport-bar indicator; null when not present */
    private transportBadge: HTMLElement | null = null;

    constructor(player: Player) {
        this.player = player;
        /* on boot, resume polling if a previous export is still in flight */
        void this.checkResumeOnBoot();
    }

    /** Attach a small status badge inside the transport bar; updated by the
      poll loop. Returns the badge element so the caller can position it. */
    attachTransportBadge(): HTMLElement {
        this.transportBadge = el("span", { class: "t-export-badge" });
        return this.transportBadge;
    }

    open(): void {
        if (this.overlay) return;
        this.build();
        document.body.appendChild(this.overlay!);
        if (this.isRunning) this.showProgress();
    }

    close(): void {
        if (!this.overlay) return;
        this.overlay.remove();
        this.overlay = null;
    }

    private build(): void {
        const ov = el("div", { class: "export-overlay" });
        const panel = el("div", { class: "export-panel" });

        const head = el(
            "div",
            { class: "export-head" },
            el("h2", { text: "Export MP4" }),
        );
        const closeBtn = el("button", {
            class: "export-close",
            text: "\u2715",
            title: "close (the export keeps running)",
        });
        closeBtn.onclick = () => this.close();
        head.appendChild(closeBtn);

        /* form */
        this.fpsSel = el(
            "select",
            {},
            el("option", { value: "15", text: "15 fps draft" }),
            el("option", { value: "30", text: "30 fps", selected: "" }),
            el("option", { value: "60", text: "60 fps" }),
        ) as HTMLSelectElement;

        const sceneBtn = el("button", {
            class: "export-start",
            text: "this scene",
        }) as HTMLButtonElement;
        const fullBtn = el("button", {
            class: "export-start",
            text: "full video",
        }) as HTMLButtonElement;
        sceneBtn.onclick = () => void this.start(this.player.scene.id);
        fullBtn.onclick = () => void this.start(null);
        this.startBtns = [sceneBtn, fullBtn];

        this.form = el(
            "div",
            { class: "export-form" },
            el(
                "label",
                { class: "export-row" },
                el("span", { class: "export-label", text: "frame rate" }),
                this.fpsSel,
            ),
            el(
                "div",
                { class: "export-row" },
                el("span", { class: "export-label", text: "scope" }),
                sceneBtn,
                fullBtn,
            ),
            el("div", {
                class: "export-hint",
                text:
                    'Frame-exact render via headless Chrome; picked takes are muxed in. Iterate with "this scene" at 15 fps.',
            }),
        );

        /* progress */
        this.bar = el("i");
        this.progress = el(
            "div",
            { class: "export-progress" },
            el("div", { class: "export-bar" }, this.bar),
        );
        this.status = el("div", { class: "export-status" });
        this.cancelBtn = el("button", {
            class: "export-cancel",
            text: "background",
            title: "close this dialog; the export keeps running",
        }) as HTMLButtonElement;
        this.cancelBtn.onclick = () => this.close();

        panel.append(
            head,
            this.form,
            this.progress,
            this.status,
            this.cancelBtn,
        );
        ov.appendChild(panel);
        /* clicking the backdrop also closes */
        ov.addEventListener("click", (e) => {
            if (e.target === ov) this.close();
        });

        this.overlay = ov;
        if (this.isRunning) this.showProgress();
        else this.showForm();
    }

    private showForm(): void {
        if (this.form) this.form.style.display = "";
        if (this.progress) this.progress.style.display = "none";
        if (this.cancelBtn) this.cancelBtn.style.display = "none";
    }

    private showProgress(): void {
        if (this.form) this.form.style.display = "none";
        if (this.progress) this.progress.style.display = "";
        if (this.cancelBtn) this.cancelBtn.style.display = "";
    }

    private async start(scene: string | null): Promise<void> {
        const fps = parseInt(this.fpsSel.value, 10);
        this.startBtns.forEach((b) => b.disabled = true);
        try {
            await api.startExport(fps, scene);
        } catch (e) {
            this.setStatus("export failed to start: " + String(e));
            this.startBtns.forEach((b) => b.disabled = false);
            return;
        }
        this.isRunning = true;
        this.showProgress();
        this.setStatus("export starting\u2026");
        this.startPolling();
    }

    private async checkResumeOnBoot(): Promise<void> {
        try {
            const s = await api.exportStatus();
            if (s.state === "rendering" || s.state === "starting") {
                this.isRunning = true;
                this.startPolling();
            }
        } catch { /* ignore */ }
    }

    private startPolling(): void {
        if (this.pollTimer !== null) return;
        this.pollTimer = window.setInterval(() => void this.poll(), 700);
    }

    private stopPolling(): void {
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private async poll(): Promise<void> {
        let s;
        try {
            s = await api.exportStatus();
        } catch {
            return;
        }
        if (s.state === "rendering" || s.state === "starting") {
            const pct = s.totalFrames
                ? Math.round(100 * (s.frame || 0) / s.totalFrames)
                : 0;
            this.setProgress(pct);
            this.setStatus(
                `${
                    s.phase || "rendering"
                } \u00b7 frame ${s.frame}/${s.totalFrames} (${pct}%)`,
            );
            this.setBadge(`exporting \u2026 ${pct}%`);
        } else if (s.state === "done") {
            this.stopPolling();
            this.isRunning = false;
            this.setProgress(100);
            this.setStatus(
                `\u2713 done \u2014 <a href="${s.output}" target="_blank">open MP4</a>`,
            );
            this.setBadge("\u2713 export done", true);
            this.startBtns.forEach((b) => b.disabled = false);
        } else if (s.state === "error") {
            this.stopPolling();
            this.isRunning = false;
            this.setStatus(
                "\u2717 export error: " + ((s.message || "").split("\n")[0]),
            );
            this.setBadge("\u2717 export error", true);
            this.startBtns.forEach((b) => b.disabled = false);
        }
    }

    private setProgress(pct: number): void {
        if (this.bar) this.bar.style.width = pct + "%";
    }

    private setStatus(html: string): void {
        if (this.status) this.status.innerHTML = html;
    }

    private setBadge(text: string, transient = false): void {
        if (!this.transportBadge) return;
        this.transportBadge.textContent = text;
        this.transportBadge.style.display = "inline-flex";
        if (transient) {
            window.setTimeout(() => {
                if (this.transportBadge?.textContent === text) {
                    this.transportBadge.style.display = "none";
                }
            }, 6000);
        }
    }
}
