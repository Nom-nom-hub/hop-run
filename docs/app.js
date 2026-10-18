/* hop — docs site behavior
   Small, dependency-free: copy buttons, scroll reveal, terminal demo.
   Everything degrades gracefully when JS is off (see html.js guards in CSS). */
(() => {
  "use strict";

  const root = document.documentElement;
  root.classList.add("js");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const supported = "IntersectionObserver" in window && "classList" in document.body;

  /* ---------------------------------------------------------------- copy */
  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    const original = btn.textContent;
    let timer = 0;

    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy") || "";
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          ok = true;
        } else {
          ok = fallbackCopy(text);
        }
      } catch {
        ok = fallbackCopy(text);
      }

      btn.classList.toggle("done", ok);
      btn.textContent = ok ? "copied" : "copy failed";
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("done");
      }, 1600);
    });
  });

  /* -------------------------------------------------------- scroll reveal */
  const revealables = Array.from(document.querySelectorAll(".reveal"));

  function showNow(elements) {
    elements.forEach((el) => el.classList.add("is-in"));
  }

  if (!supported || reduceMotion) {
    showNow(revealables);
  } else {
    const revealer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            revealer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    revealables.forEach((el) => revealer.observe(el));
  }

  /* -------------------------------------------------------- terminal demo */
  const demo = document.querySelector("[data-demo]");
  if (!demo) return;

  const lines = Array.from(demo.children);
  const replay = document.querySelector(".term-replay");
  let timers = [];
  let playing = false;

  function stopTimers() {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
  }

  function finish() {
    stopTimers();
    demo.classList.remove("is-anim");
    lines.forEach((line) => line.classList.add("is-in"));
    playing = false;
  }

  function play() {
    if (playing) return;
    playing = true;

    if (reduceMotion) {
      finish();
      return;
    }

    stopTimers();
    demo.classList.add("is-anim");
    lines.forEach((line) => line.classList.remove("is-in"));

    let at = 0;
    lines.forEach((line) => {
      at += Number(line.getAttribute("data-t") || 60);
      timers.push(
        window.setTimeout(() => {
          line.classList.add("is-in");
        }, at),
      );
    });
    timers.push(
      window.setTimeout(() => {
        playing = false;
      }, at + 150),
    );
  }

  if (replay) {
    replay.addEventListener("click", () => {
      if (!playing) play();
    });
  }

  // Keep the lines hidden until the terminal is actually on screen, so the
  // demo plays for the visitor instead of having run during page load.
  if (!reduceMotion && supported) {
    demo.classList.add("is-anim");
    const starter = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            starter.disconnect();
            play();
          }
        });
      },
      { threshold: 0.15 },
    );
    starter.observe(demo);
  } else {
    play();
  }
})();
