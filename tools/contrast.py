#!/usr/bin/env python3
"""Check the design tokens meet WCAG AA, in both themes.

The stylesheet says, at the top of the token block, "If you change one, re-run
the check rather than trusting it to look fine." This is that check. It was a
throwaway script the first time and lived only in a terminal, which meant the
instruction pointed at nothing. Now it does not.

Why offline rather than in the browser: reading computed styles back out of a
live page returns stale values after a theme flip, and the preview browser here
does not composite, so "looks fine" is not available as evidence. Parsing the
tokens out of the CSS and doing the arithmetic is both faster and honest.

    python tools/contrast.py

Exits non-zero if anything fails, so it can gate a commit.
"""

import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "css" / "styles.css"

# AA thresholds. Body copy needs 4.5; large text (>=24px, or >=18.66px bold)
# and non-text UI boundaries need 3.0.
AA_TEXT = 4.5
AA_LARGE = 3.0


def parse_block(css: str, selector: str) -> dict:
    """Pull `--name: value` pairs out of the first matching rule."""
    # Non-greedy to the first closing brace: the token blocks contain no nested
    # rules, so this is sufficient and avoids needing a real parser.
    match = re.search(re.escape(selector) + r"\s*\{(.*?)\n\}", css, re.S)
    if not match:
        raise SystemExit(f"Could not find the {selector} block in {CSS.name}")
    return dict(re.findall(r"(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;", match.group(1)))


def srgb_to_linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def luminance(hex_colour: str) -> float:
    value = hex_colour.lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    r, g, b = (int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return (0.2126 * srgb_to_linear(r)
            + 0.7152 * srgb_to_linear(g)
            + 0.0722 * srgb_to_linear(b))


def ratio(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    lighter, darker = max(a, b), min(a, b)
    return (lighter + 0.05) / (darker + 0.05)


# (label, foreground token, background token, threshold)
#
# Every pair the app actually renders. A token that is never drawn on a given
# surface is not listed — a check that invents combinations reports failures
# nobody can see and trains you to ignore it.
PAIRS = [
    # Body copy
    ("body text on page",            "--text",         "--bg",           AA_TEXT),
    ("body text on card",            "--text",         "--surface",      AA_TEXT),
    ("body text on raised card",     "--text",         "--surface-2",    AA_TEXT),
    ("body text on sunk panel",      "--text",         "--surface-sunk", AA_TEXT),
    ("muted text on page",           "--text-muted",   "--bg",           AA_TEXT),
    ("muted text on card",           "--text-muted",   "--surface",      AA_TEXT),
    ("muted text on raised card",    "--text-muted",   "--surface-2",    AA_TEXT),
    ("muted text on sunk panel",     "--text-muted",   "--surface-sunk", AA_TEXT),

    # Accent
    ("accent link on card",          "--accent",       "--surface",      AA_TEXT),
    ("accent link on page",          "--accent",       "--bg",           AA_TEXT),
    ("accent button label",          "--accent-text",  "--accent",       AA_TEXT),
    ("accent on its own soft fill",  "--accent",       "--accent-soft",  AA_TEXT),

    # Status colours, on the plain surfaces and on their own soft fills
    ("danger on card",               "--danger",       "--surface",      AA_TEXT),
    ("danger on its soft fill",      "--danger",       "--danger-soft",  AA_TEXT),
    ("success on card",              "--success",      "--surface",      AA_TEXT),
    ("success on its soft fill",     "--success",      "--success-soft", AA_TEXT),
    ("warning on card",              "--warning",      "--surface",      AA_TEXT),
    ("warning on its soft fill",     "--warning",      "--warning-soft", AA_TEXT),

    # Priority accents, checked the two ways they are actually drawn. The first
    # version of this file asserted "--p-medium as text on a card", which the
    # app never renders; the pairs that ARE rendered are a checkbox border
    # (a control boundary, 3:1) and a label on the active pill (text, 4.5:1).
    # Checking the wrong pair reported a failure that did not exist and hid two
    # that did.
    ("high pill label",              "--p-high-text",   "--p-high",      AA_TEXT),
    ("medium pill label",            "--p-medium-text", "--p-medium",    AA_TEXT),
    ("low pill label",               "--p-low-text",    "--p-low",       AA_TEXT),
    ("high checkbox border",         "--p-high",        "--surface",     AA_LARGE),
    ("medium checkbox border",       "--p-medium",      "--surface",     AA_LARGE),
    ("low checkbox border",          "--p-low",         "--surface",     AA_LARGE),

    # Non-text. 1.4.11 covers boundaries you NEED in order to identify a
    # control — an input's outline qualifies. A card's outline does not: the
    # surfaces already differ and the content is inside it either way, so
    # asserting 3:1 there reports a failure nobody can perceive as one. That
    # assertion was here and was wrong; this is the version that is not.
    ("input outline",                "--border-strong", "--surface-2",   AA_LARGE),
    ("chart fill vs track",          "--chart-fill",   "--chart-track",  AA_LARGE),
]

# Known-failing pairs, listed rather than quietly excluded.
#
# --text-faint is 3.2:1 in light and 3.7:1 in dark. It predates this check and
# is used in a lot of places, so fixing it is a deliberate change to the look of
# the whole app rather than a tidy-up, and it needs signing off. Recording it
# here keeps it visible instead of letting a green run imply it is fine.
KNOWN_BAD = {
    # Empty, and that is the point.
    #
    # Two entries lived here: --text-faint (3.2 light / 3.7 dark) and the form
    # field outline (1.2 / 1.2). Both were real, both were left alone because
    # fixing them changed the look of something in daily use. The Granola
    # restyle changed that look deliberately, so both were fixed as part of it
    # rather than left as permanent exceptions.
}


def main() -> int:
    css = CSS.read_text(encoding="utf-8")
    themes = {
        "light": parse_block(css, ":root"),
        "dark": parse_block(css, ':root[data-theme="dark"]'),
    }
    # The dark block only redefines what changes, so anything it leaves out is
    # inherited from light. Without this, a token defined once reads as missing
    # in dark and the pair is silently skipped.
    themes["dark"] = {**themes["light"], **themes["dark"]}
    # --chart-fill is `var(--accent)` rather than a literal, so it never matches
    # the hex pattern above. Resolve the one indirection the token set has.
    for tokens in themes.values():
        tokens.setdefault("--chart-fill", tokens["--accent"])

    failures, warnings = [], []

    for theme, tokens in themes.items():
        for label, fg, bg, threshold in PAIRS + sorted(KNOWN_BAD):
            if fg not in tokens or bg not in tokens:
                warnings.append(f"{theme:5}  {label}: token missing ({fg} or {bg})")
                continue
            value = ratio(tokens[fg], tokens[bg])
            known = (label, fg, bg, threshold) in KNOWN_BAD
            ok = value >= threshold
            mark = "ok  " if ok else ("known" if known else "FAIL")
            line = f"{mark}  {theme:5}  {value:5.2f}:1  (needs {threshold})  {label}"
            print(line)
            if not ok and not known:
                failures.append(line)

    print()
    for warning in warnings:
        print("warn  " + warning)

    if failures:
        print(f"\n{len(failures)} pair(s) below AA:")
        for line in failures:
            print("  " + line)
        return 1

    print(f"\nAll {len(PAIRS) * 2} checked pairs meet AA. "
          f"{len(KNOWN_BAD) * 2} known exceptions reported above, not fixed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
