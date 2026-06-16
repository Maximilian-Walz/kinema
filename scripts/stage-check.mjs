/* ad-hoc verification for STAGE mode (T12-T18) against the intro project.
   Run with the dev server up: node scripts/stage-check.mjs [baseUrl] */
import puppeteer from "puppeteer-core";
import { findChrome } from "../server/render.mjs";

const BASE = process.argv[2] || process.env.STUDIO_URL || "http://127.0.0.1:4321";
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? "  ok " : "FAIL ") + name);
  if (!cond) failures++;
};

/* inspector groups live behind tabs (TEXT | LOOK | TIMING) — one shown at a
   time; click the matching tab before querying that group's DOM. */
const selectTab = async (page, name) => {
  await page.evaluate((n) => {
    const t = [...document.querySelectorAll(".sv-tab")].find((b) => b.textContent === n);
    t?.click();
  }, name);
  await new Promise((r) => setTimeout(r, 100));
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-sandbox", "--mute-audio"],
  defaultViewport: { width: 1600, height: 900 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/?project=intro", { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector("#scenecontent", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 600));

  /* --- T13: F4 switches to STAGE --- */
  await page.keyboard.press("F4");
  await new Promise((r) => setTimeout(r, 400));
  const st = await page.evaluate(() => ({
    body: document.body.className,
    svVisible: getComputedStyle(document.querySelector("#stageview")).display !== "none",
    tlHidden: getComputedStyle(document.querySelector("#timeline")).display === "none",
    toolbar: !!document.querySelector(".sv-toolbar"),
  }));
  ok(st.body.includes("mode-stage") && st.svVisible && st.tlHidden && st.toolbar,
    "F4 -> STAGE (visible dock, timeline hidden, toolbar present)");

  /* --- scene 1 schedule renders as clips --- */
  const clipInfo = await page.evaluate(() => {
    const clips = [...document.querySelectorAll(".sv-lanes .tl-element")];
    const sched = window.__studio.player.project.scenes[0].schedule;
    return {
      count: clips.length,
      schedLen: sched.length,
      labels: clips.map((c) => c.querySelector(".tl-cliptext")?.textContent),
      tags: clips.map((c) => c.querySelector(".sv-tag")?.textContent),
    };
  });
  ok(clipInfo.count === clipInfo.schedLen, `element clips match schedule (${clipInfo.count}/${clipInfo.schedLen})`);

  /* --- T15: labels are readable, not raw ids; tag chips present --- */
  const titleClip = clipInfo.labels.find((l) => /video.?studio/i.test(l || ""));
  ok(!!titleClip, `auto-label reads element text (got "${clipInfo.labels[0]}", tag "${clipInfo.tags[0]}")`);

  /* --- T14: clicking a clip opens the inspector --- */
  await page.click(".sv-lanes .tl-element");
  await new Promise((r) => setTimeout(r, 200));
  await selectTab(page, "timing"); // the animation select lives in the TIMING group
  const insp = await page.evaluate(() => ({
    name: document.querySelector(".sv-insp-name")?.textContent,
    fields: document.querySelectorAll(".sv-field").length,
    hasFx: !!document.querySelector(".sv-select"),
  }));
  ok(insp.fields >= 2 && insp.hasFx, `inspector shows fields + animation select (name="${insp.name}")`);

  /* --- T17: setting fx adds the fx base class + animates with .on --- */
  const fx = await page.evaluate(async () => {
    const P = window.__studio.player;
    const sc = P.project.scenes[0];
    sc.schedule[0].fx = "up";
    P.refreshTimings();
    P.seek(0); // before enter (0.4)
    const beforeEl = document.querySelector("#" + sc.schedule[0].id);
    const baseBefore = beforeEl.classList.contains("fx-up");
    const onBefore = beforeEl.classList.contains("on");
    P.seek(P.offsets[0] + 2); // after enter
    const onAfter = document.querySelector("#" + sc.schedule[0].id).classList.contains("on");
    delete sc.schedule[0].fx;
    P.refreshTimings();
    const baseCleared = !document.querySelector("#" + sc.schedule[0].id).classList.contains("fx-up");
    return { baseBefore, onBefore, onAfter, baseCleared };
  });
  ok(fx.baseBefore && !fx.onBefore && fx.onAfter && fx.baseCleared,
    `fx preset: base class on, .on toggles, base clears when removed (${JSON.stringify(fx)})`);

  /* --- T18: element-text patch (leaf ok, non-leaf rejected) --- */
  const text = await page.evaluate(async () => {
    const leaf = await fetch("/api/scenes/01-what/element-text?project=intro", {
      method: "PUT", body: JSON.stringify({ id: "note", text: "patched note text" }),
    });
    const leafJson = await leaf.json();
    const reapplied = leafJson.html && leafJson.html.includes("patched note text");
    const nonleaf = await fetch("/api/scenes/01-what/element-text?project=intro", {
      method: "PUT", body: JSON.stringify({ id: "o1a", text: "x" }),
    });
    return { leafOk: leaf.ok && reapplied, nonLeafRejected: nonleaf.status === 400 };
  });
  ok(text.leafOk, "element-text patches a leaf element in scene.html");
  ok(text.nonLeafRejected, "element-text rejects an element with child markup");

  /* restore the note text so the repo file isn't left edited */
  await page.evaluate(async () => {
    await fetch("/api/scenes/01-what/element-text?project=intro", {
      method: "PUT", body: JSON.stringify({ id: "note", text: "the files on disk are the whole video" }),
    });
  });

  /* --- T19: click an element in the preview selects it + draws the box --- */
  await page.evaluate(() => window.__studio.player.seek(2)); // #title visible
  await page.click("#title");
  await new Promise((r) => setTimeout(r, 200));
  const selected = await page.evaluate(() => ({
    id: document.querySelector(".sv-insp-id")?.textContent,
    boxShown: (() => {
      const b = document.querySelector(".sv-ovl-sel");
      return !!b && getComputedStyle(b).display !== "none";
    })(),
  }));
  ok(selected.id === "#title" && selected.boxShown,
    `clicking #title selects it + draws the overlay box (id=${selected.id})`);

  /* bidirectional: selecting a clip highlights its element in the preview */
  await page.click(".sv-lanes .tl-element");
  await new Promise((r) => setTimeout(r, 150));
  const biSync = await page.evaluate(() => {
    const b = document.querySelector(".sv-ovl-sel");
    return !!b && getComputedStyle(b).display !== "none";
  });
  ok(biSync, "selecting a clip highlights its element in the preview");

  /* --- T20: nested text patch keeps siblings + structure --- */
  const nested = await page.evaluate(async () => {
    const r = await fetch("/api/scenes/01-what/element-html?project=intro", {
      method: "PUT",
      body: JSON.stringify({
        id: "fHtml",
        html: '<div class="ext">scene.html</div><div class="d">CHANGED</div>',
      }),
    });
    const j = await r.json();
    return {
      ok: r.ok,
      changed: j.html?.includes(">CHANGED<"),
      siblingKept: j.html?.includes(">scene.html<"),
      structureKept: j.html?.includes('id="fHtml"') && j.html?.includes('class="d"'),
    };
  });
  ok(nested.ok && nested.changed && nested.siblingKept && nested.structureKept,
    `element-html patches nested child text, keeps siblings (${JSON.stringify(nested)})`);

  /* inspector lists one text field per text run under a nested element */
  await page.evaluate(() => window.__studio.player.seek(13.5)); // fHtml visible
  await new Promise((r) => setTimeout(r, 150));
  await page.click("#fHtml");
  await new Promise((r) => setTimeout(r, 150));
  await selectTab(page, "text");
  const spanFields = await page.evaluate(() =>
    document.querySelectorAll(".sv-tabbody .sv-input[type=text]").length);
  ok(spanFields >= 2, `TEXT group lists each nested text run as a field (${spanFields})`);

  /* --- T21/T22: style + position overrides land in scene.css --- */
  const style = await page.evaluate(async () => {
    const put = (style) => fetch("/api/scenes/01-what/element-style?project=intro", {
      method: "PUT", body: JSON.stringify({ id: "title", style }),
    }).then((r) => r.json());
    let j = await put({ "font-size": "70px" });
    const hasFs = j.css.includes("studio:overrides") && /#title\{[^}]*font-size:70px/.test(j.css);
    j = await put({ color: "#ffffff" });
    const merged = /#title\{[^}]*font-size:70px/.test(j.css) && /#title\{[^}]*color:#ffffff/.test(j.css);
    j = await put({ translate: "10px 20px" });
    const hasTranslate = /#title\{[^}]*translate:10px 20px/.test(j.css);
    /* cleanup: drop every override prop -> region removed */
    j = await put({ "font-size": null, color: null, translate: null });
    const cleaned = !j.css.includes("studio:overrides");
    return { hasFs, merged, hasTranslate, cleaned };
  });
  ok(style.hasFs, "element-style writes a #id{} font-size override into scene.css");
  ok(style.merged, "element-style merges a second property into the same rule");
  ok(style.hasTranslate, "element-style stores a translate (drag-to-reposition) override");
  ok(style.cleaned, "clearing all props removes the overrides region");

  /* --- R2: TIME no longer carries an ELEMENTS track (4 tracks, scene-local
     element timing lives in SCENE) --- */
  await page.keyboard.press("F3");
  await new Promise((r) => setTimeout(r, 250));
  const timeTracks = await page.evaluate(() => ({
    tracks: document.querySelectorAll(".tl-track").length,
    hasElements: !!document.querySelector(".tl-elements"),
  }));
  ok(timeTracks.tracks === 4 && !timeTracks.hasElements,
    `TIME has 4 tracks, no ELEMENTS (${timeTracks.tracks})`);
  await page.keyboard.press("F4");
  await new Promise((r) => setTimeout(r, 250));

  /* --- T24: dragging the STAGE ruler scrubs the playhead --- */
  await page.evaluate(() => window.__studio.player.seek(0));
  const ruler = await page.evaluate(() => {
    const r = document.querySelector(".sv-ruler").getBoundingClientRect();
    return { x: r.x, y: r.y + r.height / 2, w: r.width };
  });
  await page.mouse.move(ruler.x + 8, ruler.y);
  await page.mouse.down();
  await page.mouse.move(ruler.x + ruler.w * 0.6, ruler.y, { steps: 6 });
  await page.mouse.up();
  const scrubbed = await page.evaluate(() => window.__studio.player.localTime);
  ok(scrubbed > 1, `dragging the STAGE ruler scrubs the playhead (local=${scrubbed.toFixed(2)})`);

  /* --- T25: selection overlay box shows, even for a not-yet-entered element --- */
  await page.click(".sv-lanes .tl-element"); // selects #title
  await new Promise((r) => setTimeout(r, 150));
  const selBox = await page.evaluate(() => {
    const b = document.querySelector(".sv-ovl-sel");
    return b ? { shown: getComputedStyle(b).display !== "none", w: b.getBoundingClientRect().width } : null;
  });
  ok(selBox && selBox.shown && selBox.w > 0, `selection overlay box is drawn (${JSON.stringify(selBox)})`);
  await page.evaluate(() => window.__studio.player.seek(0)); // title hidden (enter 0.4)
  await new Promise((r) => setTimeout(r, 120));
  const hiddenSel = await page.evaluate(() => {
    const b = document.querySelector(".sv-ovl-sel");
    return b && getComputedStyle(b).display !== "none" && b.getBoundingClientRect().width > 0;
  });
  ok(hiddenSel, "selection box shows even when the element is hidden before its entrance");

  /* hover box appears over the element under the cursor */
  await page.evaluate(() => window.__studio.player.seek(6));
  await new Promise((r) => setTimeout(r, 120));
  const hoverShown = await page.evaluate(() => {
    const sub = document.querySelector("#sub");
    const r = sub.getBoundingClientRect();
    sub.dispatchEvent(new PointerEvent("pointermove",
      { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true }));
    const b = document.querySelector(".sv-ovl-hover");
    return b && getComputedStyle(b).display !== "none";
  });
  ok(hoverShown, "hovering an element in the preview draws the hover box");

  /* --- T26: a selected+current clip keeps its (blue) selected ring --- */
  await page.evaluate(() => window.__studio.player.seek(1)); // #title current (enter 0.4)
  await page.click(".sv-lanes .tl-element");
  await new Promise((r) => setTimeout(r, 120));
  const ringColor = await page.evaluate(() => {
    const c = document.querySelector(".sv-lanes .tl-element.selected.current")
      ?? document.querySelector(".sv-lanes .tl-element.selected");
    return c ? getComputedStyle(c).outlineColor : null;
  });
  ok(ringColor === "rgb(121, 192, 255)", `selected clip keeps its blue ring over current (${ringColor})`);

  /* --- R5: double-click an element in the preview starts in-place text edit --- */
  await page.evaluate(() => window.__studio.player.seek(6)); // #sub visible
  await new Promise((r) => setTimeout(r, 100));
  await page.click("#sub", { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 150));
  const editing = await page.evaluate(() =>
    document.querySelector("#sub")?.getAttribute("contenteditable"));
  ok(editing === "plaintext-only", `double-click an element edits its text in place (${editing})`);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 100));

  /* double-click a timeline CLIP seeks to its element's entrance too */
  await page.evaluate(() => window.__studio.player.seek(6));
  await page.click(".sv-lanes .tl-element", { clickCount: 2 }); // first clip = #title (enter 0.4)
  await new Promise((r) => setTimeout(r, 150));
  const clipDbl = await page.evaluate(() => window.__studio.player.localTime);
  ok(Math.abs(clipDbl - 0.4) < 0.2, `double-click a clip seeks to its entrance (local=${clipDbl.toFixed(2)})`);

  /* "+ add exit" spawns the exit at the playhead (when past the entrance) */
  await page.click(".sv-lanes .tl-element"); // select #title (a marker)
  await new Promise((r) => setTimeout(r, 120));
  await selectTab(page, "timing"); // the "+ add exit" button lives in the TIMING group
  await page.evaluate(() => window.__studio.player.seek(5));
  await new Promise((r) => setTimeout(r, 100));
  const added = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".sp-body button")]
      .find((b) => /add exit/.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 250));
  const exitVal = await page.evaluate(() =>
    window.__studio.player.project.scenes[0].schedule.find((s) => s.id === "title")?.exit);
  ok(added && exitVal != null && Math.abs(exitVal - 5) < 0.2,
    `"+ add exit" spawns the exit at the playhead (exit=${exitVal})`);

  ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors[0] : ""));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURES` : "\nall good");
process.exit(failures ? 1 : 0);
