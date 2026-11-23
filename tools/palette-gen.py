#!/usr/bin/env python3
"""Noble Made palette for The Catch (2026-11-23). Copied from The Forge's tools/palette-gen.py so both
apps get their light colours from the same rule. Builds palette.css and swaps app.css's hex colours for
var(--h-XXXXXX) so each colour can have a dark value (the colour as written, unchanged) and a light
value (Noble Made cream / coal / burgundy). Run from the repo root:
    python3 tools/palette-gen.py          # rewrite files + palette.css
    python3 tools/palette-gen.py --check  # list what would change, write nothing
Re-running is safe: colours already swapped are left alone, new literals get swapped.
Not touched: app.css's :root block (those ARE the dark values), app.js, SVG attributes, 8-digit hex."""
import re, sys, math, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKENS = 'app.css'   # its :root block holds The Catch's colour tokens
FILES = [ROOT / 'app.css']   # nm.css is hand-set: its colours are the fixed brand ones
HEX = re.compile(r'(?<![\w&%-])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F\w])')
SKIP_LINE = re.compile(r'<meta\b|theme-color', re.I)
SVG_ATTR = re.compile(r'\b(fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*"$', re.I)


def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def dlin(c):
    c = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return max(0, min(255, round(c * 255)))


def to_oklch(h):
    r, g, b = (lin(int(h[i:i + 2], 16)) for i in (0, 2, 4))
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (x ** (1 / 3) for x in (l, m, s))
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(A, B), math.degrees(math.atan2(B, A)) % 360


def from_oklch(L, C, H):
    for _ in range(40):  # pull chroma in until it fits sRGB
        A = C * math.cos(math.radians(H)); B = C * math.sin(math.radians(H))
        l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
        m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
        s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3
        r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
        g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
        b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
        if min(r, g, b) >= -0.0005 and max(r, g, b) <= 1.0005:
            break
        C *= 0.92
    return '#%02X%02X%02X' % (dlin(r), dlin(g), dlin(b))


def lerp(a, b, t):
    return a + (b - a) * max(0, min(1, t))


WARM = 78  # Noble Made canvas hue


def light(h):
    """The colour's role in the dark boards decides its light value: dark surfaces become cream paper
    (cards stay a step lighter than the page, as in dark), borders become hairlines, light text becomes
    coal, and status/brand colours keep their hue at a lightness that reads on cream."""
    L, C, H = to_oklch(h)
    if C < 0.04:  # neutrals
        if L < 0.25:  # page / cards / inputs
            return from_oklch(lerp(0.935, 0.975, (L - 0.12) / 0.13), 0.03 if L < 0.15 else 0.02, WARM)
        if L < 0.45:  # borders, dividers
            return from_oklch(lerp(0.88, 0.74, (L - 0.25) / 0.2), 0.022, WARM)
        if L < 0.6:   # ghost text, dim lines
            return from_oklch(lerp(0.66, 0.56, (L - 0.45) / 0.15), 0.018, WARM)
        return from_oklch(lerp(0.53, 0.24, (L - 0.6) / 0.36), 0.012 if L > 0.85 else 0.016, WARM)  # text -> coal
    if L < 0.33:  # tinted chip / banner backgrounds
        return from_oklch(lerp(0.955, 0.9, (L - 0.1) / 0.23), min(C * 0.55, 0.05), H)
    if L < 0.5:   # tinted borders
        return from_oklch(lerp(0.8, 0.7, (L - 0.33) / 0.17), min(C * 0.8, 0.09), H)
    if L < 0.72:
        return from_oklch(min(L, 0.5), max(C, 0.06), H)  # status / accent fills and text
    return from_oklch(lerp(0.5, 0.44, (L - 0.72) / 0.2), max(C * 1.6, 0.09), H)  # pale status text -> its strong ink


def norm(h):
    h = h.upper()
    return h if len(h) == 6 else ''.join(c * 2 for c in h)


def swap(text, seen):
    out = []; pos = 0
    for m in HEX.finditer(text):
        ls = text.rfind('\n', 0, m.start()) + 1
        le = text.find('\n', m.end()); le = len(text) if le < 0 else le
        if SKIP_LINE.search(text[ls:le]) or SVG_ATTR.search(text[max(ls, m.start() - 20):m.start()]):
            continue
        h = norm(m.group(1)); seen.add(h)
        out.append(text[pos:m.start()]); out.append('var(--h-%s)' % h); pos = m.end()
    out.append(text[pos:])
    return ''.join(out)


def tokens_light(t):
    """tokens.css's own custom properties get light values the same way."""
    root = re.search(r':root\s*\{([\s\S]*?)\n\}', t).group(1)
    return {k: light(norm(v)) for k, v in re.findall(r'(--[\w-]+):\s*#([0-9a-fA-F]{6})\b', root) if not k.startswith('--brand-')}  # brand colours never change


def main():
    check = '--check' in sys.argv; seen = set(); changed = []
    tok = (ROOT / TOKENS).read_text(encoding='utf-8'); tl = tokens_light(tok)
    for f in FILES:
        if not f.exists():
            continue
        t = f.read_bytes().decode('utf-8')
        if f.name == TOKENS:  # the :root definitions stay literal: they ARE the dark values
            head, sep, rest = t.partition('\n}\n'); n = head + sep + swap(rest, seen)
        else:
            n = swap(t, seen)
        if n != t:
            changed.append(f.name)
            if not check:
                f.write_bytes(n.encode('utf-8'))
    pal = ROOT / 'palette.css'
    if pal.exists():  # keep every colour already listed, so a re-run never drops one
        seen |= set(re.findall(r'--h-([0-9A-F]{6}):', pal.read_text(encoding='utf-8')))
    cols = sorted(seen)
    css = ['/* GENERATED by tools/palette-gen.py -- do not hand-edit; change light() there and re-run.',
           ' * Every colour in app.css is var(--h-XXXXXX). Dark = the colour as written; light = the same rule',
           ' * as The Forge (Noble Made: cream paper, coal ink, burgundy and gold). */',
           ':root {'] + ['  --h-%s: #%s;' % (c, c) for c in cols] + ['}', 'html[data-theme="light"] {'] + \
          ['  --h-%s: %s;' % (c, light(c)) for c in cols] + ['  %s: %s;' % kv for kv in tl.items()] + ['}', '']
    if not check:
        pal.write_text('\n'.join(css), encoding='utf-8')
    print(('would change: ' if check else 'changed: ') + ', '.join(changed)); print(len(cols), 'colours')


if __name__ == '__main__':
    main()
