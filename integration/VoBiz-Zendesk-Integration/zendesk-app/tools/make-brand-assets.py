#!/usr/bin/env python3
"""
Render the Zendesk Marketplace brand assets from the Vobiz mark.

Marketplace requires, in assets/:
  logo.png        320x320, PNG, no rounded corners (the UI rounds them)
  logo-small.png  128x128, PNG-24 with transparency, legible on light AND dark

The mark is public/logo.svg from the Vobiz web properties: two shapes on a 42x30
viewBox, #E83C00 and #E86A00. Both are exact circular sectors, so they are drawn
here with pieslice rather than a bezier rasteriser — the output is identical to
the SVG, not an approximation.

  shape 1  ring sector, centre (42,30), outer r=30, inner r=15, quadrant 180-270
  shape 2  filled sector, centre (0,15), r=15, quadrant 270-360

Run:  python3 tools/make-brand-assets.py
"""
from PIL import Image, ImageDraw

DARK_ORANGE = (232, 60, 0, 255)    # #E83C00
LIGHT_ORANGE = (232, 106, 0, 255)  # #E86A00

VB_W, VB_H = 42.0, 30.0
SS = 8  # supersample factor; the mark is all curves, so this matters


def render_mark(size, margin_ratio):
    """The Vobiz mark, centred on a transparent square canvas of `size` px."""
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Fit the 42x30 viewBox into the square, leaving a margin.
    usable = n * (1 - 2 * margin_ratio)
    scale = min(usable / VB_W, usable / VB_H)
    off_x = (n - VB_W * scale) / 2
    off_y = (n - VB_H * scale) / 2

    def box(cx, cy, r):
        x, y = off_x + cx * scale, off_y + cy * scale
        rr = r * scale
        return [x - rr, y - rr, x + rr, y + rr]

    # Shape 1 — the ring sector. Drawn as an outer sector with the inner sector
    # punched back out, so the hole is genuinely transparent rather than painted
    # over with a background colour (which would show as a seam on dark themes).
    ring = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.pieslice(box(42, 30, 30), 180, 270, fill=DARK_ORANGE)
    rd.pieslice(box(42, 30, 15), 180, 270, fill=(0, 0, 0, 0))
    img.alpha_composite(ring)

    # Shape 2 — the solid quarter disc.
    draw.pieslice(box(0, 15, 15), 270, 360, fill=LIGHT_ORANGE)

    return img.resize((size, size), Image.LANCZOS)


def main():
    # 320x320 Marketplace tile. A white ground keeps the orange mark legible
    # against the Marketplace's own light cards; the UI rounds the corners.
    large = Image.new("RGBA", (320, 320), (255, 255, 255, 255))
    large.alpha_composite(render_mark(320, 0.20))
    large.convert("RGB").save("assets/logo.png", "PNG")
    print("wrote assets/logo.png        320x320")

    # 128x128 in-product icon. Transparent, so the same file reads correctly on
    # Zendesk's light and dark chrome. Orange carries enough contrast on both.
    small = render_mark(128, 0.16)
    small.save("assets/logo-small.png", "PNG")
    print("wrote assets/logo-small.png  128x128 (transparent)")


if __name__ == "__main__":
    main()
