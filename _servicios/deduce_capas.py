"""Deduce, midiendo contra el cliente Windows, como compone este un personaje.

No se puede inyectar teclado ni raton en el cliente, pero si CAPTURAR su
ventana, y el cliente dibuja tambien a los demas jugadores. Asi que sirve de
oraculo: se le mira como pinta un personaje y se deduce de ahi el orden y los
graficos reales, en vez de adivinarlos.

Metodo:
  1. Se localiza al personaje por su nombre (magenta) y se busca el
     desplazamiento y el fotograma de CUERPO que mejor encajan.
  2. Con el cuerpo fijo, se prueba cada fila de la hoja de objetos sobre los
     pixeles que ESA fila aporta. La que encaja al 100% es la buena.
  3. Se repite anadiendo capas: el orden en que van cerrando el hueco es el
     orden de dibujo del cliente.

Uso:  python deduce_capas.py captura.png <indice del rotulo, 0=el mas ancho>
"""
import sys, os
import numpy as np
from PIL import Image

TS = 32
RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_web', 'assets')
CUERPOS = Image.open(os.path.join(RAIZ, 'sprites.webp')).convert('RGBA')
ITEMS = Image.open(os.path.join(RAIZ, 'items.webp')).convert('RGBA')
FILAS = ITEMS.height // TS
UMBRAL = 40           # diferencia de color a partir de la cual un pixel "no encaja"


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


def analiza(ruta, cual=0, sprite=9):
    full = Image.open(ruta).convert('RGB')
    gs = rotulos(full)
    if not gs:
        raise SystemExit('no encuentro ningun nombre en la captura')
    g = gs[min(cual, len(gs) - 1)]
    cx, top = (g[0] + g[2]) // 2, g[3]
    print(f'rotulo elegido {g}  (de {len(gs)} encontrados)')

    def region(dx, dy):
        x0, y0 = cx - TS // 2 + dx, top + dy
        return np.array(full.crop((x0, y0, x0 + TS, y0 + TS)), dtype=int)

    # 1. fotograma y encaje del cuerpo
    mejor = None
    for fb in range(12):
        c = cel(CUERPOS, sprite, fb)
        m = np.array(c); a = m[:, :, 3] > 0
        for dy in range(-4, 14):
            for dx in range(-8, 9):
                d = np.abs(region(dx, dy) - m[:, :, :3].astype(int)).sum(axis=2)
                malos = int(((d > UMBRAL) & a).sum())
                if mejor is None or malos < mejor[0]:
                    mejor = (malos, int(a.sum()), fb, dx, dy)
    malos, tot, FB, DX, DY = mejor
    print(f'cuerpo: fotograma {FB} en dx={DX} dy={DY}  ({malos}/{tot} px sin explicar)')
    reg = region(DX, DY)

    # 2. capas, de fuera hacia dentro
    acum = Image.new('RGBA', (TS, TS), (0, 0, 0, 0))
    acum.alpha_composite(cel(CUERPOS, sprite, FB))
    orden = []
    for paso in range(6):
        cubierto = np.array(acum)[:, :, 3] > 0
        cand = []
        for fila in range(FILAS):
            c = cel(ITEMS, fila, FB)
            if c is None:
                continue
            m = np.array(c); a = (m[:, :, 3] > 0) & (~cubierto)
            n = int(a.sum())
            if n < 25:
                continue
            d = np.abs(reg - m[:, :, :3].astype(int)).sum(axis=2)
            cand.append((int(((d > UMBRAL) & a).sum()) / n, fila, n))
        cand.sort()
        if not cand or cand[0][0] > 0.12:
            break
        r, fila, n = cand[0]
        orden.append(fila)
        acum.alpha_composite(cel(ITEMS, fila, FB))
        print(f'  capa {paso+1}: fila {fila:4d} aporta {n} px, encaje {100-r*100:.0f}%')
    print(f'orden de dibujo deducido: cuerpo(fot {FB}) y luego {orden}')
    print('(las filas salen de la mas tapada a la menos tapada: la ULTIMA es la que va mas al frente)')
    return FB, DX, DY, orden


if __name__ == '__main__':
    analiza(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 0)
