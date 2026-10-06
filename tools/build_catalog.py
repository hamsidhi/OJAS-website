"""Builds data/catalog.json and public/products/*.jpg from the supplier PDF.
Usage: python tools/build_catalog.py "path/to/catalogue.pdf"
Requires: pymupdf pillow"""
import sys, json, os, io
import pymupdf
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from catalog_source import P

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pdf = sys.argv[1]
sw = json.load(open(os.path.join(root, 'tools', 'swatches.json')))
d = pymupdf.open(pdf)
os.makedirs(os.path.join(root, 'data'), exist_ok=True)
CROPS = [(0.024, 0.081, 0.401, 0.918, 900), (0.4125, 0.081, 0.640, 0.490, 620), (0.4125, 0.507, 0.640, 0.918, 620)]
cat = []
for page, code, name, category, comp, extras, sizes, colors, price, mrp, blurb in P:
    hexes = sw[str(page)]
    assert len(hexes) == len(colors), (code, len(hexes), len(colors))
    xr = d[page - 1].get_images(full=True)[0][0]
    im = Image.open(io.BytesIO(d.extract_image(xr)['image'])).convert('RGB')
    W, H = im.size
    outdir = os.path.join(root, 'public', 'products', code.lower())
    os.makedirs(outdir, exist_ok=True)
    imgs = []
    for n, (x0, y0, x1, y1, mw) in enumerate(CROPS, 1):
        c = im.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)))
        if c.width > mw:
            c = c.resize((mw, round(c.height * mw / c.width)), Image.LANCZOS)
        c.save(os.path.join(outdir, f'{n}.jpg'), quality=82, optimize=True, progressive=True)
        imgs.append(f'/products/{code.lower()}/{n}.jpg')
    cat.append(dict(page=page, code=code, slug=code.lower(), name=name, category=category, composition=comp,
                    extras=[list(e) for e in extras], sizes=sizes,
                    colors=[dict(name=n, hex=h) for n, h in zip(colors, hexes)],
                    price=price, mrp=mrp, description=blurb, images=imgs))
json.dump(cat, open(os.path.join(root, 'data', 'catalog.json'), 'w'), indent=1)
print(len(cat), 'products written')
