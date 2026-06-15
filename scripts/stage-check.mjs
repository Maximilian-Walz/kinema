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

  ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors[0] : ""));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURES` : "\nall good");
process.exit(failures ? 1 : 0);
