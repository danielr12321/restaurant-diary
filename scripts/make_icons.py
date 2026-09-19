"""Draw the app icons (white fork and knife on red) as PNGs for phones.

Pure Python, no image libraries. Run once: python scripts/make_icons.py
Writes site/icons/icon-192.png, icon-512.png (also used as the maskable icon)
and apple-touch-icon.png. The favicon is site/icons/favicon.svg.
"""

import os
import struct
import zlib

RED = (220, 38, 38)
WHITE = (255, 255, 255)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "site", "icons")

# Shapes on a 64x64 grid, as in the desktop icon: (x0, y0, x1, y1, corner radius).
SHAPES = [(tx - 1.4, 14, tx + 1.4, 27, 1.4) for tx in (19.0, 23.5, 28.0)] + [
    (17.6, 25, 29.4, 30.5, 2.5),  # fork bridge
    (21.3, 28, 25.7, 50, 2.2),    # fork handle
    (37, 14, 45, 33, 3.5),        # knife blade
    (38.8, 30, 43.2, 50, 2.2),    # knife handle
]


def inside(px, py):
    for x0, y0, x1, y1, r in SHAPES:
        if x0 <= px <= x1 and y0 <= py <= y1:
            cx = min(max(px, x0 + r), x1 - r)
            cy = min(max(py, y0 + r), y1 - r)
            if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                return True
    return False


def render(size, samples=3):
    """Full-bleed red square; the glyph sits inside the maskable safe zone."""
    scale = 64.0 / size
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            hits = 0
            for i in range(samples):
                for j in range(samples):
                    if inside((x + (i + 0.5) / samples) * scale, (y + (j + 0.5) / samples) * scale):
                        hits += 1
            a = hits / (samples * samples)
            row += bytes(int(RED[k] * (1 - a) + WHITE[k] * a) for k in range(3))
        rows.append(bytes(row))
    return rows


def write_png(path, size):
    rows = render(size)
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)
    print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    write_png(os.path.join(OUT, "icon-192.png"), 192)
    write_png(os.path.join(OUT, "apple-touch-icon.png"), 180)
    write_png(os.path.join(OUT, "icon-512.png"), 512)
