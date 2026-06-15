import { fetchProject, getProject } from "./api";
import { MicMonitor, PlaybackMeter } from "./audio/monitor";
import { Takes } from "./audio/takes";
import { Player } from "./engine/player";
import { History } from "./history";
import { bootRender } from "./render-mode";
import { TimingSync } from "./timings";
import type { SceneData } from "./types";
import { DockResize } from "./ui/dock-resize";
import { el } from "./ui/dom";
import { ExportDialog } from "./ui/export-dialog";
import { SidePanel } from "./ui/panels";
import { showPicker } from "./ui/picker";
import { RecBar } from "./ui/recbar";
import { RecordView } from "./ui/record-view";
import "./ui/styles.css";
import { Timeline } from "./ui/timeline";
import { Transport } from "./ui/transport";
import { TuneView } from "./ui/tune-view";
import { WorkspaceMode } from "./ui/workspace-mode";

/** Step to the previous (dir=-1) or next (dir=1) narration-line start on the
    global timeline. Crosses scene boundaries. */
function stepLine(player: Player, dir: -1 | 1): void {
  stepBoundary(player, dir, (scene) => scene.lines.map((l) => l.from));
}

/** Step to the previous/next animation element (schedule entry) `enter`
    time on the global timeline. Crosses scene boundaries. */
function stepSchedule(player: Player, dir: -1 | 1): void {
  stepBoundary(player, dir, (scene) => scene.schedule.map((s) => s.enter));
}

/** Shared "find next interesting time" stepper. The caller supplies the
    extractor (line starts, schedule enters, ...). We pick the nearest
    candidate strictly in the requested direction inside the current scene,
    falling through to neighbouring scenes if there isn't one. */
function stepBoundary(
  player: Player,
  dir: -1 | 1,
  pick: (scene: SceneData) => number[],
): void {
  const { index, local } = player.cursor();
  const scenes = player.project.scenes;
  const epsilon = 0.001; // land just inside the target so highlights pick it up
  const fuzz = 0.05; // avoid ping-ponging on the boundary we're sitting on

  const here = pick(scenes[index]).slice().sort((a, b) => a - b);
  if (dir > 0) {
    const t = here.find((x) => x > local + fuzz);
    if (t !== undefined) {
      player.seek(player.offsets[index] + t + epsilon);
      return;
    }
  } else {
    for (let i = here.length - 1; i >= 0; i--) {
      if (here[i] < local - fuzz) {
        player.seek(player.offsets[index] + here[i] + epsilon);
        return;
      }
    }
  }

  /* nothing left in this scene -- walk neighbouring scenes */
  for (let ni = index + dir; ni >= 0 && ni < scenes.length; ni += dir) {
    const list = pick(scenes[ni]).slice().sort((a, b) => a - b);
    if (!list.length) continue;
    const t = dir > 0 ? list[0] : list[list.length - 1];
    player.seek(player.offsets[ni] + t + epsilon);
    return;
  }
}

if (new URLSearchParams(location.search).has("render")) {
  bootRender();
} else if (!getProject()) {
  /* no ?project= -> let the user pick one before booting the studio */
  void showPicker();
} else {
  bootStudio().catch(showBootError);
}

/* boot failed (project.json invalid, a scene.json missing, unknown ?project=,
   server down): show a readable screen instead of a blank stage. */
function showBootError(err: unknown): void {
  document.title = "video-studio — error";
  const app = document.getElementById("app")!;
  app.textContent = "";
  const id = getProject();
  app.append(
    el(
      "div",
      { class: "picker" },
      el("h1", { text: "could not load project" }),
      el("p", {
        class: "pick-sub",
        text: id ? `project: ${id}` : "default project",
      }),
      el("pre", {
        class: "boot-error",
        text: String((err as Error)?.message || err),
      }),
      el("p", {
        class: "pick-empty",
        text:
          "check project.json and that every scene has a scene.json, then reload.",
      }),
    ),
  );
}

async function bootStudio(): Promise<void> {
  const project = await fetchProject();
  document.title = `${project.name} — video-studio`;

  /* content styles: theme once, scene css swapped by the engine */
  const themeStyle = document.createElement("style");
  themeStyle.textContent = project.theme;
  const sceneStyle = document.createElement("style");
  document.head.append(themeStyle, sceneStyle);

  /* ------------------------------ layout ------------------------------- */
  const content = el("div", { id: "scenecontent" });
  const stage = el("div", { id: "stage" }, content);
  stage.style.width = project.width + "px";
  stage.style.height = project.height + "px";
  const frame = el("div", { id: "frame" }, stage);
  const stagearea = el("div", { id: "stagearea" }, frame);
  const side = el("aside", { id: "side" });
  const transport = el("div", { id: "transport" });
  const timeline = el("div", { id: "timeline" });
  const recordview = el("div", { id: "recordview" });
  const tuneview = el("div", { id: "tuneview" });

  const app = document.getElementById("app")!;
  app.append(stagearea, side, transport, timeline, recordview, tuneview);

  /* ------------------------------- wiring ------------------------------- */
  const player = new Player(project, content, sceneStyle);
  const takes = new Takes(player);
  const sync = new TimingSync(player);
  const history = new History();
  const mode = new WorkspaceMode();
  mode.installHotkeys();
  const micMonitor = new MicMonitor(takes);
  const playbackMeter = new PlaybackMeter(takes);
  const exportDialog = new ExportDialog(player);

  new Transport(transport, player, takes, sync, mode, exportDialog);
  const sidePanel = new SidePanel(
    side,
    player,
    takes,
    sync,
    history,
    mode,
    playbackMeter,
  );
  const tl = new Timeline(timeline, player, takes, sync, history);
  new RecordView(recordview, player, takes, micMonitor);
  new TuneView(tuneview, player, takes);
  new DockResize();
  new RecBar(takes, micMonitor, player);
  /* mode switches re-flow the grid; trigger a rescale so the stage fits */
  mode.events.on("change", () => {
    sidePanel.onModeChange();
    rescale();
  });

  /* --------------------------- stage scaling ---------------------------- */
  function rescale(): void {
    const pad = document.body.classList.contains("clean") ? 0 : 18;
    const r = stagearea.getBoundingClientRect();
    const w = Math.max(
      100,
      Math.min(
        r.width - pad * 2,
        (r.height - pad * 2) * (project.width / project.height),
      ),
    );
    const h = w * (project.height / project.width);
    frame.style.width = w + "px";
    frame.style.height = h + "px";
    stage.style.transform = `scale(${w / project.width})`;
  }
  addEventListener("resize", rescale);
  new ResizeObserver(rescale).observe(stagearea);
  rescale();

  /* ----------------------------- keyboard ------------------------------- */
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    /* let inline editors type in peace */
    const tag = t.tagName;
    if (
      tag === "TEXTAREA" ||
      (tag === "INPUT" && (t as HTMLInputElement).type === "text")
    ) return;
    if (tag === "INPUT" || tag === "SELECT" || tag === "BUTTON") t.blur();

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      const scene = e.shiftKey ? history.redo() : history.undo();
      if (scene) sync.changed(scene);
    } else if (ctrl && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      const scene = history.redo();
      if (scene) sync.changed(scene);
    } else if (e.code === "Space") {
      e.preventDefault();
      player.toggle();
    } else if (e.key === "r" && !e.shiftKey) {
      e.preventDefault();
      if (takes.recording || takes.counting) {
        takes.stopRecording();
      } else {
        /* Recording is a record-mode activity: switch first so the user has
           the prompter, monitor, and take list visible. The mode switch is
           a no-op when already in record mode. startRecordingWithCountIn
           auto-arms the mic if it isn't already. */
        mode.set("record");
        void takes.startRecordingWithCountIn();
      }
    } else if (e.key === "R" && e.shiftKey) player.restartScene();
    else if (e.key === "c" || e.key === "C") {
      document.body.classList.toggle("clean");
      rescale();
    } else if (e.key === "i" || e.key === "I") {
      player.setLoop({
        start: player.time,
        end: player.loop?.end ?? player.total,
      });
    } else if (e.key === "o" || e.key === "O") {
      player.setLoop({ start: player.loop?.start ?? 0, end: player.time });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      tl.deleteSelection();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      /* Arrow-key navigation, in escalating granularity:
           plain     -> next/prev narration LINE
           Shift     -> next/prev animation ELEMENT (schedule entry)
           Ctrl/Meta -> next/prev SCENE
           Alt       -> coarse +/-5 s seek
         Modifier combinations are mutually exclusive; pick the most specific
         one set. */
      e.preventDefault();
      const dir: -1 | 1 = e.key === "ArrowRight" ? 1 : -1;
      if (e.altKey) {
        player.seek(player.time + dir * 5);
      } else if (e.ctrlKey || e.metaKey) {
        player.seekScene(player.sceneIndex + dir);
      } else if (e.shiftKey) {
        stepSchedule(player, dir);
      } else {
        stepLine(player, dir);
      }
    } else if (e.key === "[") player.seekScene(player.sceneIndex - 1);
    else if (e.key === "]") player.seekScene(player.sceneIndex + 1);
    else if (e.key >= "1" && e.key <= "9") {
      player.seekScene(parseInt(e.key, 10) - 1);
    } else if (e.key === "Escape") {
      if (takes.recording || takes.counting) takes.stopRecording();
      else if (player.loop) player.setLoop(null);
    }
  });

  await takes.refresh();
  player.update(0);

  /* for the smoke tests and console debugging */
  Object.assign(window as object, {
    __studio: { player, takes, sync, history, timeline: tl },
  });
}
