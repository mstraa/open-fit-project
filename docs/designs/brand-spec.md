# Brand spec — Open Fit (active: blue Garmin Connect-class dark theme)

The local reference (`192.168.1.29:8080`) was unreachable, then the supplied
screenshots turned out to be a qBittorrent/qbitctl control panel (black + orange,
monospace). The user preferred the earlier self-chosen blue direction, so that is
the active system. The orange-reference tokens are retained only as the optional
"Terminal" theme swatch in settings.

## Posture
- **Garmin Connect-class athletic dark theme.** Data-dense, calm, professional.
- **Deep navy-charcoal canvas**, hairline borders, no shadows except overlays.
- **Single electric-blue primary**; color otherwise carries the data, not decoration.
- **Sans display + tabular monospace numerics** — it's a data product, numbers align.
- **Per-metric domain colors** so each metric is instantly readable.

## Color tokens (OKLch)
```css
--bg:      oklch(15% 0.018 260);   /* deep navy-charcoal */
--surface: oklch(18% 0.020 260);
--fg:      oklch(94% 0.008 250);
--muted:   oklch(67% 0.020 255);
--border:  oklch(28% 0.020 260);
--accent:  oklch(64% 0.170 250);   /* electric blue */
```

### Per-metric hues
HR coral `25` · power violet `300` · pace cyan `220` · cadence amber `85` ·
elevation green `150` · calories orange `55`.

## Type
- Display/body: `-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif`
- Numerics/code: `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace` with `tabular-nums`

## Layout rules
1. Radius 6/9/14px — softer than the terminal reference.
2. Borders hairline neutral; electric blue used as primary/highlight, at most twice per screen.
3. Micro-labels: 10–11px, uppercase, letter-spaced, `--faint`.
4. No background gradients beyond faint hero glows; no decorative shadows.
5. Blue stays dominant; metric hues are saturated only where they encode data.
