/**
 * actwhy playground — wires the editor + event controls to the core engine,
 * re-evaluating (debounced) on every change and rendering the verdict tree.
 */
import { el, must, clear } from "./dom.js";
import { evaluate, type AppState, type EventKind } from "./engine.js";
import { EXAMPLES, cloneExampleState } from "./examples.js";
import { encodeState, decodeState } from "./share.js";
import { renderReport, renderError } from "./render.js";

const STARTER = `name: New Workflow
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "hello from actwhy"
`;

function defaultState(): AppState {
  return cloneExampleState(EXAMPLES[0]!);
}

// ------------------------------------------------------------------ state ---
let state: AppState = defaultState();

// --------------------------------------------------------------- elements ---
const tabsEl = must("#tabs");
const editorEl = must<HTMLTextAreaElement>("#editor");
const changedEl = must<HTMLTextAreaElement>("#changed");
const commitEl = must<HTMLTextAreaElement>("#commit-message");
const branchEl = must<HTMLInputElement>("#branch");
const tagEl = must<HTMLInputElement>("#tag");
const prBaseEl = must<HTMLInputElement>("#pr-base");
const prHeadEl = must<HTMLInputElement>("#pr-head");
const prActivityEl = must<HTMLSelectElement>("#pr-activity");
const resultsEl = must("#results");
const exampleSelect = must<HTMLSelectElement>("#example-select");
const shareBtn = must<HTMLButtonElement>("#share-btn");
const shareFeedback = must("#share-feedback");
const pushFields = must("#push-fields");
const tagFields = must("#tag-fields");
const prFields = must("#pr-fields");
const commitField = must("#commit-field");

// --------------------------------------------------------------- evaluate ---
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let runToken = 0;

async function runEvaluate(): Promise<void> {
  const token = ++runToken;
  try {
    const report = await evaluate(state);
    if (token !== runToken) return; // a newer run superseded this one
    renderReport(report, resultsEl);
  } catch (err) {
    if (token !== runToken) return;
    renderError(err instanceof Error ? err.message : String(err), resultsEl);
  }
}

function scheduleEvaluate(): void {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runEvaluate, 200);
}

// ------------------------------------------------------------------- tabs ---
function activeFile() {
  return state.files[state.active]!;
}

function renderTabs(): void {
  clear(tabsEl);
  state.files.forEach((file, idx) => {
    const isActive = idx === state.active;
    const tab = el("div", {
      class: "tab" + (isActive ? " tab--active" : ""),
      role: "tab",
      "aria-selected": isActive ? "true" : "false",
      tabindex: isActive ? "0" : "-1",
      title: "Double-click to rename",
    });
    const label = el("span", { class: "tab__label" }, file.name);
    tab.append(label);

    tab.addEventListener("click", () => setActive(idx));
    tab.addEventListener("dblclick", (e) => {
      e.preventDefault();
      beginRename(tab, label, idx);
    });
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setActive(idx);
      } else if (e.key === "F2") {
        beginRename(tab, label, idx);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        // Roving tabindex: arrows move selection per the WAI-ARIA tabs pattern.
        e.preventDefault();
        const n = state.files.length;
        const next = (idx + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
        setActive(next);
        (tabsEl.querySelectorAll('[role="tab"]')[next] as HTMLElement | undefined)?.focus();
      } else if (e.key === "Delete" && state.files.length > 1) {
        e.preventDefault();
        removeFile(idx);
      }
    });

    if (state.files.length > 1) {
      const close = el("button", {
        class: "tab__close",
        type: "button",
        "aria-label": `Remove ${file.name}`,
        title: `Remove ${file.name}`,
      }, "×");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFile(idx);
      });
      tab.append(close);
    }
    tabsEl.append(tab);
  });

  const add = el("button", {
    class: "tab tab--add",
    type: "button",
    "aria-label": "Add workflow file",
    title: "Add workflow file",
  }, "+");
  add.addEventListener("click", addFile);
  tabsEl.append(add);
}

function beginRename(tab: HTMLElement, label: HTMLElement, idx: number): void {
  const input = el("input", {
    class: "tab__rename",
    type: "text",
    value: state.files[idx]!.name,
    "aria-label": "Rename workflow file",
  });
  tab.replaceChild(input, label);
  input.focus();
  input.select();
  const commit = () => {
    const next = input.value.trim();
    if (next) state.files[idx]!.name = next;
    renderTabs();
    scheduleEvaluate();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renderTabs();
    }
    e.stopPropagation();
  });
}

function setActive(idx: number): void {
  state.active = idx;
  editorEl.value = activeFile().content;
  renderTabs();
}

function addFile(): void {
  let n = state.files.length + 1;
  let name = `workflow-${n}.yml`;
  const taken = new Set(state.files.map((f) => f.name));
  while (taken.has(name)) name = `workflow-${++n}.yml`;
  state.files.push({ name, content: STARTER });
  state.active = state.files.length - 1;
  editorEl.value = activeFile().content;
  renderTabs();
  scheduleEvaluate();
  editorEl.focus();
}

function removeFile(idx: number): void {
  if (state.files.length <= 1) return;
  state.files.splice(idx, 1);
  if (state.active >= state.files.length) state.active = state.files.length - 1;
  else if (state.active > idx) state.active -= 1;
  editorEl.value = activeFile().content;
  renderTabs();
  scheduleEvaluate();
}

// --------------------------------------------------------------- controls ---
function setEvent(event: EventKind): void {
  state.event = event;
  syncEventButtons();
  updateEventVisibility();
  scheduleEvaluate();
}

function syncEventButtons(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-event]"))) {
    const on = btn.dataset.event === state.event;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("seg__btn--active", on);
  }
}

function updateEventVisibility(): void {
  pushFields.hidden = state.event !== "push";
  tagFields.hidden = state.event !== "tag";
  prFields.hidden = state.event !== "pull_request";
  commitField.hidden = state.event === "pull_request";
}

/** Push current state values into the control inputs. */
function syncControls(): void {
  editorEl.value = activeFile().content;
  changedEl.value = state.changed;
  commitEl.value = state.commitMessage;
  branchEl.value = state.branch;
  tagEl.value = state.tag;
  prBaseEl.value = state.prBase;
  prHeadEl.value = state.prHead;
  prActivityEl.value = state.prActivity;
  syncEventButtons();
  updateEventVisibility();
}

// ------------------------------------------------------------------ share ---
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

async function share(): Promise<void> {
  const hash = "#" + encodeState(state);
  history.replaceState(null, "", location.pathname + location.search + hash);
  const url = location.href;
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    copied = false;
  }
  clear(shareFeedback);
  shareFeedback.append(document.createTextNode(copied ? "link copied" : "link in address bar"));
  shareFeedback.classList.add("share-feedback--show");
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => shareFeedback.classList.remove("share-feedback--show"), 2200);
}

// --------------------------------------------------------------- examples ---
function buildExampleOptions(): void {
  clear(exampleSelect);
  exampleSelect.append(el("option", { value: "", disabled: "true" }, "Load an example…"));
  for (const ex of EXAMPLES) {
    exampleSelect.append(el("option", { value: ex.id }, ex.label));
  }
}

function loadExample(id: string): void {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) return;
  state = cloneExampleState(ex);
  history.replaceState(null, "", location.pathname + location.search);
  syncControls();
  renderTabs();
  runEvaluate();
}

// ------------------------------------------------------------------- init ---
function wireInputs(): void {
  editorEl.addEventListener("input", () => {
    activeFile().content = editorEl.value;
    scheduleEvaluate();
  });
  changedEl.addEventListener("input", () => {
    state.changed = changedEl.value;
    scheduleEvaluate();
  });
  commitEl.addEventListener("input", () => {
    state.commitMessage = commitEl.value;
    scheduleEvaluate();
  });
  branchEl.addEventListener("input", () => {
    state.branch = branchEl.value;
    scheduleEvaluate();
  });
  tagEl.addEventListener("input", () => {
    state.tag = tagEl.value;
    scheduleEvaluate();
  });
  prBaseEl.addEventListener("input", () => {
    state.prBase = prBaseEl.value;
    scheduleEvaluate();
  });
  prHeadEl.addEventListener("input", () => {
    state.prHead = prHeadEl.value;
    scheduleEvaluate();
  });
  prActivityEl.addEventListener("change", () => {
    state.prActivity = prActivityEl.value;
    scheduleEvaluate();
  });

  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-event]"))) {
    btn.addEventListener("click", () => setEvent(btn.dataset.event as EventKind));
  }

  exampleSelect.addEventListener("change", () => {
    if (exampleSelect.value) loadExample(exampleSelect.value);
    exampleSelect.selectedIndex = 0;
  });

  shareBtn.addEventListener("click", () => void share());

  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-copy]"))) {
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.getAttribute("data-label") ?? btn.textContent ?? "";
        btn.classList.add("copied");
        btn.setAttribute("data-tip", "copied!");
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.removeAttribute("data-tip");
          void prev;
        }, 1600);
      } catch {
        /* clipboard unavailable — no-op */
      }
    });
  }
}

function init(): void {
  buildExampleOptions();
  const fromHash = decodeState(location.hash);
  if (fromHash) state = fromHash;
  syncControls();
  renderTabs();
  wireInputs();
  runEvaluate();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
