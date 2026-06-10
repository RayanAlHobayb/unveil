// Unveil — client-side background removal.
// Uses @imgly/background-removal: the ONNX segmentation model is fetched once,
// cached by the browser, and runs locally via WASM — images never leave the device.

let removeBackground = null;
let modulePromise = null;

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 25 * 1024 * 1024;

const el = (id) => document.getElementById(id);

const stages = {
  upload: el('stage-upload'),
  processing: el('stage-processing'),
  result: el('stage-result'),
};

const dropzone = el('dropzone');
const fileInput = el('file-input');
const uploadError = el('upload-error');
const processingThumb = el('processing-thumb');
const processingStatus = el('processing-status');
const processingNote = el('processing-note');
const progressBar = el('progress-bar');
const resultImg = el('result-img');
const originalImg = el('original-img');
const toast = el('toast');
const crispCheck = el('crisp-check');
const graphicsBtn = el('btn-graphics');
const hqBtn = el('btn-hq');

// The current image and its computed results. The AI model produces `ai`
// (optionally upgraded in place by the HQ re-run); `flat` is the flood-fill
// graphics-mode result. `crisp` is the hardened variant of whichever base is
// active and is invalidated when the base changes.
let lastFile = null;
let busy = false;
let originalUrl = null;
const results = { ai: null, flat: null, crisp: null }; // each: { blob, url }
let activeBase = 'ai';
let hqDone = false;

function setResultEntry(key, blob) {
  if (results[key]) URL.revokeObjectURL(results[key].url);
  results[key] = blob ? { blob, url: URL.createObjectURL(blob) } : null;
}

function activeResult() {
  if (crispCheck.checked && results.crisp) return results.crisp;
  return results[activeBase];
}

function refreshResultView() {
  const active = activeResult();
  if (active) resultImg.src = active.url;
  graphicsBtn.setAttribute('aria-pressed', String(activeBase === 'flat'));
}

function showStage(name) {
  for (const [key, section] of Object.entries(stages)) {
    section.hidden = key !== name;
  }
}

function showError(message) {
  uploadError.textContent = message;
  uploadError.hidden = false;
}

function clearError() {
  uploadError.hidden = true;
}

let toastTimer = null;
function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

function loadModule() {
  if (!modulePromise) {
    modulePromise = import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm')
      .then((mod) => { removeBackground = mod.removeBackground; })
      .catch((err) => {
        modulePromise = null;
        throw new Error('Could not load the AI engine. Check your connection and try again.', { cause: err });
      });
  }
  return modulePromise;
}

// Warm up the module download in the background.
loadModule().catch(() => {});

function setProgress(fraction, label) {
  progressBar.style.width = `${Math.round(fraction * 100)}%`;
  if (label) processingStatus.textContent = label;
}

function aiProgressHandler(key, current, total) {
  const fraction = total > 0 ? current / total : 0;
  if (key.startsWith('fetch')) {
    setProgress(0.05 + fraction * 0.55, `Downloading model… ${Math.round(fraction * 100)}%`);
  } else {
    processingNote.hidden = true;
    setProgress(0.6 + fraction * 0.4, 'Removing background…');
  }
}

async function runAi(file, model) {
  await loadModule();
  return removeBackground(file, {
    model,
    output: { format: 'image/png' },
    progress: aiProgressHandler,
  });
}

async function handleFile(file) {
  if (busy || !file) return;

  if (!ACCEPTED_TYPES.includes(file.type)) {
    showError('That file type isn’t supported — please use a PNG, JPG, or WebP image.');
    return;
  }
  if (file.size > MAX_BYTES) {
    showError('That image is over 25 MB. Please try a smaller one.');
    return;
  }

  clearError();
  busy = true;

  if (originalUrl) URL.revokeObjectURL(originalUrl);
  setResultEntry('ai', null);
  setResultEntry('flat', null);
  setResultEntry('crisp', null);
  lastFile = file;
  activeBase = 'ai';
  hqDone = false;
  crispCheck.checked = false;
  hqBtn.disabled = false;

  originalUrl = URL.createObjectURL(file);
  processingThumb.src = originalUrl;
  setProgress(0.02, 'Loading AI engine…');
  processingNote.hidden = false;
  showStage('processing');

  try {
    const blob = await runAi(file, 'isnet_fp16');
    setProgress(1, 'Done');
    setResultEntry('ai', blob);
    originalImg.src = originalUrl;
    setView('result');
    refreshResultView();
    showStage('result');
  } catch (err) {
    console.error(err);
    showStage('upload');
    showError(err?.message || 'Something went wrong while processing the image. Please try again.');
  } finally {
    busy = false;
    setProgress(0);
  }
}

// --- Graphics mode (flat-background removal) ---
//
// The AI model segments the "salient object", so free-standing text and thin
// graphics on a flat background can be faded or erased entirely. Graphics mode
// skips the model: it estimates the background color from the image borders,
// then flood-fills inward, turning background-colored pixels transparent.
// Everything that isn't background-colored — text, logos, lines — is kept
// exactly as-is. A second pass clears small enclosed pockets (letter counters
// like the holes in "O" or "A") without touching large background-colored
// areas that belong to the subject.

const FLAT_HARD_TOL = 28;  // distance below this = fully background
const FLAT_SOFT_TOL = 80;  // distance above this = fully foreground

async function makeFlatBlob(file) {
  const bmp = await createImageBitmap(file);
  const w = bmp.width, h = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;

  // Median border color = background estimate.
  const rs = [], gs = [], bs = [];
  const sampleBorder = (x, y) => {
    const i = (y * w + x) * 4;
    if (d[i + 3] > 10) { rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); }
  };
  for (let x = 0; x < w; x++) { sampleBorder(x, 0); sampleBorder(x, h - 1); }
  for (let y = 0; y < h; y++) { sampleBorder(0, y); sampleBorder(w - 1, y); }
  if (!rs.length) throw new Error('Image is fully transparent already.');
  const median = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
  const bgR = median(rs), bgG = median(gs), bgB = median(bs);

  const dist = (i) => {
    const dr = d[i] - bgR, dg = d[i + 1] - bgG, db = d[i + 2] - bgB;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const alphaFor = (dst) => dst <= FLAT_HARD_TOL ? 0
    : dst >= FLAT_SOFT_TOL ? 255
    : Math.round((dst - FLAT_HARD_TOL) / (FLAT_SOFT_TOL - FLAT_HARD_TOL) * 255);

  const visited = new Uint8Array(w * h);
  const stack = [];
  const tryPush = (p) => {
    if (!visited[p]) { visited[p] = 1; stack.push(p); }
  };

  const erase = (p) => {
    const i = p * 4;
    const dst = dist(i);
    d[i + 3] = Math.min(d[i + 3], alphaFor(dst));
    if (dst >= FLAT_SOFT_TOL) return false; // foreground: don't spread past it
    const x = p % w, y = (p / w) | 0;
    if (x > 0) tryPush(p - 1);
    if (x < w - 1) tryPush(p + 1);
    if (y > 0) tryPush(p - w);
    if (y < h - 1) tryPush(p + w);
    return true;
  };

  // Pass 1: flood from every border pixel that looks like background.
  for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + w - 1); }
  // Border seeds that aren't background-colored shouldn't erase or spread.
  const seeds = stack.splice(0, stack.length);
  for (const p of seeds) {
    if (dist(p * 4) < FLAT_SOFT_TOL) stack.push(p);
    // stays visited either way
  }
  while (stack.length) erase(stack.pop());

  // Pass 2: clear small enclosed background pockets (letter counters etc.).
  const maxPocket = Math.max(64, (w * h) * 0.005);
  const pocket = [];
  for (let p = 0; p < w * h; p++) {
    if (visited[p] || dist(p * 4) > FLAT_HARD_TOL) continue;
    pocket.length = 0;
    const queue = [p];
    visited[p] = 1;
    let tooBig = false;
    while (queue.length) {
      const q = queue.pop();
      pocket.push(q);
      if (pocket.length > maxPocket) { tooBig = true; break; }
      const x = q % w, y = (q / w) | 0;
      for (const n of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
        if (n >= 0 && !visited[n] && dist(n * 4) < FLAT_SOFT_TOL) { visited[n] = 1; queue.push(n); }
      }
    }
    if (!tooBig) for (const q of pocket) d[q * 4 + 3] = Math.min(d[q * 4 + 3], alphaFor(dist(q * 4)));
  }

  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

graphicsBtn.addEventListener('click', async () => {
  if (!lastFile || busy) return;
  if (activeBase === 'flat') {
    activeBase = 'ai';
    setResultEntry('crisp', null);
    crispCheck.checked = false;
    refreshResultView();
    showToast('Back to the AI result');
    return;
  }
  graphicsBtn.disabled = true;
  try {
    if (!results.flat) setResultEntry('flat', await makeFlatBlob(lastFile));
    activeBase = 'flat';
    setResultEntry('crisp', null);
    crispCheck.checked = false;
    refreshResultView();
    showToast('Graphics mode: background removed by color — text and details kept');
  } catch (err) {
    console.error(err);
    showToast('Graphics mode didn’t work on this image.');
  } finally {
    graphicsBtn.disabled = false;
  }
});

// --- HQ AI re-run (full-precision model) ---

hqBtn.addEventListener('click', async () => {
  if (!lastFile || busy) return;
  busy = true;
  hqBtn.disabled = true;
  setProgress(0.02, 'Loading high-quality model…');
  processingNote.textContent = 'The high-quality model is a larger one-time download. It produces finer masks, especially around hair and edges.';
  processingNote.hidden = false;
  showStage('processing');
  try {
    const blob = await runAi(lastFile, 'isnet');
    setProgress(1, 'Done');
    setResultEntry('ai', blob);
    setResultEntry('crisp', null);
    crispCheck.checked = false;
    activeBase = 'ai';
    hqDone = true;
    refreshResultView();
    showToast('Re-processed with the high-quality model');
  } catch (err) {
    console.error(err);
    hqBtn.disabled = false;
    showToast(err?.message || 'High-quality re-run failed. Please try again.');
  } finally {
    busy = false;
    setProgress(0);
    showStage('result');
    if (hqDone) hqBtn.disabled = true;
  }
});

// --- Upload interactions ---

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', (e) => {
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) handleFile(file);
  else showError('No image found in the drop — try a PNG, JPG, or WebP file.');
});

// Paste anywhere on the page.
window.addEventListener('paste', (e) => {
  if (busy) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    handleFile(item.getAsFile());
  }
});

// --- Crisp edges (alpha-matte hardening) ---
//
// The model returns a soft alpha matte: great for hair and fuzzy photo edges,
// but inside flat graphics it can leave pixels slightly translucent, which
// washes the colors out. This remaps alpha so faint halo pixels (< LOW) drop
// to fully transparent, solid pixels (> HIGH) become fully opaque, and only a
// narrow band in between keeps anti-aliased edges smooth.

const CRISP_LOW = 60;
const CRISP_HIGH = 180;

async function makeCrispBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  const scale = 255 / (CRISP_HIGH - CRISP_LOW);
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    d[i] = a <= CRISP_LOW ? 0 : a >= CRISP_HIGH ? 255 : Math.round((a - CRISP_LOW) * scale);
  }
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

crispCheck.addEventListener('change', async () => {
  const base = results[activeBase];
  if (!base) return;
  if (crispCheck.checked) {
    crispCheck.disabled = true;
    try {
      if (!results.crisp) setResultEntry('crisp', await makeCrispBlob(base.blob));
    } catch (err) {
      console.error(err);
      crispCheck.checked = false;
      showToast('Couldn’t sharpen edges for this image.');
    } finally {
      crispCheck.disabled = false;
    }
  }
  refreshResultView();
  setView('result');
});

// --- Result interactions ---

const viewResultBtn = el('view-result');
const viewOriginalBtn = el('view-original');

function setView(mode) {
  const showResult = mode === 'result';
  resultImg.hidden = !showResult;
  originalImg.hidden = showResult;
  viewResultBtn.classList.toggle('active', showResult);
  viewOriginalBtn.classList.toggle('active', !showResult);
  viewResultBtn.setAttribute('aria-selected', String(showResult));
  viewOriginalBtn.setAttribute('aria-selected', String(!showResult));
}

viewResultBtn.addEventListener('click', () => setView('result'));
viewOriginalBtn.addEventListener('click', () => setView('original'));

el('btn-restart').addEventListener('click', () => {
  showStage('upload');
  clearError();
});

el('btn-download').addEventListener('click', () => {
  const active = activeResult();
  if (!active) return;
  const a = document.createElement('a');
  a.href = active.url;
  a.download = 'unveil-transparent.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Saved as unveil-transparent.png');
});

const copyBtn = el('btn-copy');
const copyLabel = el('copy-label');

copyBtn.addEventListener('click', async () => {
  const active = activeResult();
  if (!active) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error('unsupported');
    }
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': active.blob }),
    ]);
    copyBtn.classList.add('copied');
    copyLabel.textContent = 'Copied!';
    showToast('Transparent image copied to clipboard');
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyLabel.textContent = 'Copy image';
    }, 2000);
  } catch (err) {
    console.error(err);
    showToast('Copying isn’t supported in this browser — use Download instead.');
  }
});
