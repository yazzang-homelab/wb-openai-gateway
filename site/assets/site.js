"use strict";

(() => {
  const root = document.documentElement;

  // Landing page: both languages are in the DOM, [data-l] blocks are toggled.
  const buttons = document.querySelectorAll("[data-set-lang]");
  function setLanguage(lang, persist) {
    const next = lang === "en" ? "en" : "ko";
    root.dataset.lang = next;
    root.lang = next;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.setLang === next));
    const title = document.querySelector(`meta[name="title-${next}"]`);
    if (title) document.title = title.content;
    if (persist) {
      const url = new URL(window.location.href);
      url.searchParams.set("lang", next);
      try {
        window.history.replaceState(null, "", url);
      } catch {
        /* file:// previews may refuse history changes */
      }
    }
  }
  if (buttons.length > 0) {
    for (const b of buttons) b.addEventListener("click", () => setLanguage(b.dataset.setLang, true));
    const requested = new URL(window.location.href).searchParams.get("lang");
    const preferred = (navigator.language || "").toLowerCase().startsWith("ko") ? "ko" : "en";
    setLanguage(requested || preferred, false);
  }

  // Copy buttons on every code block.
  for (const pre of document.querySelectorAll(".prose pre, .terminal pre[data-copy]")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    const label = () => (root.lang === "en" ? "Copy" : "복사");
    button.textContent = label();
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent);
        button.textContent = root.lang === "en" ? "Copied" : "복사됨";
      } catch {
        button.textContent = root.lang === "en" ? "Select manually" : "직접 선택";
      }
      setTimeout(() => (button.textContent = label()), 2000);
    });
    pre.appendChild(button);
  }
})();
