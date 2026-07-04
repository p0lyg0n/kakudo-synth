#!/usr/bin/env python3
"""Generate PWA icons for Kakudo Synth using Pillow.

Draws a rounded-square app icon with a radial gradient background and a
stylised "tilt orbit" motif (a dot on a ring, evoking orientation control).
Outputs the sizes required by the manifest and iOS home-screen.
"""
import math
import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

# Brand colors
BG_TOP = (124, 92, 255)     # violet
BG_BOTTOM = (34, 211, 238)  # cyan
ACCENT = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size, maskable=False):
    # Render at 4x for smooth edges, then downsample.
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background: diagonal gradient painted line by line.
    for y in range(s):
        t = y / (s - 1)
        col = lerp(BG_TOP, BG_BOTTOM, t)
        draw.line([(0, y), (s, y)], fill=col + (255,))

    # For non-maskable icons, clip to a rounded square with transparent corners.
    if not maskable:
        mask = Image.new("L", (s, s), 0)
        md = ImageDraw.Draw(mask)
        radius = int(s * 0.22)
        md.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
        img.putalpha(mask)

    cx = cy = s / 2
    # Orbit ring
    ring_r = s * 0.30
    ring_w = int(s * 0.028)
    draw.ellipse(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        outline=ACCENT + (235,),
        width=ring_w,
    )

    # Inner core dot
    core_r = s * 0.075
    draw.ellipse(
        [cx - core_r, cy - core_r, cx + core_r, cy + core_r],
        fill=ACCENT + (255,),
    )

    # Tilt indicator dot on the ring (upper-right, like a tilted position)
    ang = math.radians(-38)
    dx = cx + ring_r * math.cos(ang)
    dy = cy + ring_r * math.sin(ang)
    dot_r = s * 0.085
    draw.ellipse(
        [dx - dot_r, dy - dot_r, dx + dot_r, dy + dot_r],
        fill=ACCENT + (255,),
    )
    # subtle connecting line from core to dot
    draw.line([(cx, cy), (dx, dy)], fill=ACCENT + (150,), width=int(s * 0.014))

    img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
        ("favicon-32.png", 32, False),
    ]
    for name, size, maskable in targets:
        img = render(size, maskable)
        path = os.path.join(OUT_DIR, name)
        img.save(path)
        print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
