"""Generate NSIS installer banner/sidebar images from the icon master."""
from pathlib import Path

from PIL import Image

ICONS = Path(__file__).resolve().parents[1] / 'src-tauri' / 'icons'
MASTER = ICONS / 'icon-master.png'
HEADER_OUT = ICONS / 'nsis-header.bmp'
SIDEBAR_OUT = ICONS / 'nsis-sidebar.bmp'

# gradient sampled from the master icon: top-left navy -> bottom-right teal
TL = (52, 72, 102)
BR = (30, 77, 72)


def gradient(w, h):
    base = Image.new('RGB', (w, h))
    px = base.load()
    for y in range(h):
        for x in range(w):
            t = (x / max(w - 1, 1) * 0.45 + y / max(h - 1, 1) * 0.55)
            px[x, y] = tuple(round(TL[i] + (BR[i] - TL[i]) * t) for i in range(3))
    return base


master = Image.open(MASTER).convert('RGBA')

# header: 150x57, badge on the left
header = gradient(150, 57)
badge = master.resize((49, 49), Image.LANCZOS)
header.paste(badge, (4, 4), badge)
header.save(HEADER_OUT)

# sidebar: 164x314, badge centered
sidebar = gradient(164, 314)
badge = master.resize((120, 120), Image.LANCZOS)
sidebar.paste(badge, ((164 - 120) // 2, (314 - 120) // 2), badge)
sidebar.save(SIDEBAR_OUT)

print('saved', HEADER_OUT, 'and', SIDEBAR_OUT)
