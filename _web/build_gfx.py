"""Hojas del juego -> WebP sin perdida con transparencia.

El motor original (DirectDraw) usa color-key: el NEGRO puro es transparente.
Aqui se hornea como canal alfa. El cliente pinta el fondo del mapa de negro,
asi que los tiles de suelo negros se siguen viendo negros, igual que el original.

WebP sin perdida: mismos pixeles exactos, la mitad de bytes que PNG.

Uso:
  python build_gfx.py                       # ../_extracted/PNG
  python build_gfx.py "C:/ruta/cliente/GFX"   # las hojas de otra instalacion

Acepta PNG y BMP: el cliente de Dreaminze guarda sus hojas en BMP, asi que se
le puede apuntar directamente a su carpeta GFX.
"""
import os, glob, sys
from PIL import Image, ImageChops

AQUI = os.path.dirname(os.path.abspath(__file__))
ORIG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(AQUI), '_extracted', 'PNG')
SAL  = sys.argv[2] if len(sys.argv) > 2 else os.path.join(AQUI, 'assets')
UMBRAL = 1           # SOLO negro puro, como el color-key de DirectDraw.
                     # Con un umbral mayor se comian los contornos oscuros
                     # de los sprites y se veian transparentes.

os.makedirs(SAL, exist_ok=True)


def mascara_transparente(rgb):
    """Devuelve una mascara (255 = opaco) keando negro y magenta, sin bucles."""
    r, g, b = rgb.split()
    casi_negro = lambda c: c.point(lambda v: 255 if v < UMBRAL else 0)   # v == 0
    negro = ImageChops.multiply(ImageChops.multiply(casi_negro(r), casi_negro(g)), casi_negro(b))
    alto = lambda c: c.point(lambda v: 255 if v > 240 else 0)
    bajo = lambda c: c.point(lambda v: 255 if v < 20 else 0)
    magenta = ImageChops.multiply(ImageChops.multiply(alto(r), bajo(g)), alto(b))
    return ImageChops.invert(ImageChops.lighter(negro, magenta))


tot_a = tot_b = 0
# WebP no admite ningun lado de mas de 16383 px, y algunas hojas lo pasan: la
# de sprites del cliente de Dreaminze mide 384x20000. Esas se guardan en PNG,
# que no tiene ese limite; el cliente web prueba .webp y si no, .png.
LIMITE_WEBP = 16383

hojas = sorted(glob.glob(os.path.join(ORIG, '*.png')) +
                 glob.glob(os.path.join(ORIG, '*.bmp')))
for p in hojas:
    base = os.path.splitext(os.path.basename(p))[0].lower()
    rgb = Image.open(p).convert('RGB')
    im = rgb.copy(); im.putalpha(mascara_transparente(rgb))
    if max(im.size) > LIMITE_WEBP:
        nom = base + '.png'
        dest = os.path.join(SAL, nom)
        im.save(dest, 'PNG', optimize=True)
        # Si quedo un .webp viejo de otra pasada, el cliente lo preferiria.
        viejo_webp = os.path.join(SAL, base + '.webp')
        if os.path.exists(viejo_webp):
            os.remove(viejo_webp)
    else:
        nom = base + '.webp'
        dest = os.path.join(SAL, nom)
        im.save(dest, 'WEBP', lossless=True, quality=100, method=6)
    a, b2 = os.path.getsize(p), os.path.getsize(dest)
    tot_a += a; tot_b += b2
    print(f'  {nom:<16} {im.size[0]:>4}x{im.size[1]:<6} {a/1048576:>5.2f} -> {b2/1048576:>5.2f} MB')
print(f'\n  TOTAL {tot_a/1048576:.2f} MB -> {tot_b/1048576:.2f} MB  (sin perdida)')
