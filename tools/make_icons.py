"""Generate the PWA icon PNGs.

Written against the standard library only — this machine has no Pillow, and a
build dependency for four static images would be a poor trade. Shapes are
tested analytically and supersampled 4x, then box-downsampled, which gives
clean anti-aliased edges without any imaging library.

Run from the project root:
    python tools/make_icons.py
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

ACCENT = (61, 92, 204)      # --accent
ACCENT_DEEP = (44, 68, 160)
WHITE = (255, 255, 255)
SS = 4                       # supersample factor


# ---------------------------------------------------------------- geometry


def rounded_rect_inside(x, y, left, top, right, bottom, radius):
    """True when (x, y) falls inside a rounded rectangle.

    Which corner is being tested is decided by WHICH ONE it is, not by
    comparing its centre back to an edge. The old version did the latter, and
    it broke the moment a radius reached half the width: on a pill shape
    `left + radius` and `right - radius` are the same number, so every corner
    matched the left-hand test and the right-hand side came out square. The
    organizer's own icon never hit it because its radius is 7% of the width;
    the microphone capsule in Catch is a true pill, and drew with a flat right
    edge and a bite out of it.
    """
    if x < left or x > right or y < top or y > bottom:
        return False
    # Corner regions get a circle test; everything else is a plain rect.
    for is_left, is_top in ((True, True), (False, True), (True, False), (False, False)):
        cx = left + radius if is_left else right - radius
        cy = top + radius if is_top else bottom - radius
        in_corner_x = x < left + radius if is_left else x > right - radius
        in_corner_y = y < top + radius if is_top else y > bottom - radius
        if in_corner_x and in_corner_y:
            return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
    return True


def point_on_segment(px, py, ax, ay, bx, by, width):
    """True when (px, py) lies within `width`/2 of segment AB (round caps)."""
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        t = 0.0
    else:
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    cx, cy = ax + t * dx, ay + t * dy
    return (px - cx) ** 2 + (py - cy) ** 2 <= (width / 2) ** 2


# ---------------------------------------------------------------- painting


def render(size, maskable=False):
    """Return an RGBA bytearray for one icon."""
    hi = size * SS
    # Maskable icons must survive an aggressive circular crop, so the artwork
    # sits inside the safe zone (80% of the canvas) and the background bleeds.
    pad = hi * 0.18 if maskable else hi * 0.06
    radius = 0 if maskable else hi * 0.22

    inner_left = pad
    inner_top = pad
    inner_right = hi - pad
    inner_bottom = hi - pad
    inner_w = inner_right - inner_left

    # Calendar body
    cal_left = inner_left + inner_w * 0.10
    cal_right = inner_right - inner_w * 0.10
    cal_top = inner_top + inner_w * 0.20
    cal_bottom = inner_bottom - inner_w * 0.08
    cal_radius = inner_w * 0.07

    # Header band of the calendar
    band_bottom = cal_top + (cal_bottom - cal_top) * 0.22

    # Two hanging rings above the calendar
    ring_r = inner_w * 0.035
    ring_y = cal_top - inner_w * 0.02
    ring_x1 = cal_left + (cal_right - cal_left) * 0.28
    ring_x2 = cal_left + (cal_right - cal_left) * 0.72

    # Check mark inside the body
    body_cx = (cal_left + cal_right) / 2
    body_cy = (band_bottom + cal_bottom) / 2
    span = (cal_right - cal_left) * 0.52
    stroke = inner_w * 0.085
    ax, ay = body_cx - span * 0.48, body_cy + span * 0.02
    bx, by = body_cx - span * 0.12, body_cy + span * 0.32
    cx2, cy2 = body_cx + span * 0.50, body_cy - span * 0.34

    hi_pixels = bytearray(hi * hi * 4)

    for py in range(hi):
        y = py + 0.5
        row = py * hi * 4
        for px in range(hi):
            x = px + 0.5
            r = g = b = a = 0

            # Background plate
            if maskable or rounded_rect_inside(x, y, 0, 0, hi, hi, radius):
                # A soft vertical gradient reads better than a flat fill at
                # launcher sizes without needing a real gradient encoder.
                t = y / hi
                r = int(ACCENT[0] * (1 - t) + ACCENT_DEEP[0] * t)
                g = int(ACCENT[1] * (1 - t) + ACCENT_DEEP[1] * t)
                b = int(ACCENT[2] * (1 - t) + ACCENT_DEEP[2] * t)
                a = 255

            if a:
                on_calendar = rounded_rect_inside(
                    x, y, cal_left, cal_top, cal_right, cal_bottom, cal_radius
                )
                in_band = on_calendar and y <= band_bottom
                on_ring = (
                    (x - ring_x1) ** 2 + (y - ring_y) ** 2 <= ring_r * ring_r
                    or (x - ring_x2) ** 2 + (y - ring_y) ** 2 <= ring_r * ring_r
                )
                on_check = point_on_segment(x, y, ax, ay, bx, by, stroke) or point_on_segment(
                    x, y, bx, by, cx2, cy2, stroke
                )

                if on_ring:
                    r, g, b = WHITE
                elif on_check:
                    r, g, b = WHITE
                elif in_band:
                    r, g, b = WHITE
                elif on_calendar:
                    # Body is a translucent white so the plate shows through,
                    # keeping the mark readable at 48px.
                    r = int(r * 0.18 + WHITE[0] * 0.82)
                    g = int(g * 0.18 + WHITE[1] * 0.82)
                    b = int(b * 0.18 + WHITE[2] * 0.82)

            i = row + px * 4
            hi_pixels[i] = r
            hi_pixels[i + 1] = g
            hi_pixels[i + 2] = b
            hi_pixels[i + 3] = a

    return downsample(hi_pixels, hi, size)


def downsample(pixels, hi, size):
    """Box-filter SSxSS blocks down to the final size."""
    out = bytearray(size * size * 4)
    factor = SS * SS
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                base = ((y * SS + dy) * hi + x * SS) * 4
                for dx in range(SS):
                    i = base + dx * 4
                    alpha = pixels[i + 3]
                    # Weight colour by alpha so transparent edges don't drag
                    # the rounded corners toward black.
                    r += pixels[i] * alpha
                    g += pixels[i + 1] * alpha
                    b += pixels[i + 2] * alpha
                    a += alpha
            o = (y * size + x) * 4
            if a:
                out[o] = min(255, r // a)
                out[o + 1] = min(255, g // a)
                out[o + 2] = min(255, b // a)
            out[o + 3] = a // factor
    return out


# ---------------------------------------------------------------- png


def write_png(path, pixels, size):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)                                  # filter type 0 (None)
        raw.extend(pixels[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as fh:
        fh.write(png)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3d5ccc"/>
      <stop offset="1" stop-color="#2c44a0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#plate)"/>
  <circle cx="196" cy="118" r="16" fill="#fff"/>
  <circle cx="316" cy="118" r="16" fill="#fff"/>
  <rect x="106" y="122" width="300" height="300" rx="32" fill="#fff" opacity=".86"/>
  <path d="M106 154a32 32 0 0 1 32-32h236a32 32 0 0 1 32 32v42H106z" fill="#fff"/>
  <path d="M180 300l52 52 108-116" fill="none" stroke="#3d5ccc"
        stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    with open(os.path.join(OUT_DIR, "icon.svg"), "w", encoding="utf-8") as fh:
        fh.write(SVG)

    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]
    for name, size, maskable in targets:
        path = os.path.join(OUT_DIR, name)
        write_png(path, render(size, maskable), size)
        print(f"wrote {name} ({size}x{size}{', maskable' if maskable else ''})")

    print("wrote icon.svg")


if __name__ == "__main__":
    main()
