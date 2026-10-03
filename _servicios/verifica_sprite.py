"""Compara, pixel a pixel, como dibuja el cliente web contra como lo dibuja el
cliente Windows.

El cliente Windows no acepta teclado ni raton sintetico (SetCursorPos falla y
GetAsyncKeyState nunca ve la tecla), pero si se puede CAPTURAR su ventana, y el
dibuja tambien a los demas jugadores. Asi que se usa de oraculo: movemos
nuestro personaje desde el cliente web, capturamos la ventana del de Windows y
medimos si la imagen coincide.

Uso:  python verifica_sprite.py captura.png <dir 0..3> <sprite> <pic0,pic1,...>
      python verifica_sprite.py oraculo_arriba.png 0 9 176,171,18
"""
import sys, os
import numpy as np
from PIL import Image

TS = 32
UMBRAL = 40
RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_web', 'assets')
CUERPOS = Image.open(os.path.join(RAIZ, 'sprites.webp')).convert('RGBA')
ITEMS = Image.open(os.path.join(RAIZ, 'items.webp')).convert('RGBA')

# Reglas del cliente web, tal y como quedan en sprite.js
REPOSO_POR_DIR = [1, 0, 1, 0]      # arriba, abajo, izquierda, derecha
ORDEN = [0, 4, 2, 5, 6, 3, 1]      # armadura, botas, casco, amuleto, hada, escudo, arma
ORDEN_ESPALDAS = [1, 3, 0, 4, 2, 5, 6]   # de espaldas, arma y escudo van detras del cuerpo


def cel(hoja, fila, col):
    y, x = fila * TS, col * TS
    if y + TS > hoja.height or x + TS > hoja.width:
        return None
    return hoja.crop((x, y, x + TS, y + TS))


def rotulos(im, caja=(287, 48, 925, 522)):
    px = im.load()
    pts = [(x, y) for y in range(caja[1], caja[3]) for x in range(caja[0], caja[2])
           if px[x, y][0] > 190 and px[x, y][2] > 190 and px[x, y][1] < 110]
    grupos, usados = [], set()
    for p in pts:
        if p in usados:
            continue
        pila, g = [p], []
        usados.add(p)
        while pila:
            cx, cy = pila.pop()
            g.append((cx, cy))
            for q in pts:
                if q not in usados and abs(q[0] - cx) <= 6 and abs(q[1] - cy) <= 4:
                    usados.add(q); pila.append(q)
        xs, ys = [q[0] for q in g], [q[1] for q in g]
        grupos.append((min(xs), min(ys), max(xs), max(ys)))
    grupos.sort(key=lambda g: g[2] - g[0], reverse=True)
    return grupos


DETRAS_ARRIBA = [1, 3]             # de espaldas el arma y el escudo van al otro lado


def compone(sprite, direccion, puesto):
    """Reproduce exactamente lo que pinta sprite.js para un personaje quieto."""
    f = direccion * 3 + REPOSO_POR_DIR[direccion]
    im = Image.new('RGBA', (TS, TS), (0, 0, 0, 0))
    orden = ORDEN_ESPALDAS if direccion == 0 else ORDEN
    detras = DETRAS_ARRIBA if direccion == 0 else []

    def pinta(ranura):
        pic = puesto[ranura] if ranura < len(puesto) else 0
        if not pic:
            return
        c = cel(ITEMS, pic, f)          # el objeto va en el MISMO fotograma
        if c is not None:
            im.alpha_composite(c)

    for ranura in orden:
        if ranura in detras:
            pinta(ranura)
    im.alpha_composite(cel(CUERPOS, sprite, f))
    for ranura in orden:
        if ranura not in detras:
            pinta(ranura)
    return im


def verifica(ruta, direccion, sprite, puesto, cual=0):
    full = Image.open(ruta).convert('RGB')
    gs = rotulos(full)
    if not gs:
        raise SystemExit('no encuentro ningun nombre en la captura')
    g = gs[min(cual, len(gs) - 1)]
    cx, top = (g[0] + g[2]) // 2, g[3]
    mio = compone(sprite, direccion, puesto)
    m = np.array(mio); a = m[:, :, 3] > 0
    mejor = None
    for dy in range(-2, 12):
        for dx in range(-5, 6):
            x0, y0 = cx - TS // 2 + dx, top + dy
            reg = np.array(full.crop((x0, y0, x0 + TS, y0 + TS)), dtype=int)
            d = np.abs(reg - m[:, :, :3].astype(int)).sum(axis=2)
            malos = int(((d > UMBRAL) & a).sum())
            if mejor is None or malos < mejor[0]:
                mejor = (malos, dx, dy)
    malos, dx, dy = mejor
    tot = int(a.sum())
    veredicto = 'IDENTICO' if malos == 0 else f'{malos*100//tot}% distinto'
    print(f'dir={direccion} sprite={sprite} puesto={puesto} -> {malos}/{tot} px  [{veredicto}]  (encaje dx={dx} dy={dy})')
    return malos, tot


if __name__ == '__main__':
    ruta = sys.argv[1]
    direccion = int(sys.argv[2])
    sprite = int(sys.argv[3])
    puesto = [int(v) for v in sys.argv[4].split(',')]
    cual = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    verifica(ruta, direccion, sprite, puesto, cual)
