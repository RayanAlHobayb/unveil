# Unveil — Background Remover

A clean, single-page web app that removes image backgrounds entirely in the browser.

**Live at [unveil-henna.vercel.app](https://unveil-henna.vercel.app)** — pushes to `main` deploy automatically via Vercel.

- **Drop, browse, or paste** (⌘V) a PNG / JPG / WebP image
- AI segmentation runs **locally** via [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) — images never leave the device
- Preview the transparent result on a checkerboard, toggle against the original
- **Download** the transparent PNG or **copy** it straight to the clipboard

## Running

It's a static site — serve the folder with any web server:

```sh
python3 -m http.server 4173
# then open http://localhost:4173
```

Notes:
- The first image triggers a one-time ~40 MB model download (cached by the browser afterwards).
- Clipboard copy requires a secure context (localhost or HTTPS).

## License

Released under [AGPL-3.0](LICENSE) — required because the app is built on the
AGPL-licensed [`@imgly/background-removal`](https://github.com/imgly/background-removal-js)
library. The site is and stays free to use.

## Files

- `index.html` — page structure (upload / processing / result stages)
- `styles.css` — design system: Inter, cyan accent, glass + checkerboard
- `app.js` — drag-drop/paste handling, background removal, download/copy
