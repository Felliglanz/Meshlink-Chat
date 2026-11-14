#!/usr/bin/env python3
"""Erzeugt die PNG-Icons der PWA ohne externe Bibliotheken (nur zlib)."""
import math
import struct
import sys
import zlib
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "public/icons")
BG = (31, 111, 92)
FG = (255, 255, 255)
NODES = [(0.36, 0.52), (0.50, 0.37), (0.64, 0.52)]


def sd_round_rect(x, y, x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    qx, qy = abs(x - cx) - hx, abs(y - cy) - hy
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def in_tri(x, y, a, b, c):
    def s(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1, d2, d3 = s((x, y), a, b), s((x, y), b, c), s((x, y), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def seg_dist(x, y, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)


def sample(x, y, mode):
    """Liefert (r,g,b,a) für einen Punkt in Einheitskoordinaten."""
    if mode == "maskable":  # Inhalt in die Safe-Zone (80 %) schrumpfen, Hintergrund vollflächig
        bg = True
        x, y = (x - 0.5) / 0.78 + 0.5, (y - 0.5) / 0.78 + 0.5
    elif mode == "badge":
        bg = False
        x, y = (x - 0.5) / 1.25 + 0.5, (y - 0.42) / 1.25 + 0.45
    else:
        bg = sd_round_rect(x, y, 0, 0, 1, 1, 0.22) <= 0
    bubble = sd_round_rect(x, y, 0.2, 0.22, 0.8, 0.68, 0.13) <= 0 or in_tri(x, y, (0.30, 0.64), (0.44, 0.64), (0.27, 0.81))
    if bubble:
        inner = any(math.hypot(x - nx, y - ny) <= 0.048 for nx, ny in NODES) or any(
            seg_dist(x, y, NODES[i], NODES[j]) <= 0.014 for i, j in ((0, 1), (1, 2), (0, 2))
        )
        if inner:
            return (*BG, 255) if mode != "badge" else (0, 0, 0, 0)
        return (*FG, 255)
    if bg:
        return (*BG, 255)
    return (0, 0, 0, 0)


def render(size, mode, ss=4):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    r, g, b, a = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, mode)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = ss * ss
            a = acc[3] / n
            if a:
                row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(a)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


OUT.mkdir(parents=True, exist_ok=True)
for name, size, mode in [
    ("icon-192.png", 192, "any"),
    ("icon-512.png", 512, "any"),
    ("maskable-512.png", 512, "maskable"),
    ("apple-touch-icon.png", 180, "maskable"),
    ("badge-96.png", 96, "badge"),
]:
    write_png(OUT / name, size, render(size, mode, ss=3 if size > 200 else 4))
    print("geschrieben:", OUT / name)
