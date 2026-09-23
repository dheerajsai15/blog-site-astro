// All page motion. Runs on every astro:page-load (first load and ClientRouter navigations)
// inside a gsap.context, which is reverted before the next page swaps in.
//
// Markup hooks:
//   data-intro="fade|lines|pop|fill|rows"  + optional data-intro-at="<seconds>" (fill animates its [data-fill] children)
//   data-nav / data-nav-pill              header nav pill
//   data-rows / data-row                  post lists with the gliding highlight
//   data-progress, data-toc, data-post-body, data-reveal, data-glow
//
// Head.astro adds `intro-pending` / `typing-pending` to <html> before first paint so animated
// elements start hidden; this script removes them once GSAP has set the start states.

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, SplitText);

const EASE = "expo.out";
const root = document.documentElement;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let ctx: gsap.Context | undefined;

document.addEventListener("astro:page-load", () => {
  ctx?.revert();
  const pageCtx = gsap.context(() => {});
  ctx = pageCtx;
  setupPage(pageCtx);
});

document.addEventListener("astro:before-swap", () => {
  ctx?.revert();
  ctx = undefined;
});

async function setupPage(pageCtx: gsap.Context) {
  codeBlocks();
  await document.fonts.ready;
  // The reader may have navigated away while fonts loaded.
  if (ctx !== pageCtx) return;

  pageCtx.add(() => {
    const motion = !reducedMotion();
    const tl = gsap.timeline({ defaults: { ease: EASE } });

    typeLogo(tl);
    if (root.classList.contains("intro-pending")) {
      intro(tl);
      root.classList.remove("intro-pending");
    }

    navPill(motion);
    rowHighlights(motion);
    readingProgress();
    tableOfContents(motion);
    if (motion) scrollReveals();
    refreshOnResize();
  });
}

// ---------- intro ----------

function intro(tl: gsap.core.Timeline) {
  let auto = 0;
  gsap.utils.toArray<HTMLElement>("[data-intro]").forEach((el) => {
    // No explicit time: start just after the nearest timed parent, or after the previous element.
    const parent = el.parentElement?.closest<HTMLElement>("[data-intro-at]");
    const at = el.dataset.introAt
      ? parseFloat(el.dataset.introAt)
      : parent ? parseFloat(parent.dataset.introAt!) + 0.25 : (auto += 0.1);

    switch (el.dataset.intro) {
      case "lines": {
        // Each line rises out of its own mask.
        const split = SplitText.create(el, { type: "lines", mask: "lines" });
        // Give masks room for descenders (g, y, p) without shifting layout.
        split.masks.forEach((m) => gsap.set(m, { paddingBottom: "0.14em", marginBottom: "-0.14em" }));
        tl.from(split.lines, { yPercent: 105, duration: 1.2, stagger: 0.09 }, at);
        break;
      }
      case "pop":
        tl.from(el.children, { scale: 0.3, y: 14, autoAlpha: 0, duration: 0.6, stagger: 0.07, ease: "back.out(2.2)" }, at);
        break;
      case "fill":
        tl.from(el.querySelectorAll("[data-fill]"), { scaleX: 0, transformOrigin: "left", duration: 0.7, stagger: 0.07, ease: "power3.out" }, at);
        break;
      case "rows": {
        // Rows on screen cascade in now; rows further down arrive as they scroll into view.
        const rows = gsap.utils.toArray<HTMLElement>(el.querySelectorAll("[data-row]"));
        const onScreen = rows.filter((r) => r.getBoundingClientRect().top < window.innerHeight);
        const below = rows.filter((r) => !onScreen.includes(r));
        tl.from(onScreen, { y: 18, autoAlpha: 0, duration: 0.9, stagger: 0.06 }, at);
        if (below.length) {
          gsap.set(below, { y: 16, autoAlpha: 0 });
          ScrollTrigger.batch(below, {
            start: "top 92%",
            onEnter: (batch) => gsap.to(batch, { y: 0, autoAlpha: 1, duration: 0.9, stagger: 0.05, ease: EASE }),
          });
        }
        break;
      }
      default:
        tl.from(el, { y: 16, autoAlpha: 0, duration: 0.9 }, at);
    }
  });
}

// ---------- terminal logo ----------

// Gaps between keystrokes for `cd "dheeraj's blog"`. Uneven so it reads as a person typing,
// with longer beats around the quotes and the space before "blog".
const KEY_GAPS = [0, 0.06, 0.08, 0.09, 0.06, 0.05, 0.06, 0.04, 0.06, 0.05, 0.06, 0.09, 0.05, 0.07, 0.1, 0.05, 0.04, 0.06, 0.08];

// First page of a visit: type `cd "dheeraj's blog"`, press enter, and the command scrolls up
// while the resting prompt scrolls in underneath, like a terminal.
function typeLogo(tl: gsap.core.Timeline) {
  if (!root.classList.contains("typing-pending")) return;
  const cmd = document.querySelector<HTMLElement>(".logo-cmd");
  const home = document.querySelector<HTMLElement>(".logo-home");
  if (!cmd || !home) return;
  const chars = gsap.utils.toArray<HTMLElement>(cmd.querySelectorAll(".ch"));
  const cmdCursor = cmd.querySelector<HTMLElement>(".logo-cursor");
  const homeCursor = home.querySelector<HTMLElement>(".logo-cursor");
  sessionStorage.setItem("logo-typed", "1");

  // Take over from the CSS that set up the first frame, then drop the class.
  gsap.set(chars, { display: "none" });
  gsap.set(cmd, { visibility: "visible" });
  gsap.set(home, { yPercent: 100, visibility: "visible" });
  homeCursor?.removeAttribute("data-blink");
  root.classList.remove("typing-pending");

  tl.from("header", { y: -16, autoAlpha: 0, duration: 0.8 }, 0);

  let t = 0.25;
  chars.forEach((ch, i) => {
    t += KEY_GAPS[i % KEY_GAPS.length];
    tl.set(ch, { display: "inline" }, t);
  });

  // Enter: a short beat, then the lines scroll up by one.
  const enter = t + 0.25;
  tl.set(cmdCursor, { autoAlpha: 0 }, enter);
  tl.to(cmd, { yPercent: -100, duration: 0.45, ease: "power3.inOut" }, enter);
  tl.to(home, { yPercent: 0, duration: 0.45, ease: "power3.inOut" }, enter);
  tl.set(cmd, { visibility: "hidden" }, enter + 0.45);

  // On phones the command is wider than the room left by the nav, so the nav waits for enter.
  if (window.matchMedia("(max-width: 639px)").matches) {
    tl.from("[data-nav]", { autoAlpha: 0, duration: 0.5 }, enter);
  }

  // Solid cursor on the new prompt for a moment, then blink like a shell waiting for input.
  tl.call(() => homeCursor?.setAttribute("data-blink", ""), undefined, enter + 0.8);
}

// ---------- header nav ----------

function navPill(motion: boolean) {
  const nav = document.querySelector<HTMLElement>("[data-nav]");
  const pill = nav?.querySelector<HTMLElement>("[data-nav-pill]");
  if (!nav || !pill) return;

  const links = [...nav.querySelectorAll<HTMLAnchorElement>("a")];
  const active = links.find((a) => a.getAttribute("aria-current") === "page");

  const moveTo = (el: HTMLElement | undefined, instant = false) => {
    if (!el) return gsap.to(pill, { autoAlpha: 0, duration: 0.25 });
    const vars = { x: el.offsetLeft, width: el.offsetWidth, autoAlpha: 1 };
    return instant || !motion ? gsap.set(pill, vars) : gsap.to(pill, { ...vars, duration: 0.5, ease: EASE });
  };

  if (active) moveTo(active, true);
  links.forEach((a) => a.addEventListener("mouseenter", () => moveTo(a)));
  nav.addEventListener("mouseleave", () => moveTo(active));
}

// ---------- post lists ----------

// One highlight block glides between rows instead of each row lighting up on its own.
function rowHighlights(motion: boolean) {
  document.querySelectorAll<HTMLElement>("[data-rows]").forEach((list) => {
    const hl = list.querySelector<HTMLElement>(".rows-hl");
    if (!hl) return;
    list.querySelectorAll<HTMLElement>("[data-row]").forEach((row) => {
      row.addEventListener("mouseenter", () => {
        const vars = { y: row.offsetTop, height: row.offsetHeight, autoAlpha: 1 };
        const visible = gsap.getProperty(hl, "autoAlpha") as number;
        // Appear in place on first hover, glide between rows after that.
        if (!motion || visible < 0.05) gsap.set(hl, { y: vars.y, height: vars.height });
        gsap.to(hl, { ...vars, duration: motion ? 0.45 : 0, ease: EASE });
      });
    });
    list.addEventListener("mouseleave", () => gsap.to(hl, { autoAlpha: 0, duration: 0.3 }));
  });
}

// ---------- post page ----------

function readingProgress() {
  const bar = document.querySelector<HTMLElement>("[data-progress]");
  const body = document.querySelector<HTMLElement>("[data-post-body]");
  if (!bar || !body) return;
  // A little scrub lag so the bar trails the scroll instead of jittering with it.
  gsap.fromTo(bar, { scaleX: 0 }, {
    scaleX: 1,
    ease: "none",
    scrollTrigger: { trigger: body, start: "top 30%", end: "bottom bottom", scrub: 0.3 },
  });
}

function tableOfContents(motion: boolean) {
  const toc = document.querySelector<HTMLElement>("[data-toc]");
  const marker = toc?.querySelector<HTMLElement>("[data-toc-marker]");
  if (!toc || !marker) return;

  const links = [...toc.querySelectorAll<HTMLAnchorElement>("a")];
  const setActive = (i: number, instant = false) => {
    links.forEach((a, j) => a.toggleAttribute("data-active", i === j));
    const item = links[i]?.parentElement;
    if (!item) return;
    const vars = { y: item.offsetTop, height: item.offsetHeight };
    instant || !motion ? gsap.set(marker, vars) : gsap.to(marker, { ...vars, duration: 0.6, ease: EASE });
  };

  links.forEach((a, i) => {
    const heading = document.getElementById(decodeURIComponent(a.hash.slice(1)));
    if (!heading) return;
    ScrollTrigger.create({
      trigger: heading,
      start: "top 40%",
      onEnter: () => setActive(i),
      onLeaveBack: () => setActive(Math.max(0, i - 1)),
    });
  });
  setActive(0, true);
}

function scrollReveals() {
  gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
    gsap.from(el, { y: 24, autoAlpha: 0, duration: 1, ease: EASE, scrollTrigger: { trigger: el, start: "top 90%", once: true } });
  });

  // Series card glow drifts slightly with scroll.
  gsap.utils.toArray<HTMLElement>("[data-glow]").forEach((glow) => {
    gsap.to(glow, { y: 80, ease: "none", scrollTrigger: { trigger: glow.parentElement, scrub: true } });
  });
}

// Images and Mermaid diagrams change the page height after load; keep trigger positions honest.
function refreshOnResize() {
  const body = document.querySelector<HTMLElement>("[data-post-body]");
  if (!body) return;
  let pending = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => ScrollTrigger.refresh());
  });
  observer.observe(body);
  document.addEventListener("astro:before-swap", () => observer.disconnect(), { once: true });
}

// Wrap each highlighted code block with a language label and a copy button.
function codeBlocks() {
  document.querySelectorAll<HTMLPreElement>("[data-post-body] pre.astro-code").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code")) return;

    const wrap = document.createElement("div");
    wrap.className = "code";
    const bar = document.createElement("div");
    bar.className = "code-bar";
    const lang = document.createElement("span");
    lang.textContent = pre.dataset.language ?? "code";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy";
    copy.textContent = "Copy";

    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pre.innerText);
      copy.textContent = "✓ Copied";
      copy.setAttribute("data-copied", "");
      if (!reducedMotion()) gsap.fromTo(copy, { scale: 0.92 }, { scale: 1, duration: 0.5, ease: "back.out(3)" });
      setTimeout(() => {
        copy.textContent = "Copy";
        copy.removeAttribute("data-copied");
      }, 1600);
    });

    bar.append(lang, copy);
    pre.replaceWith(wrap);
    wrap.append(bar, pre);
  });
}
