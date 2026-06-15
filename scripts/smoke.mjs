/* boots the studio UI and the render mode in headless Chrome and checks the
   essentials: project loads, scenes mount, schedule applies, timeline builds,
   timings PUT round-trips. Run with the dev server up: node scripts/smoke.mjs */
import puppeteer from "puppeteer-core";
import { findChrome } from "../server/render.mjs";

const BASE = process.env.STUDIO_URL || "http://127.0.0.1:4321";
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
  /* ---------------- studio UI ---------------- */
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  /* / with no ?project= now shows the picker; boot the studio on the default
     project so the structural checks below (groupchat) line up */
  const projects = await (await fetch(BASE + "/api/projects")).json();
  const def = (projects.find((p) => p.default) || projects[0]).id;
  await page.goto(BASE + "/?project=" + def, {
    waitUntil: "networkidle0",
    timeout: 30000,
  });
  await page.waitForSelector("#scenecontent", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 800));

  ok((await page.$("#s1deck")) !== null, "scene 1 mounted");
  ok(
    await page.$eval("#s1deck", (el) => !el.classList.contains("on")),
    "schedule: s1deck off at t=0",
  );
  await page.evaluate(() => {
    /* seek via keyboard: 2 = scene 2 */
  });
  ok((await page.$$(".tl-track")).length === 5, "timeline: 5 tracks");
  ok((await page.$$(".tl-scene")).length === 9, "timeline: 9 scene blocks");
  ok(
    (await page.$$(".sp-line")).length === 4,
    "script panel: 4 lines for scene 1",
  );

  await page.keyboard.press("5");
  await new Promise((r) => setTimeout(r, 400));
  ok((await page.$("#threadcol")) !== null, "key 5 jumps to debate scene");
  await page.keyboard.press("ArrowRight"); // +5s -> round1 + adv1 on
  await new Promise((r) => setTimeout(r, 300));
  ok(
    await page.$eval("#adv1", (el) => el.classList.contains("on")),
    "schedule applies at t=5 in scene 5",
  );
  await page.keyboard.press("c");
  await new Promise((r) => setTimeout(r, 200));
  ok(
    await page.evaluate(() => document.body.classList.contains("clean")),
    "clean mode toggles",
  );
  await page.keyboard.press("c"); // back to the full UI — clean mode hides the timeline
  ok(
    errors.length === 0,
    "no page errors (studio)" + (errors.length ? ": " + errors[0] : ""),
  );

  /* ---------------- loop region via keyboard ---------------- */
  await page.keyboard.press("1");
  await page.keyboard.press("ArrowRight"); // t = 5
  await page.keyboard.press("i");
  await page.keyboard.press("ArrowRight"); // t = 10
  await page.keyboard.press("o");
  const loop = await page.evaluate(() => window.__studio.player.loop);
  ok(
    !!loop && Math.abs(loop.start - 5) < 0.1 && Math.abs(loop.end - 10) < 0.1,
    `I/O keys set loop region (${loop?.start}–${loop?.end})`,
  );
  await page.keyboard.press("Escape");
  ok(
    await page.evaluate(() => window.__studio.player.loop === null),
    "Escape clears the loop",
  );

  /* ---------------- drag a script clip + undo ---------------- */
  await page.keyboard.press("1");
  await new Promise((r) => setTimeout(r, 300));
  const before = await page.evaluate(() => ({
    ...window.__studio.player.project.scenes[0].lines[1],
  }));
  /* read coordinates inside the page right before the drag — element handles
     can go stale when the timeline rebuilds */
  const pos = await page.evaluate(() => {
    const c = document.querySelectorAll(".tl-script .tl-text")[1];
    c.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x + 40, pos.y, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 700)); // debounce save
  const after = await page.evaluate(() => ({
    ...window.__studio.player.project.scenes[0].lines[1],
  }));
  ok(
    after.from > before.from &&
      Math.abs(after.to - after.from - (before.to - before.from)) < 0.01,
    `dragging a script clip moves it (${before.from} -> ${after.from})`,
  );
  const disk = await page.evaluate(
    async () =>
      (await (await fetch("/api/project")).json()).scenes[0].lines[1].from,
  );
  ok(Math.abs(disk - after.from) < 0.01, "drag persisted to scene.json");
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 700));
  const undone = await page.evaluate(() => ({
    ...window.__studio.player.project.scenes[0].lines[1],
  }));
  ok(
    Math.abs(undone.from - before.from) < 0.01,
    "ctrl+Z restores the original timing",
  );

  /* ---------------- timings PUT round-trip ---------------- */
  const put = await page.evaluate(async () => {
    const proj = await (await fetch("/api/project")).json();
    const scene = proj.scenes[0];
    const r = await fetch("/api/scenes/" + scene.id + "/timings", {
      method: "PUT",
      body: JSON.stringify({
        len: scene.len,
        schedule: scene.schedule,
        captions: scene.captions,
        lines: scene.lines,
      }),
    });
    const back = await (await fetch("/api/project")).json();
    return (
      r.ok &&
      back.scenes[0].len === scene.len &&
      back.scenes[0].title === scene.title
    );
  });
  ok(put, "timings PUT round-trips and preserves title");

  /* ---------------- workspace modes ---------------- */
  /* TIME is the default; switch through RECORD and TUNE and back, verify the
     body class flips, the right bottom dock is visible, and the per-mode
     selectors land. */
  const modeChecks = [
    {
      key: "F1",
      mode: "record",
      visible: "#recordview",
      selector: ".rv-prompter",
      hidden: "#timeline",
    },
    {
      key: "F2",
      mode: "tune",
      visible: "#tuneview",
      selector: ".tv-nav-row",
      hidden: "#recordview",
    },
    {
      key: "F4",
      mode: "stage",
      visible: "#stageview",
      selector: ".sv-toolbar",
      hidden: "#timeline",
    },
    /* keep TIME last so the active-chip assertion below sees "TIME" */
    {
      key: "F3",
      mode: "time",
      visible: "#timeline",
      selector: ".tl-track",
      hidden: "#stageview",
    },
  ];
  for (const m of modeChecks) {
    await page.keyboard.press(m.key);
    await new Promise((r) => setTimeout(r, 350));
    const state = await page.evaluate(
      (s) => ({
        body: document.body.className,
        visibleDisplay: getComputedStyle(document.querySelector(s.visible))
          .display,
        hiddenDisplay: getComputedStyle(document.querySelector(s.hidden))
          .display,
        hits: document.querySelectorAll(s.selector).length,
      }),
      m,
    );
    const cls = state.body.includes("mode-" + m.mode);
    const vis = state.visibleDisplay !== "none";
    const hid = state.hiddenDisplay === "none";
    ok(
      cls && vis && hid && state.hits > 0,
      `${m.key} -> ${m.mode} (body=${cls ? "ok" : "no"}, visible=${vis ? "ok" : "no"}, hidden=${hid ? "ok" : "no"}, hits=${state.hits})`,
    );
  }
  /* mode chips in the transport bar reflect the active mode */
  const chipActive = await page.evaluate(() => {
    const c = document.querySelectorAll(".mode-chip.active");
    return c.length === 1 && c[0].textContent.includes("TIME");
  });
  ok(chipActive, "transport mode chip reflects active mode");

  /* export dialog opens via the transport button */
  await page.click(".t-export");
  await new Promise((r) => setTimeout(r, 250));
  ok(
    (await page.$(".export-overlay")) !== null,
    "transport export button opens dialog",
  );
  await page.keyboard.press("Escape"); // ESC also clears loop if any; close dialog via click
  await page.evaluate(() => {
    document.querySelector(".export-close")?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  ok((await page.$(".export-overlay")) === null, "export dialog closes");

  /* ---------------- render mode ---------------- */
  const rp = await browser.newPage();
  const rerrors = [];
  rp.on("pageerror", (e) => rerrors.push(String(e)));
  await rp.goto(BASE + "/?render=1", {
    waitUntil: "networkidle0",
    timeout: 30000,
  });
  ok(
    await rp.evaluate(() => !!window.__render),
    "render mode exposes __render",
  );
  await rp.evaluate(() => window.__render.ready);
  const lens = await rp.evaluate(() => window.__render.sceneLens());
  const proj = await (await fetch(BASE + "/api/project")).json();
  const expected = proj.scenes.reduce((a, s) => a + s.len, 0);
  ok(
    lens.length === proj.scenes.length &&
      Math.abs(lens.reduce((a, b) => a + b, 0) - expected) < 0.01,
    `sceneLens matches project (${proj.scenes.length} scenes / ${expected.toFixed(1)}s)`,
  );
  await rp.evaluate(() => window.__render.begin(4));
  await new Promise((r) => setTimeout(r, 300));
  ok(
    await rp.evaluate(() => !window.__render.finished()),
    "begin(4) starts playback",
  );
  ok((await rp.$("#threadcol")) !== null, "render mode mounted scene 5");
  ok(
    rerrors.length === 0,
    "no page errors (render)" + (rerrors.length ? ": " + rerrors[0] : ""),
  );
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURES` : "\nall good");
process.exit(failures ? 1 : 0);
