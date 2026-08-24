const telegram = window.Telegram?.WebApp;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const elements = {
  closeApp: document.querySelector("#close-app"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionPill: document.querySelector("#connection-pill"),
  error: document.querySelector("#form-error"),
  form: document.querySelector("#generator-form"),
  generateButton: document.querySelector("#generate-button"),
  generationError: document.querySelector("#generation-error"),
  generationErrorMessage: document.querySelector("#generation-error-message"),
  generationSheet: document.querySelector("#generation-sheet"),
  generationStatus: document.querySelector("#generation-status"),
  generationVisual: document.querySelector("#generation-visual"),
  makeAnother: document.querySelector("#make-another"),
  progressContent: document.querySelector("#progress-content"),
  progressEta: document.querySelector("#progress-eta"),
  progressFill: document.querySelector("#progress-fill"),
  progressPercent: document.querySelector("#progress-percent"),
  progressTrack: document.querySelector(".progress-track"),
  prompt: document.querySelector("#prompt-input"),
  promptCounter: document.querySelector("#prompt-counter"),
  removeSource: document.querySelector("#remove-source"),
  resultContent: document.querySelector("#result-content"),
  resultPreview: document.querySelector("#result-preview"),
  sourceDropzone: document.querySelector("#source-dropzone"),
  sourceHelpText: document.querySelector("#source-help-text"),
  sourceInput: document.querySelector("#source-input"),
  sourceMeta: document.querySelector("#source-meta"),
  sourceName: document.querySelector("#source-name"),
  sourcePreview: document.querySelector("#source-preview"),
  sourceThumb: document.querySelector("#source-thumb"),
  sourceTitleText: document.querySelector("#source-title-text"),
  styleGrid: document.querySelector("#style-grid"),
  tryAgain: document.querySelector("#try-again"),
};

const state = {
  draftId: new URLSearchParams(window.location.search).get("draft"),
  initData: telegram?.initData || "",
  resultObjectUrl: null,
  selectedFile: null,
  selectedPresetId: null,
  sourceObjectUrl: null,
  styles: [],
};

function haptic(type = "selection") {
  try {
    if (type === "success" || type === "error") telegram?.HapticFeedback?.notificationOccurred(type);
    else telegram?.HapticFeedback?.selectionChanged();
  } catch {}
}

function setConnectionState() {
  if (state.initData) {
    elements.connectionPill.classList.add("connected");
    elements.connectionLabel.textContent = "Telegram";
  } else {
    elements.connectionPill.classList.add("preview");
    elements.connectionLabel.textContent = "Preview";
  }
}

function showFormError(message) {
  elements.error.textContent = message;
  elements.error.hidden = !message;
  if (message) elements.error.scrollIntoView({ behavior: "smooth", block: "center" });
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    "X-Telegram-Init-Data": state.initData,
  };
}

function splitButtonLabel(label) {
  const match = label.match(/^(\p{Extended_Pictographic}(?:\uFE0F)?)[\s]+(.+)$/u);
  return match ? { emoji: match[1], label: match[2] } : { emoji: "✦", label };
}

function renderStyles() {
  elements.styleGrid.replaceChildren();
  const noPreset = {
    id: null,
    buttonText: "✍️ Prompt only",
    description: "Use exactly the style you describe.",
  };
  for (const style of [noPreset, ...state.styles]) {
    const label = splitButtonLabel(style.buttonText);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `style-card${state.selectedPresetId === style.id ? " selected" : ""}`;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(state.selectedPresetId === style.id));

    const emoji = document.createElement("span");
    emoji.className = "style-emoji";
    emoji.textContent = label.emoji;

    const copy = document.createElement("span");
    copy.className = "style-copy";
    const name = document.createElement("strong");
    name.textContent = label.label;
    const description = document.createElement("small");
    description.textContent = style.description;
    copy.append(name, description);

    const check = document.createElement("span");
    check.className = "style-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";

    button.append(emoji, copy, check);
    button.addEventListener("click", () => {
      state.selectedPresetId = style.id;
      haptic();
      renderStyles();
    });
    elements.styleGrid.append(button);
  }
}

async function loadStyles() {
  const response = await fetch("/api/miniapp/styles");
  if (!response.ok) throw new Error("Could not load the style catalog");
  state.styles = await response.json();
  renderStyles();
}

function revokeSourceUrl() {
  if (state.sourceObjectUrl) URL.revokeObjectURL(state.sourceObjectUrl);
  state.sourceObjectUrl = null;
}

function clearSource() {
  revokeSourceUrl();
  state.selectedFile = null;
  state.draftId = null;
  elements.sourceInput.value = "";
  elements.sourcePreview.hidden = true;
  elements.sourceDropzone.hidden = false;
  elements.sourceThumb.removeAttribute("src");
}

function showSource({ src, name, meta }) {
  elements.sourceThumb.src = src;
  elements.sourceName.textContent = name;
  elements.sourceMeta.textContent = meta;
  elements.sourceDropzone.hidden = true;
  elements.sourcePreview.hidden = false;
}

function selectFile(file) {
  showFormError("");
  if (!file) return;
  if (!/^image\/(?:png|jpeg|webp)$/.test(file.type)) {
    showFormError("Choose a PNG, JPG, or WebP image.");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showFormError("That image is larger than 10 MB.");
    return;
  }
  revokeSourceUrl();
  state.draftId = null;
  state.selectedFile = file;
  state.sourceObjectUrl = URL.createObjectURL(file);
  showSource({
    src: state.sourceObjectUrl,
    name: file.name || "Uploaded image",
    meta: `${Math.max(1, Math.round(file.size / 1024))} KB · Ready to transform`,
  });
  haptic();
}

async function loadDraft() {
  if (!state.draftId || !state.initData) return;
  const draftPath = `/api/miniapp/drafts/${encodeURIComponent(state.draftId)}`;
  const response = await fetch(draftPath, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    state.draftId = null;
    showFormError("This sticker draft has expired. Send the sticker to the bot again.");
    return;
  }
  const draft = await response.json();
  const imageResponse = await fetch(`${draftPath}/image`, { headers: authHeaders() });
  if (!imageResponse.ok) throw new Error("Could not load the sticker draft");
  revokeSourceUrl();
  state.sourceObjectUrl = URL.createObjectURL(await imageResponse.blob());
  showSource({
    src: state.sourceObjectUrl,
    name: draft.name || "Telegram sticker",
    meta: "From your Telegram chat · Ready to restyle",
  });
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Could not read that image")));
    reader.readAsDataURL(file);
  });
}

function setSheetView(view) {
  elements.generationSheet.hidden = false;
  elements.generationVisual.hidden = view !== "progress";
  elements.progressContent.hidden = view !== "progress";
  elements.resultContent.hidden = view !== "result";
  elements.generationError.hidden = view !== "error";
}

function updateProgress(job) {
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  elements.progressFill.style.width = `${progress}%`;
  elements.progressPercent.textContent = `${progress}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(progress));
  elements.progressEta.textContent = job.eta || "Finishing…";
  elements.generationStatus.textContent = job.message || "Generating your sticker";
}

async function streamJob(jobId) {
  const response = await fetch(`/api/miniapp/generations/${encodeURIComponent(jobId)}/events`, {
    headers: authHeaders({ Accept: "text/event-stream" }),
  });
  if (!response.ok || !response.body) throw new Error("Could not follow sticker generation");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const job = JSON.parse(data);
      updateProgress(job);
      if (job.status === "complete") {
        await showResult(jobId);
        return;
      }
      if (job.status === "failed") throw new Error(job.error || "Sticker generation failed");
    }
    if (done) break;
  }
  throw new Error("The generation connection closed too early");
}

async function showResult(jobId) {
  const response = await fetch(`/api/miniapp/generations/${encodeURIComponent(jobId)}/image`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error("The sticker was sent, but its preview could not be loaded");
  if (state.resultObjectUrl) URL.revokeObjectURL(state.resultObjectUrl);
  state.resultObjectUrl = URL.createObjectURL(await response.blob());
  elements.resultPreview.src = state.resultObjectUrl;
  setSheetView("result");
  haptic("success");
}

async function submitGeneration() {
  showFormError("");
  if (!state.initData) {
    showFormError("Open StickerGen from Telegram to generate a sticker.");
    return;
  }
  const prompt = elements.prompt.value.trim();
  if (!prompt && !state.selectedFile && !state.draftId) {
    showFormError("Describe a sticker or add a source image first.");
    elements.prompt.focus();
    return;
  }

  elements.generateButton.disabled = true;
  setSheetView("progress");
  updateProgress({ progress: 0, eta: "ETA ~1m 20s", message: "Preparing your request" });
  try {
    const sourceDataUrl = await fileAsDataUrl(state.selectedFile);
    const response = await fetch("/api/miniapp/generations", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        draftId: state.draftId,
        presetId: state.selectedPresetId,
        prompt,
        sourceDataUrl,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not start sticker generation");
    await streamJob(body.jobId);
  } catch (error) {
    elements.generationErrorMessage.textContent = error?.message || "Please try again.";
    setSheetView("error");
    haptic("error");
  } finally {
    elements.generateButton.disabled = false;
  }
}

function resetAfterResult() {
  elements.generationSheet.hidden = true;
  elements.prompt.value = "";
  elements.promptCounter.textContent = "0 / 2000";
  state.selectedPresetId = null;
  clearSource();
  renderStyles();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindEvents() {
  elements.prompt.addEventListener("input", () => {
    elements.promptCounter.textContent = `${elements.prompt.value.length} / 2000`;
  });
  elements.sourceInput.addEventListener("change", () => selectFile(elements.sourceInput.files?.[0]));
  elements.removeSource.addEventListener("click", clearSource);
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitGeneration();
  });
  elements.tryAgain.addEventListener("click", () => {
    elements.generationSheet.hidden = true;
  });
  elements.makeAnother.addEventListener("click", resetAfterResult);
  elements.closeApp.addEventListener("click", () => telegram?.close());

  for (const eventName of ["dragenter", "dragover"]) {
    elements.sourceDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.sourceDropzone.classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.sourceDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.sourceDropzone.classList.remove("dragging");
    });
  }
  elements.sourceDropzone.addEventListener("drop", (event) => selectFile(event.dataTransfer?.files?.[0]));
}

async function initialize() {
  telegram?.ready();
  telegram?.expand();
  try { telegram?.setHeaderColor("secondary_bg_color"); } catch {}
  setConnectionState();
  bindEvents();
  try {
    await Promise.all([loadStyles(), loadDraft()]);
  } catch (error) {
    showFormError(error?.message || "StickerGen could not be loaded.");
  }
}

void initialize();
