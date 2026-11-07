#!/usr/bin/env python3
"""Generates theme-light.css: overrides that turn the dark-theme colours of style.css (and the colours written inline in
index.html / app.js) into the NTPC light palette. Re-run after changing colours:  python3 tools/make_light_theme.py"""
import re, colorsys, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
css = open(os.path.join(ROOT, 'style.css')).read()
css = css.split('/* ==========================================================================\n   NTPC LOGIN PAGE')[0]   # only the original rules
NAMED = {'white': (255,255,255,1), 'black': (0,0,0,1), 'transparent': None}
COL = re.compile(r'#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)|\b(?:white|black)\b')
def parse(tok):
    t = tok.lower()
    if t in NAMED: return NAMED[t]
    if t.startswith('#'):
        h = t[1:]
        if len(h) == 3: h = ''.join(c*2 for c in h)
        r, g, b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16); a = int(h[6:8],16)/255 if len(h) == 8 else 1
        return (r,g,b,a)
    n = [float(x) for x in re.findall(r'[\d.]+', t)]
    return (n[0], n[1], n[2], n[3] if len(n) > 3 else 1)
def lum(r,g,b):
    f = lambda v: (v/255/12.92) if v/255 <= .03928 else ((v/255+.055)/1.055)**2.4
    return .2126*f(r)+.7152*f(g)+.0722*f(b)
def sat(r,g,b):
    h, l, s = colorsys.rgb_to_hls(r/255, g/255, b/255); return s
NAVY = (15,42,67); MUTED = (84,101,121)
def fmt(c, a=None):
    r,g,b = [int(round(x)) for x in c[:3]]; a = c[3] if a is None else a
    return '#%02x%02x%02x' % (r,g,b) if a >= .995 else 'rgba(%d,%d,%d,%.2f)' % (r,g,b,a)
def text_map(col):
    r,g,b,a = col
    L = lum(r,g,b)
    if L < .30: return None                      # already dark enough on white
    if sat(r,g,b) < .18:                         # neutral light text -> navy / muted
        return fmt(NAVY if L > .55 else MUTED, a)
    h, l, s = colorsys.rgb_to_hls(r/255, g/255, b/255)   # accent: same hue, much darker
    rr, gg, bb = colorsys.hls_to_rgb(h, .26, min(1, s*1.05))
    return fmt((rr*255, gg*255, bb*255), a)
def bg_map(col):
    r,g,b,a = col
    if a < .02: return None
    L = lum(r,g,b)
    if L < .22 and sat(r,g,b) < .7:             # dark neutral / navy panel -> white (translucent ones -> faint navy tint)
        return '#ffffff' if a >= .5 else fmt(NAVY, min(.08, a*.35))
    if L > .75 and a < .5:                       # white glass overlay -> faint navy tint
        return fmt(NAVY, min(.08, a*.8))
    return None
def border_map(col):
    r,g,b,a = col
    if lum(r,g,b) > .6 and a < .6: return fmt(NAVY, min(.4, a*2.2+.04))
    if lum(r,g,b) < .12 and a < .6: return None
    return None
def subst(value, fn):
    changed = [False]
    def rep(m):
        c = parse(m.group(0))
        if c is None: return m.group(0)
        o = fn(c)
        if o: changed[0] = True; return o
        return m.group(0)
    return COL.sub(rep, value), changed[0]
def rules(text):
    out, i, n = [], 0, len(text)
    stack = []
    buf = ''
    while i < n:
        ch = text[i]
        if text.startswith('/*', i):
            j = text.find('*/', i+2); i = j+2 if j >= 0 else n; continue
        if ch == '{':
            sel = buf.strip(); buf = ''
            if sel.startswith('@'):
                stack.append(sel)
                i += 1; continue
            j = text.find('}', i)
            out.append((tuple(stack), sel, text[i+1:j])); i = j+1; continue
        if ch == '}':
            if stack: stack.pop()
            buf = ''; i += 1; continue
        buf += ch; i += 1
    return out
SKIP_AT = ('@keyframes', '@font-face', '@page', '@-webkit-keyframes', '@import')
generated = []
for at, sel, body in rules(css):
    if any(a.startswith(SKIP_AT) or 'print' in a for a in at): continue
    if '[data-theme' in sel or sel.startswith('@') or ':root' == sel.strip(): continue
    decls = [d for d in body.split(';') if ':' in d]
    props = {d.split(':',1)[0].strip().lower(): d.split(':',1)[1].strip() for d in decls}
    sat_bg = bool(re.search(r'btn|badge|pill|chip|toast|banner|active|status|stage|tag\b|alert|avatar|logo|dot|knob|spinner|primary|danger|success|warn|accent|switch|progress|bar\b', sel)) or any('var(' in props.get(k, '') or 'gradient' in props.get(k, '') for k in ('background', 'background-color'))
    for k in ('background', 'background-color'):
        if k in props:
            for m in COL.findall(props[k]):
                c = parse(m)
                if c and c[3] > .5 and sat(*c[:3]) > .35 and .06 < lum(*c[:3]) < .7: sat_bg = True
    new = []
    for k, v in props.items():
        imp = ' !important' if '!important' in v else ''
        v = v.replace('!important', '').strip()
        if k == 'color':
            if sat_bg and re.fullmatch(r'#fff(fff)?|white', v.lower()): continue
            nv, ch = subst(v, text_map)
            if ch: new.append('color: %s%s' % (nv, imp))
        elif k in ('background', 'background-color'):
            if 'url(' in v: continue
            nv, ch = subst(v, bg_map)
            if ch: new.append('%s: %s%s' % (k, nv, imp))
        elif k.startswith('border') or k == 'outline':
            nv, ch = subst(v, border_map)
            if ch: new.append('%s: %s%s' % (k, nv, imp))
        elif k == 'box-shadow':
            pass
    if not new: continue
    sels = []
    for s in sel.split(','):
        s = s.strip()
        if not s or s.startswith('@') or s in ('*', 'html'): continue
        if s.startswith('body') or s.startswith('html'):
            s2 = ':root[data-theme="light"] ' + s.replace('html ', '', 1) if s.startswith('html ') else ':root[data-theme="light"] ' + s
        else:
            s2 = ':root[data-theme="light"] ' + s
        sels.append(s2)
    if not sels: continue
    rule = ',\n'.join(sels) + ' { ' + '; '.join(new) + '; }'
    for a in reversed(at): rule = a + ' {\n' + rule + '\n}'
    generated.append(rule)
# colours written inline (style="...") in index.html and app.js
inline_txt = {}; inline_bg = {}
src = open(os.path.join(ROOT, 'index.html')).read() + '\n' + open(os.path.join(ROOT, 'app.js')).read()
for m in re.finditer(r'style\s*=\s*(?:\\?"|\')([^"\'`]*?)(?:\\?"|\')', src):
    for d in m.group(1).split(';'):
        if ':' not in d: continue
        k, v = d.split(':', 1); k = k.strip().lower(); v = v.strip()
        if k == 'color' and COL.fullmatch(v):
            nv = None
            c = parse(v)
            if c and not re.fullmatch(r'#fff(fff)?|white', v.lower()): nv = text_map(c)
            if nv: inline_txt[v] = nv
        elif k in ('background', 'background-color') and 'url(' not in v and '${' not in v:
            nv, ch = subst(v, bg_map)
            if ch: inline_bg[v] = nv
inl = []
for v, nv in sorted(inline_txt.items()):
    for sp in ('color: %s', 'color:%s'):
        inl.append(':root[data-theme="light"] [style*="%s"]:not(.btn-primary):not([class*="badge"]) { color: %s !important; }' % (sp % v, nv))
for v, nv in sorted(inline_bg.items()):
    for kind in (('background',) if 'gradient' in v else ('background', 'background-color')):
        for sp in ('%s: %s', '%s:%s'):
            inl.append(':root[data-theme="light"] [style*="%s"] { %s: %s !important; }' % (sp % (kind, v), kind, nv))
header = '/* GENERATED by tools/make_light_theme.py - do not edit by hand.  Light (NTPC) theme overrides. */\n'
open(os.path.join(ROOT, 'theme-light.css'), 'w').write(header + '\n'.join(generated) + '\n\n/* inline colours */\n' + '\n'.join(inl) + '\n')
print('rules', len(generated), 'inline text', len(inline_txt), 'inline bg', len(inline_bg))
