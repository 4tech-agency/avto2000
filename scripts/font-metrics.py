import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
SAMPLE = "Used cars we'd buy ourselves. Every car on our forecourt has a known history, a full inspection and a clear price 2021 68,400 km"
def width(font):
    cmap = font.getBestCmap(); hmtx = font["hmtx"]; upm = font["head"].unitsPerEm
    return sum(hmtx[cmap[ord(c)]][0] for c in SAMPLE if ord(c) in cmap) / upm
arch = sys.argv[1]
out = {}
for w, arial in ((400, "/System/Library/Fonts/Supplemental/Arial.ttf"), (800, "/System/Library/Fonts/Supplemental/Arial Bold.ttf")):
    a = instantiateVariableFont(TTFont(arch), {"wght": w, "wdth": 100})
    r = TTFont(arial)
    sa = width(a) / width(r)
    hh = a["hhea"]; upm = a["head"].unitsPerEm
    out[w] = dict(size_adjust=round(sa * 100, 2),
                  ascent=round(hh.ascent / upm / sa * 100, 2),
                  descent=round(abs(hh.descent) / upm / sa * 100, 2),
                  line_gap=round(hh.lineGap / upm / sa * 100, 2))
print(out)
