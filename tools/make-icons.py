"""Generate the app icons: the game's own board at the opening position.

Run by hand and committed alongside its output. Nothing invokes it, so the
project's no-build-step property is intact - it exists because the icon
encodes constants owned by style.css and rules.js, and a palette change
would otherwise leave four opaque PNGs nobody could regenerate.

    python3 tools/make-icons.py .

Uses only zlib and struct: there is no Pillow on this machine and no SVG
rasteriser. Antialiasing comes from supersampling and a box downsample.
Shapes rasterise over their own bounding boxes rather than testing every
pixel against every shape - the difference between a second and minutes.

LAYOUT below chooses what is drawn. 'full' is the whole board; 'half' is the
right half, which holds both home boards. The half is far more legible at
180px - the whole board puts 24 points across the icon, each about six
pixels wide - so switch with your eyes open.
"""

import struct
import sys
import zlib

LAYOUT = 'full'

# --- colours, all lifted from style.css ------------------------------------
FRAME = (0x4a, 0x2c, 0x17)        # .board background
EDGE = (0x2e, 0x1a, 0x0e)         # .board border, .bar, .off
FIELD = (0xc9, 0xa0, 0x66)        # .quadrant
POINT_ODD = (0x8b, 0x45, 0x13)    # .point.odd::before
POINT_EVEN = (0xf0, 0xd9, 0xb5)   # .point.even::before
WHITE = (0xf5, 0xf5, 0xf5)        # .checker.white
WHITE_EDGE = (0x99, 0x99, 0x99)
BLACK = (0x22, 0x22, 0x22)        # .checker.black
BLACK_EDGE = (0x66, 0x66, 0x66)

# --- rules.js initialPoints() ----------------------------------------------
OPENING = {
    1: ('black', 2), 6: ('white', 5), 8: ('white', 3), 12: ('black', 5),
    13: ('white', 5), 17: ('black', 3), 19: ('black', 5), 24: ('white', 2),
}

# --- layouts ---------------------------------------------------------------
# Point order matches index.html reading left to right. `aspect` is the
# field's width over its height; the field is letterboxed inside the square
# at that ratio, so the whole board keeps the 950x640 proportions it has on
# screen instead of being stretched to fit.
LAYOUTS = {
    'full': {
        'top': [13, 14, 15, 16, 17, 18, 'bar', 19, 20, 21, 22, 23, 24, 'tray'],
        'bottom': [12, 11, 10, 9, 8, 7, 'bar', 6, 5, 4, 3, 2, 1, 'tray'],
        'aspect': 950 / 640,
        'bar_w': 0.055,
        'tray_w': 0.065,
        'checker': 0.78,   # of point width, matching --checker-in-point
        'tip': 0.42,
        # Thinner than the half's frame on purpose. A 950:640 board inside a
        # square is letterboxed to about 60% of the icon's height whatever
        # you do, so every pixel spent on frame is one the board does not
        # get - and at 180px the board needs all of them.
        'border': 0.022,
    },
    'half': {
        'top': ['bar', 19, 20, 21, 22, 23, 24, 'tray'],
        'bottom': ['bar', 6, 5, 4, 3, 2, 1, 'tray'],
        'aspect': 1.0,
        'bar_w': 0.08,
        'tray_w': 0.115,
        # Slimmer than the real 78% on purpose: points 19 and 6 share a
        # column, one stack hanging down and one standing up, and at true
        # scale their five-stacks all but touch - which at 180px reads as a
        # single stripe of beads rather than two opposing stacks.
        'checker': 0.65,
        'tip': 0.42,
        'border': 0.05,
    },
}

GAP = 0.06       # between stacked checkers, as a fraction of checker diameter
MARGIN = 0.012   # from the field edge to the first checker, in field-v units


def slots(spec):
    """x ranges for every column, in field-u units (0..1 across the field)."""
    row = spec['top']
    n_points = sum(1 for s in row if s != 'bar' and s != 'tray')
    fixed = spec['bar_w'] * row.count('bar') + spec['tray_w'] * row.count('tray')
    point_w = (1.0 - fixed) / n_points
    out, x = [], 0.0
    for s in row:
        w = spec['bar_w'] if s == 'bar' else spec['tray_w'] if s == 'tray' else point_w
        out.append((s, x, x + w))
        x += w
    return out, point_w


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
        x_lo, x_hi = max(0, int(min(xs) * self.w)), min(self.w, int(max(xs) * self.w) + 1)
        y_lo, y_hi = max(0, int(min(ys) * self.w)), min(self.w, int(max(ys) * self.w) + 1)

        def side(px, py, x1, y1, x2, y2):
            return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)

        for y in range(y_lo, y_hi):
            py = (y + 0.5) / self.w
            for x in range(x_lo, x_hi):
                px = (x + 0.5) / self.w
                d1 = side(px, py, ax, ay, bx, by)
                d2 = side(px, py, bx, by, cx, cy)
                d3 = side(px, py, cx, cy, ax, ay)
                if not (((d1 < 0) or (d2 < 0) or (d3 < 0)) and ((d1 > 0) or (d2 > 0) or (d3 > 0))):
                    self._px(x, y, colour)

    def disc(self, cx, cy, r, fill, border):
        x_lo, x_hi = max(0, int((cx - r) * self.w)), min(self.w, int((cx + r) * self.w) + 1)
        y_lo, y_hi = max(0, int((cy - r) * self.w)), min(self.w, int((cy + r) * self.w) + 1)
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


def draw(canvas, pad, spec):
    canvas.fill_all(FRAME)

    border = spec.get('border', 0.05)
    inner = 1 - 2 * (pad + border)
    # Letterbox the field at the board's own aspect, centred.
    fw = inner
    fh = inner / spec['aspect']
    if fh > inner:
        fh, fw = inner, inner * spec['aspect']
    fx0 = (1 - fw) / 2
    fy0 = (1 - fh) / 2

    def fx(u):
        return fx0 + u * fw

    def fy(v):
        return fy0 + v * fh

    canvas.rect(fx(0), fy(0), fx(1), fy(1), FIELD)

    columns, point_w = slots(spec)
    r_u = spec['checker'] * point_w / 2          # checker radius in field-u units
    step_v = 2 * r_u * (1 + GAP) * spec['aspect']  # vertical step in field-v units
    tip = spec['tip']

    for kind, x0, x1 in columns:
        if kind in ('bar', 'tray'):
            canvas.rect(fx(x0), fy(0), fx(x1), fy(1), EDGE)

    for row, key in (('top', 'top'), ('bottom', 'bottom')):
        for (kind, x0, x1), number in zip(columns, spec[key]):
            if kind in ('bar', 'tray'):
                continue
            mid = (x0 + x1) / 2
            colour = POINT_EVEN if number % 2 == 0 else POINT_ODD
            if row == 'top':
                canvas.triangle(fx(x0), fy(0), fx(x1), fy(0), fx(mid), fy(tip), colour)
            else:
                canvas.triangle(fx(x0), fy(1), fx(x1), fy(1), fx(mid), fy(1 - tip), colour)

            if number not in OPENING:
                continue
            name, count = OPENING[number]
            fill = WHITE if name == 'white' else BLACK
            edge = WHITE_EDGE if name == 'white' else BLACK_EDGE
            half = r_u * spec['aspect']
            for k in range(count):
                v = (MARGIN + half + k * step_v) if row == 'top' else (1 - MARGIN - half - k * step_v)
                canvas.disc(fx(mid), fy(v), r_u * fw, fill, edge)


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))


def write_png(path, size, pad, supersample, spec):
    canvas = Canvas(size, supersample)
    draw(canvas, pad, spec)
    raw = canvas.downsample()
    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header)
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


if __name__ == '__main__':
    out = sys.argv[1].rstrip('/')
    layout = sys.argv[2] if len(sys.argv) > 2 else LAYOUT
    spec = LAYOUTS[layout]
    print(f'layout: {layout}')
    write_png(f'{out}/icon-180.png', 180, 0.02, 4, spec)
    write_png(f'{out}/icon-192.png', 192, 0.02, 4, spec)
    write_png(f'{out}/icon-512.png', 512, 0.02, 3, spec)
    # Maskable: the spec's safe zone is the middle 80%, so the board is inset
    # far enough that a circular mask clips only frame.
    write_png(f'{out}/icon-512-maskable.png', 512, 0.13, 3, spec)
