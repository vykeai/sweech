# sweech mascot

Viking lollipop. Captures the "switcher" identity (sweet candy lineage from the
prior 🍭 emoji) with a Viking forge accent (matching the vysual sweech theme:
forest dark + amber).

## Files

| Path | Use |
|---|---|
| `mascot-full-<N>.png` | full character with axe — dashboard hero, CLI welcome banner, marketing |
| `mascot-glyph-<N>.png` | simplified (no axe) for tray/menubar — 16/32/64/128/256 |
| `master-on-forge-dark.png` | 1024px G3 on forest-dark bg — marketing / readme hero |

## Provenance

- Generated 2026-05-18 via FLUX.1-Kontext-dev on mac-studio (mflux 0.x, q4)
- Source character: E-lollipop-axe-3.png (FLUX.1-dev, prompt: viking-helmet
  + axe + lollipop, three-quarter view, forest-dark background)
- Eyes added via Kontext edit (G-kontext-3.png)
- Axe stripped via second Kontext pass for tray glyph (H-glyph-2.png)
- Backgrounds removed via rembg/u2net
- Resized via ImageMagick (`magick … -resize NxN`)

## Replacing the lollipop emoji

The 🍭 emoji still appears in ~37 places across sweech (CLI + Swift). Replace
ONLY after user sign-off. Replacement strategy:
- TUI/terminal contexts: keep 🍭 (emoji is rendered glyph, mascot is bitmap)
- Dashboard/Swift contexts: load `mascot-full-128.png` / `mascot-glyph-32.png`

## Future work

- SVG vector via potrace + manual cleanup
- 16px hand-tuned glyph (current 16px is a generic orange blob)
- @2x/@3x retina variants if menubar contexts call for them
