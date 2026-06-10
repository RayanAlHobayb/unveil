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

let rawBlob = null;      // result straight from the model (soft alpha matte)
let crispBlob = null;    // hardened-alpha version, computed lazily
let resultBlob = null;   // whichever of the two is active (used by download/copy)
let originalUrl = null;
let rawUrl = null;
let crispUrl = null;
let busy = false;

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
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
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

  for (const url of [originalUrl, rawUrl, crispUrl]) {
    if (url) URL.revokeObjectURL(url);
  }
  rawUrl = crispUrl = null;
  rawBlob = crispBlob = resultBlob = null;
  crispCheck.checked = false;

  originalUrl = URL.createObjectURL(file);
  processingThumb.src = originalUrl;
  setProgress(0.02, 'Loading AI engine…');
  processingNote.hidden = false;
  showStage('processing');

  try {
    await loadModule();
    setProgress(0.06, 'Preparing model…');

    rawBlob = await removeBackground(file, {
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        const fraction = total > 0 ? current / total : 0;
        if (key.startsWith('fetch')) {
          // Model + WASM download maps to 5–60% of the bar.
          setProgress(0.05 + fraction * 0.55, `Downloading model… ${Math.round(fraction * 100)}%`);
        } else {
          processingNote.hidden = true;
          setProgress(0.6 + fraction * 0.4, 'Removing background…');
        }
      },
    });

    setProgress(1, 'Done');
    resultBlob = rawBlob;
    rawUrl = URL.createObjectURL(rawBlob);
    resultImg.src = rawUrl;
    originalImg.src = originalUrl;
    setView('result');
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

// --- Crisp edges (alpha-matte hardening for logos & graphics) ---
//
// The model returns a soft alpha matte: great for hair and fuzzy photo edges,
// but inside flat graphics it can leave pixels slightly translucent, which
// washes the colors out. This remaps alpha so faint halo pixels (< LOW) drop
// to fully transparent, solid pixels (> HIGH) become fully opaque, and only a
// narrow band in between keeps anti-aliased edges smooth.

const CRISP_LOW = 60;
const CRISP_HIGH = 180;

const crispCheck = el('crisp-check');

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
  if (!rawBlob) return;
  if (crispCheck.checked) {
    crispCheck.disabled = true;
    try {
      if (!crispBlob) {
        crispBlob = await makeCrispBlob(rawBlob);
        crispUrl = URL.createObjectURL(crispBlob);
      }
      resultBlob = crispBlob;
      resultImg.src = crispUrl;
    } catch (err) {
      console.error(err);
      crispCheck.checked = false;
      showToast('Couldn’t sharpen edges for this image.');
    } finally {
      crispCheck.disabled = false;
    }
  } else {
    resultBlob = rawBlob;
    resultImg.src = rawUrl;
  }
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
  if (!resultBlob) return;
  const a = document.createElement('a');
  a.href = resultBlob === crispBlob ? crispUrl : rawUrl;
  a.download = 'unveil-transparent.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Saved as unveil-transparent.png');
});

const copyBtn = el('btn-copy');
const copyLabel = el('copy-label');

copyBtn.addEventListener('click', async () => {
  if (!resultBlob) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error('unsupported');
    }
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': resultBlob }),
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
