"""Generate the app icons: the right half of the board at the opening position.

Run once, commit the PNGs. Uses only zlib and struct so it needs nothing
installed - there is no Pillow on this machine and no SVG rasteriser.

Every colour is lifted from style.css and every checker from initialPoints()
in rules.js, so the icon is the game's own board rather than a drawing of one.
The right half is the half worth showing: it holds both home boards, and the
opening position puts a five-stack and a two-stack in each row, which reads as
backgammon at 180px in a way an empty board does not.

Shapes are rasterised over their own bounding boxes rather than by testing
every pixel against every shape - the difference between a second and several
minutes. Antialiasing comes from supersampling and a box downsample.
"""

import struct
import sys
import zlib

# --- style.css -------------------------------------------------------------
FRAME = (0x4a, 0x2c, 0x17)        # .board background
EDGE = (0x2e, 0x1a, 0x0e)         # .board border, .bar, .off
FIELD = (0xc9, 0xa0, 0x66)        # .quadrant
POINT_ODD = (0x8b, 0x45, 0x13)    # .point.odd::before
POINT_EVEN = (0xf0, 0xd9, 0xb5)   # .point.even::before
WHITE = (0xf5, 0xf5, 0xf5)        # .checker.white
WHITE_EDGE = (0x99, 0x99, 0x99)
BLACK = (0x22, 0x22, 0x22)        # .checker.black
BLACK_EDGE = (0x66, 0x66, 0x66)

# --- rules.js initialPoints(), right half only -----------------------------
# Top row of the right half runs 19..24 left to right; the bottom row runs
# 6..1. Only four of the twelve are occupied at the start.
TOP_POINTS = [19, 20, 21, 22, 23, 24]
BOTTOM_POINTS = [6, 5, 4, 3, 2, 1]
OPENING = {1: ('black', 2), 6: ('white', 5), 19: ('black', 5), 24: ('white', 2)}

# --- layout, in fractions of the field ------------------------------------
BAR_X0, BAR_X1 = 0.0, 0.08
QUAD_X0, QUAD_X1 = 0.08, 0.86
TRAY_X0, TRAY_X1 = 0.885, 1.0
POINT_W = (QUAD_X1 - QUAD_X0) / 6
TIP = 0.42            # how far a triangle reaches toward the middle
# Deliberately slimmer than the 78% of point width the real board uses. At
# icon size the five-stacks on points 19 and 6 sit in the same column, one
# hanging down and one standing up, and at full size they very nearly touch -
# which reads as a single stripe of beads rather than two opposing stacks.
# Shrinking the checker opens a clear gutter down the middle and the board
# becomes legible at 180px.
R = 0.042             # checker radius
GAP = 0.004           # between stacked checkers
MARGIN = 0.012        # from the field edge to the first checker


class Canvas:
    def __init__(self, size, supersample):
        self.ss = supersample
        self.size = size
        self.w = size * supersample
        self.buf = bytearray(self.w * self.w * 3)

    def fill_all(self, colour):
        self.buf[:] = bytes(colour) * (self.w * self.w)

    def _px(self, x, y, colour):
        i = (y * self.w + x) * 3
        self.buf[i:i + 3] = bytes(colour)

    def rect(self, x0, y0, x1, y1, colour):
        for y in range(max(0, int(y0 * self.w)), min(self.w, int(y1 * self.w) + 1)):
            for x in range(max(0, int(x0 * self.w)), min(self.w, int(x1 * self.w) + 1)):
                self._px(x, y, colour)

    def triangle(self, ax, ay, bx, by, cx, cy, colour):
        xs, ys = (ax, bx, cx), (ay, by, cy)
        x_lo = max(0, int(min(xs) * self.w))
        x_hi = min(self.w, int(max(xs) * self.w) + 1)
        y_lo = max(0, int(min(ys) * self.w))
        y_hi = min(self.w, int(max(ys) * self.w) + 1)

        def side(px, py, x1, y1, x2, y2):
            return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)

        for y in range(y_lo, y_hi):
            py = (y + 0.5) / self.w
            for x in range(x_lo, x_hi):
                px = (x + 0.5) / self.w
                d1 = side(px, py, ax, ay, bx, by)
                d2 = side(px, py, bx, by, cx, cy)
                d3 = side(px, py, cx, cy, ax, ay)
                neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
                pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
                if not (neg and pos):
                    self._px(x, y, colour)

    def disc(self, cx, cy, r, fill, border):
        x_lo = max(0, int((cx - r) * self.w))
        x_hi = min(self.w, int((cx + r) * self.w) + 1)
        y_lo = max(0, int((cy - r) * self.w))
        y_hi = min(self.w, int((cy + r) * self.w) + 1)
        inner = r * 0.80
        for y in range(y_lo, y_hi):
            py = (y + 0.5) / self.w
            for x in range(x_lo, x_hi):
                px = (x + 0.5) / self.w
                d = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
                if d <= inner:
                    self._px(x, y, fill)
                elif d <= r:
                    self._px(x, y, border)

    def downsample(self):
        ss, size, w = self.ss, self.size, self.w
        n = ss * ss
        out = bytearray()
        for y in range(size):
            out.append(0)  # PNG filter type 0
            for x in range(size):
                r = g = b = 0
                for dy in range(ss):
                    base = ((y * ss + dy) * w + x * ss) * 3
                    for dx in range(ss):
                        i = base + dx * 3
                        r += self.buf[i]
                        g += self.buf[i + 1]
                        b += self.buf[i + 2]
                out += bytes((r // n, g // n, b // n))
        return bytes(out)


def draw(canvas, pad):
    """`pad` is the inset of the whole board, larger for the maskable variant
    so a circular crop cannot cut into the points."""
    canvas.fill_all(FRAME)

    border = 0.05                       # the board's own frame
    f0 = pad + border
    f1 = 1 - pad - border

    def fx(u):                          # field u (0..1) -> icon x
        return f0 + u * (f1 - f0)

    def fy(v):
        return f0 + v * (f1 - f0)

    canvas.rect(fx(0), fy(0), fx(1), fy(1), FIELD)
    canvas.rect(fx(BAR_X0), fy(0), fx(BAR_X1), fy(1), EDGE)
    canvas.rect(fx(TRAY_X0), fy(0), fx(TRAY_X1), fy(1), EDGE)

    for row, numbers in (('top', TOP_POINTS), ('bottom', BOTTOM_POINTS)):
        for i, number in enumerate(numbers):
            left = QUAD_X0 + i * POINT_W
            right = left + POINT_W
            mid = left + POINT_W / 2
            colour = POINT_EVEN if number % 2 == 0 else POINT_ODD
            if row == 'top':
                canvas.triangle(fx(left), fy(0), fx(right), fy(0), fx(mid), fy(TIP), colour)
            else:
                canvas.triangle(fx(left), fy(1), fx(right), fy(1), fx(mid), fy(1 - TIP), colour)

            if number not in OPENING:
                continue
            colour_name, count = OPENING[number]
            fill = WHITE if colour_name == 'white' else BLACK
            edge = WHITE_EDGE if colour_name == 'white' else BLACK_EDGE
            step = 2 * R + GAP
            for k in range(count):
                v = (MARGIN + R + k * step) if row == 'top' else (1 - MARGIN - R - k * step)
                canvas.disc(fx(mid), fy(v), R * (f1 - f0), fill, edge)


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))


def write_png(path, size, pad, supersample):
    canvas = Canvas(size, supersample)
    draw(canvas, pad)
    raw = canvas.downsample()
    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header)
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


if __name__ == '__main__':
    out = sys.argv[1].rstrip('/')
    write_png(f'{out}/icon-180.png', 180, 0.02, 4)
    write_png(f'{out}/icon-192.png', 192, 0.02, 4)
    write_png(f'{out}/icon-512.png', 512, 0.02, 3)
    # Maskable: the spec's safe zone is the middle 80%, so the board is inset
    # far enough that a circular mask clips only frame.
    write_png(f'{out}/icon-512-maskable.png', 512, 0.13, 3)
