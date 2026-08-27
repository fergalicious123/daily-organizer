"""Generate the icons for Catch, the note app.

Catch installs as its own app with its own home-screen icon, so it needs an
icon that is not the organizer's. Two identical tiles on a launcher is worse
than no second app at all: you would tap the wrong one every time and only find
out after it opened.

The mark is a microphone, because talking at it is the thing you open it to do.
Colour is the app's own accent rather than the organizer's, so they read as a
pair without reading as the same thing.

Reuses the organizer's icon machinery — same supersampled analytic shapes, same
hand-rolled PNG writer, no imaging library on this machine and none wanted.

    python tools/make_catch_icons.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from make_icons import (  # noqa: E402
    SS, downsample, point_on_segment, rounded_rect_inside, write_png,
)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "capture", "icons")

# The blue the app itself uses, deepened for a launcher tile — an icon sits on
# whatever wallpaper is behind it, so it cannot rely on the app's own ground.
BLUE = (58, 122, 158)
BLUE_DEEP = (30, 74, 102)
WHITE = (255, 255, 255)


def render(size, maskable=False):
    """One Catch icon: a microphone on a blue plate."""
    hi = size * SS
    # A maskable icon is cropped hard by the launcher, so the mark sits inside
    # the safe zone and the plate bleeds to the edge.
    pad = hi * 0.18 if maskable else hi * 0.06
    radius = 0 if maskable else hi * 0.22

    left, top = pad, pad
    right, bottom = hi - pad, hi - pad
    width = right - left

    cx = (left + right) / 2
    cy = (top + bottom) / 2

    # Capsule: the body of the microphone.
    cap_w = width * 0.30
    cap_h = width * 0.46
    cap_top = cy - width * 0.30
    cap_bottom = cap_top + cap_h
    cap_r = cap_w / 2

    # The arc under it, drawn as a ring segment, and the stand below.
    arc_r = width * 0.27
    arc_thick = width * 0.075
    arc_cy = cy - width * 0.04

    stem_top = arc_cy + arc_r
    stem_bottom = bottom - width * 0.06
    foot_half = width * 0.15

    pixels = bytearray(hi * hi * 4)

    for py in range(hi):
        y = py + 0.5
        row = py * hi * 4
        for px in range(hi):
            x = px + 0.5
            r = g = b = a = 0

            if maskable or rounded_rect_inside(x, y, 0, 0, hi, hi, radius):
                t = y / hi
                r = int(BLUE[0] * (1 - t) + BLUE_DEEP[0] * t)
                g = int(BLUE[1] * (1 - t) + BLUE_DEEP[1] * t)
                b = int(BLUE[2] * (1 - t) + BLUE_DEEP[2] * t)
                a = 255

            if a:
                on_capsule = rounded_rect_inside(
                    x, y, cx - cap_w / 2, cap_top, cx + cap_w / 2, cap_bottom, cap_r
                )

                # Ring segment: within the band, and below the centre only.
                d = ((x - cx) ** 2 + (y - arc_cy) ** 2) ** 0.5
                on_arc = (
                    abs(d - arc_r) <= arc_thick / 2
                    and y >= arc_cy
                )

                on_stem = point_on_segment(x, y, cx, stem_top, cx, stem_bottom, arc_thick)
                on_foot = point_on_segment(
                    x, y, cx - foot_half, stem_bottom, cx + foot_half, stem_bottom, arc_thick
                )

                if on_capsule or on_arc or on_stem or on_foot:
                    r, g, b = WHITE

            i = row + px * 4
            pixels[i] = r
            pixels[i + 1] = g
            pixels[i + 2] = b
            pixels[i + 3] = a

    return downsample(pixels, hi, size)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a7a9e"/>
      <stop offset="1" stop-color="#1e4a66"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#plate)"/>
  <rect x="188" y="106" width="136" height="208" rx="68" fill="#fff"/>
  <path d="M134 232a122 122 0 0 0 244 0" fill="none" stroke="#fff"
        stroke-width="34" stroke-linecap="round"/>
  <path d="M256 354v58M196 412h120" fill="none" stroke="#fff"
        stroke-width="34" stroke-linecap="round"/>
</svg>
"""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    with open(os.path.join(OUT_DIR, "icon.svg"), "w", encoding="utf-8") as fh:
        fh.write(SVG)

    for name, size, maskable in (
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ):
        write_png(os.path.join(OUT_DIR, name), render(size, maskable), size)
        print(f"  {name}")

    print(f"Catch icons written to {os.path.normpath(OUT_DIR)}")


if __name__ == "__main__":
    main()
