#!/usr/bin/env python3
"""Generates every original PHANTOM asset (SVG art, PNG icons/noise, WAV audio).
Run:  python3 tools/make_assets.py      (needs Pillow + numpy; only for regenerating)"""
import math, random, wave, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
IMG, AUD = os.path.join(ROOT, "images"), os.path.join(ROOT, "audio")
os.makedirs(IMG, exist_ok=True); os.makedirs(AUD, exist_ok=True)
PALE, RED = "#e9e7d8", "#7a1212"

# ---------------------------------------------------------------- The Watcher
# Head-local coordinates: ellipse centred on (0,0), rx=100, ry=140.
# eyes = (x, y, rx, ry, rotation)
VARIANTS = [
    dict(eyes=[(-32,-35,11,6,8),(32,-35,11,6,-8)],                               mouth=("line",0,60),  teeth=16, tilt=-4,  arm="down",    neck=0),
    dict(eyes=[(-34,-38,10,6,10),(34,-38,10,6,-10),(0,-72,6,4,0)],                mouth=("grin",26,76), teeth=24, tilt=7,   arm="raised",  neck=10),
    dict(eyes=[(-30,-30,17,11,0),(30,-30,17,11,0)],                               mouth=("void",0,26),  teeth=14, tilt=0,   arm="out",     neck=0),
    dict(eyes=[(-34,-50,9,5,6),(34,-50,9,5,-6),(-28,-20,7,4,-6),(28,-20,7,4,6)],  mouth=None,           teeth=0,  tilt=-9,  arm="down",    neck=26),
    dict(eyes=[(-38,-34,8,5,12),(30,-40,16,10,-6)],                               mouth=("grin",34,86), teeth=32, tilt=12,  arm="raised2", neck=6),
]


def features(p, seed):
    rnd = random.Random(seed)
    o = []
    for (x, y, rx, ry, rot) in p["eyes"]:
        o.append(f'<g transform="translate({x} {y}) rotate({rot})" filter="url(#g)">'
                 f'<ellipse rx="{rx}" ry="{ry}" fill="{PALE}"/>'
                 f'<ellipse cx="{rnd.uniform(-1.5,1.5):.1f}" cy="1" rx="{rx*0.16:.1f}" ry="{ry*0.5:.1f}" fill="#000"/></g>')
    m = p["mouth"]
    if m:
        kind, c, w = m
        y0 = 58
        if kind == "void":
            r = w
            o.append(f'<ellipse cx="0" cy="{y0}" rx="{r}" ry="{r*1.35:.1f}" fill="#000" stroke="{PALE}" stroke-width="1.6"/>')
            for i in range(p["teeth"]):
                a = 2*math.pi*i/p["teeth"]
                x1, y1 = math.cos(a)*r, y0+math.sin(a)*r*1.35
                x2, y2 = math.cos(a)*(r-7), y0+math.sin(a)*(r*1.35-9)
                o.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{PALE}" stroke-width="1.5"/>')
        else:
            x0, x1 = -w/2, w/2
            o.append(f'<path d="M{x0} {y0} Q0 {y0+2*c} {x1} {y0}" fill="none" stroke="{PALE}" stroke-width="1.8" stroke-linecap="round"/>')
            n = p["teeth"]
            for i in range(n+1):
                t = i/n
                px = (1-t)**2*x0 + t*t*x1
                py = (1-t)**2*y0 + 2*(1-t)*t*(y0+2*c) + t*t*y0
                hu, hd = rnd.uniform(2, 6), rnd.uniform(3, 9)
                o.append(f'<line x1="{px:.1f}" y1="{py-hu:.1f}" x2="{px:.1f}" y2="{py+hd:.1f}" stroke="{PALE}" stroke-width="1.1" opacity=".9"/>')
    return "".join(o)


DEFS = f'''<defs>
<radialGradient id="h" cx=".35" cy=".3" r=".95"><stop offset="0" stop-color="#2b2b2b"/><stop offset=".55" stop-color="#0b0b0b"/><stop offset="1" stop-color="#000"/></radialGradient>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121212"/><stop offset="1" stop-color="#000"/></linearGradient>
<filter id="g" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="r" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter>
</defs>'''

ARMS = {
    "down":    ["M152 345 C112 450 96 570 102 705", "M248 345 C288 450 304 570 298 705"],
    "raised":  ["M152 345 C112 450 96 570 102 705", "M248 345 C310 330 334 250 322 170"],
    "out":     ["M152 345 C100 400 62 470 44 560",  "M248 345 C300 400 338 470 356 560"],
    "raised2": ["M152 345 C90 330 66 250 78 170",   "M248 345 C288 450 304 570 298 705"],
}


def fingers(path):
    nums = [float(v) for v in path.replace("M", " ").replace("C", " ").replace(",", " ").split()]
    ex, ey = nums[-2], nums[-1]
    out = []
    for dx in (-9, -3, 3, 9):
        out.append(f'<line x1="{ex}" y1="{ey}" x2="{ex+dx*1.6:.1f}" y2="{ey+(-28 if ey<300 else 30)}" stroke="#000" stroke-width="2.2" stroke-linecap="round"/>')
    return "".join(out)


def figure(i, p):
    arms = "".join(f'<path d="{a}" fill="none" stroke="#000" stroke-width="15" stroke-linecap="round"/>'
                   f'<path d="{a}" fill="none" stroke="{RED}" stroke-width="2" opacity=".35" filter="url(#r)"/>{fingers(a)}'
                   for a in ARMS[p["arm"]])
    cy = 230 - p["neck"]
    body = 'M150 310 C140 380 120 520 92 800 L308 800 C280 520 260 380 250 310 Z'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 800">{DEFS}
<path d="{body}" fill="none" stroke="{RED}" stroke-width="5" opacity=".45" filter="url(#r)"/>
<path d="{body}" fill="url(#b)"/>{arms}
<path d="M176 {cy+110} L224 {cy+110} L228 345 L172 345 Z" fill="#050505"/>
<g transform="rotate({p["tilt"]} 200 300)">
<g transform="translate(200 {cy}) scale(.62)">
<ellipse rx="100" ry="140" fill="none" stroke="{RED}" stroke-width="6" opacity=".5" filter="url(#r)"/>
<ellipse rx="100" ry="140" fill="url(#h)"/>
{features(p, 100+i)}
</g></g></svg>'''


def face(i, p):
    bars = "".join(
        f'<rect x="0" y="{random.Random(i*9+k).randint(40,760)}" width="800" height="{random.Random(i*5+k).randint(2,7)}" fill="#fff" opacity=".05"/>'
        for k in range(9))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">{DEFS}
<defs><radialGradient id="bg" cx=".5" cy=".45" r=".75"><stop offset="0" stop-color="#2a0606"/><stop offset=".55" stop-color="#0a0101"/><stop offset="1" stop-color="#000"/></radialGradient>
<filter id="w" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".012" numOctaves="2" seed="{i+3}"/><feDisplacementMap in="SourceGraphic" scale="14"/></filter></defs>
<rect width="800" height="800" fill="url(#bg)"/>
<g transform="rotate({p["tilt"]*0.8:.1f} 400 420)" filter="url(#w)">
<g transform="translate(400 410) scale(2.55)">
<ellipse rx="104" ry="144" fill="none" stroke="{RED}" stroke-width="10" opacity=".6" filter="url(#r)"/>
<ellipse rx="100" ry="140" fill="url(#h)"/>
{features(p, 500+i)}
</g></g>{bars}
<rect width="800" height="800" fill="none" stroke="#000" stroke-width="40" opacity=".5"/></svg>'''


for i, p in enumerate(VARIANTS, 1):
    open(f"{IMG}/watcher-{i}.svg", "w").write(figure(i, p))
    open(f"{IMG}/watcher-face-{i}.svg", "w").write(face(i, p))

# ---------------------------------------------------------------- logo + icons
LOGO_P = dict(eyes=[(-30,-22,13,8,8),(30,-22,13,8,-8)], mouth=None, teeth=0, tilt=0, arm="down", neck=0)
open(f"{IMG}/logo.svg", "w").write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">{DEFS}
<defs><radialGradient id="lg" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#3a0808"/><stop offset="1" stop-color="#050505"/></radialGradient></defs>
<rect width="128" height="128" rx="26" fill="url(#lg)"/>
<g transform="translate(64 66) scale(.6)"><ellipse rx="100" ry="140" fill="none" stroke="{RED}" stroke-width="8" opacity=".7" filter="url(#r)"/><ellipse rx="100" ry="140" fill="url(#h)"/>{features(LOGO_P, 7)}</g></svg>''')


def icon(size):
    S = 512
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, S-1, S-1), radius=110, fill=(8, 4, 4, 255))
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0)); gd = ImageDraw.Draw(glow)
    gd.ellipse((96, 40, 416, 480), outline=(150, 20, 20, 200), width=26)
    glow = glow.filter(ImageFilter.GaussianBlur(22)); im.alpha_composite(glow)
    d = ImageDraw.Draw(im)
    d.ellipse((126, 72, 386, 456), fill=(10, 10, 10, 255))
    eg = Image.new("RGBA", (S, S), (0, 0, 0, 0)); ed = ImageDraw.Draw(eg)
    for cx in (196, 316):
        ed.ellipse((cx-44, 214, cx+44, 262), fill=(233, 231, 216, 255))
    im.alpha_composite(eg.filter(ImageFilter.GaussianBlur(10))); im.alpha_composite(eg)
    d = ImageDraw.Draw(im)
    for cx in (196, 316):
        d.ellipse((cx-6, 224, cx+6, 252), fill=(0, 0, 0, 255))
    im.resize((size, size), Image.LANCZOS).save(f"{IMG}/icon{size}.png")


for s in (16, 32, 48, 128):
    icon(s)

# grain tile for popup/overlays (local file: page CSP can't block it, unlike data: URLs)
rng = np.random.default_rng(7)
g = rng.normal(128, 55, (160, 160)).clip(0, 255).astype("uint8")
Image.fromarray(g, "L").convert("RGBA").save(f"{IMG}/noise.png")

# ---------------------------------------------------------------- audio (22.05 kHz mono 16-bit)
SR = 22050


def save(name, x):
    x = x / max(1e-9, np.max(np.abs(x))) * 0.9
    with wave.open(f"{AUD}/{name}.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def t_(sec):
    return np.linspace(0, sec, int(SR*sec), endpoint=False)


def lowpass(x, a):
    y = np.zeros_like(x); s = 0.0
    for i, v in enumerate(x):
        s += a*(v-s); y[i] = s
    return y


# scare: impact burst + descending shriek + sub thump
t = t_(1.3); n = rng.normal(0, 1, t.size)
burst = n * np.exp(-t*7)
f = 2100*np.exp(-t*1.1) + 380; ph = 2*np.pi*np.cumsum(f)/SR
shriek = (np.sin(ph) + .5*np.sin(2*ph) + .3*np.sin(3.01*ph)) * (1 + .35*np.sin(2*np.pi*31*t)) * np.minimum(1, t*40) * np.exp(-t*1.9)
sub = np.sin(2*np.pi*48*t) * np.exp(-t*5)
save("scare", burst*.8 + shriek*.7 + sub*1.2)

# heartbeat: lub-dub x2
t = t_(1.9); y = np.zeros_like(t)
for start, amp in ((0.0, 1), (0.30, .7), (0.95, 1), (1.25, .7)):
    m = t >= start; tt = t[m]-start
    y[m] += amp*np.sin(2*np.pi*(52-18*np.minimum(tt, .2))*tt)*np.exp(-tt*16)
save("heartbeat", y)

# static: crackling filtered noise with fades
t = t_(1.2); n = lowpass(rng.normal(0, 1, t.size), .35)
crackle = (rng.random(t.size) > .985) * rng.normal(0, 3, t.size)
env = np.minimum(1, t*12) * np.minimum(1, (1.2-t)*12) * (.6 + .4*np.sin(2*np.pi*9*t)**2)
save("static", (n + crackle) * env)
print("assets ok")
