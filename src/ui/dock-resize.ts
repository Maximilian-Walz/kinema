import { getProject } from "../api";
import { el } from "./dom";

/* ============================================================================
   Resizable bottom dock.

   Adds a thin drag handle pinned to the top edge of the bottom grid row.
   Dragging changes the row height (clamped to 160..70vh) and writes the
   height in px to localStorage so it survives reloads. The setting is per
   project so a long-narration project can keep a tall timeline without
   forcing the same on shorter ones.

   The dock is the shared grid row that holds #timeline, #recordview, and
   #tuneview. We don't care which is visible; we just set the row height via a
   CSS custom property the grid template reads.
============================================================================ */

const STORAGE_PREFIX = "video-studio.dock-h";
const MIN_PX = 160;

function storageKey(): string {
    return `${STORAGE_PREFIX}:${getProject() ?? "__default__"}`;
}

function readStored(): number | null {
    try {
        const v = Number(localStorage.getItem(storageKey()));
        return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
        return null;
    }
}

function writeStored(px: number): void {
    try {
        localStorage.setItem(storageKey(), String(px));
    } catch { /* ignore */ }
}

function maxPx(): number {
    return Math.max(MIN_PX + 80, Math.round(window.innerHeight * 0.7));
}

function clamp(px: number): number {
    return Math.max(MIN_PX, Math.min(maxPx(), Math.round(px)));
}

export class DockResize {
    private handle: HTMLElement;
    private dragging = false;

    constructor() {
        /* the handle is positioned absolute relative to body so it tracks the
       top edge of the bottom dock; we re-position it via a sticky CSS rule */
        this.handle = el("div", {
            id: "dock-resize",
            title: "drag to resize the timeline / record / tune panel",
        });
        document.body.appendChild(this.handle);

        /* apply stored height immediately */
        const stored = readStored();
        if (stored !== null) this.setHeight(clamp(stored));

        this.handle.addEventListener("pointerdown", (ev) => this.beginDrag(ev));
        addEventListener("resize", () => {
            const stored2 = readStored();
            if (stored2 !== null) this.setHeight(clamp(stored2));
        });
    }

    private beginDrag(ev: PointerEvent): void {
        ev.preventDefault();
        this.dragging = true;
        this.handle.setPointerCapture(ev.pointerId);
        this.handle.classList.add("dragging");
        document.body.style.cursor = "ns-resize";

        const onMove = (mv: PointerEvent): void => {
            if (!this.dragging) return;
            const fromBottom = window.innerHeight - mv.clientY;
            this.setHeight(clamp(fromBottom));
        };
        const onUp = (): void => {
            this.dragging = false;
            this.handle.classList.remove("dragging");
            document.body.style.cursor = "";
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            /* persist the final height (read it back off the CSS variable) */
            const px = Number(
                getComputedStyle(document.documentElement)
                    .getPropertyValue("--dock-h").replace("px", "").trim(),
            );
            if (Number.isFinite(px)) writeStored(px);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    }

    private setHeight(px: number): void {
        document.documentElement.style.setProperty("--dock-h", px + "px");
    }
}
