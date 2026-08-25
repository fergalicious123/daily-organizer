# Fonts

Self-hosted rather than linked from Google Fonts, because this is an
offline-first app and the service worker never caches cross-origin requests —
a linked font would simply disappear the moment the signal did.

| File | Family | Licence |
|---|---|---|
| `figtree-latin-var.woff2` | Figtree (variable, 400–700) | SIL Open Font License 1.1 |
| `instrumentserif-latin.woff2` | Instrument Serif | SIL Open Font License 1.1 |
| `instrumentserif-latin-italic.woff2` | Instrument Serif Italic | SIL Open Font License 1.1 |

Both are OFL, which permits redistribution as part of this app. Latin subset
only; 62KB for all three.

## Why these two

The look is modelled on Granola, which uses **Melange** for body text and
**Quadrant** for display. Both are licensed commercial fonts and are *not*
ours to ship, so these are open-licensed faces chosen to do the same job:
Figtree is a warm humanist sans in Melange's territory, Instrument Serif a
high-contrast display serif in Quadrant's.

The serif is used only where Granola uses it — the name of the view you are
looking at. Everywhere else it would be costume.
