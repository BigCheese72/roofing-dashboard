# App icons

Home-screen / PWA icons generated from the new RoofOps logo (metallic "RO"
house monogram, red accent, black background). See "Home-screen app icon"
in `DEV_NOTES.md` for the full writeup.

- `source/roofops-logo-source.png` — the original full logo (monogram +
  "ROOF OPS" wordmark), as provided by Mark. Kept for reference/reruns.
- `source/gen_icons.py` — the script that produced everything below from
  the source logo (crops the monogram, pads it onto a black square, adds
  the DEV ribbon). Not part of the app build; a one-off asset tool, rerun
  by hand if the logo changes.
- `source/monogram-master-1024.png` / `monogram-dev-master-1024.png` —
  the full-resolution masters (clean / DEV-badged) the sized PNGs below
  were downsampled from.
- `dev/icon-180.png`, `dev/icon-192.png`, `dev/icon-512.png` — **currently
  wired into `index.html`/`manifest.json` on the `dev` branch.** Same
  monogram with a red "DEV" ribbon across the bottom-left corner, so the
  dev build's home-screen icon is visually distinct from production at a
  glance.
- `prod/icon-180.png`, `prod/icon-192.png`, `prod/icon-512.png` — the
  clean (no ribbon) equivalents, generated and committed but **not yet
  wired into anything** — ready for when this ships to `main`. At that
  point: point `index.html`'s icon links at `icons/prod/*`, and swap in a
  `manifest.json` with `name`/`short_name: "RoofOps"` (no "DEV") and the
  `icons/prod/*` paths.

All icons are square PNGs on a solid black background (`#000`), monogram
only — the "ROOF OPS" wordmark was dropped for the small sizes since it
wasn't legible at home-screen icon size; the full logo remains available
in `source/` for anywhere the wordmark itself is wanted.
