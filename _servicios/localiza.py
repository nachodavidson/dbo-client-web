"""Localiza un personaje dentro de una captura del cliente Windows.

No se puede inyectar teclado ni raton en el cliente (SetCursorPos falla y
GetAsyncKeyState nunca ve la tecla), pero SI se puede capturar su ventana. Y el
cliente dibuja tambien a los demas jugadores, incluido el del cliente web, que
si controlamos. Asi que el cliente Windows sirve de ORACULO: se le pide que
dibuje nuestro personaje y se compara con lo que pinta la web.

Para recortar al personaje se busca su NOMBRE, que va en magenta puro encima de
la cabeza. El recorte de 32x32 cuelga del centro del rotulo.

Uso:  python localiza.py captura.png Webtest salida.png
"""
import sys
from PIL import Image

TS = 32
# El visor del mapa dentro de la ventana (el resto es marco e interfaz).
VISOR = (287, 48, 925, 522)


def grupos_magenta(im, caja=VISOR):
    """Devuelve los rotulos de nombre como cajas (x0,y0,x1,y1)."""
    px = im.load()
    puntos = []
    for y in range(caja[1], caja[3]):
        for x in range(caja[0], caja[2]):
            r, g, b = px[x, y][:3]
            if r > 190 and b > 190 and g < 110:      # magenta del nombre
                puntos.append((x, y))
    if not puntos:
        return []
    # agrupar por cercania: los nombres estan separados entre si
    grupos, usados = [], set()
    for p in puntos:
        if p in usados:
            continue
        pila, grupo = [p], []
        usados.add(p)
        while pila:
            cx, cy = pila.pop()
            grupo.append((cx, cy))
            for q in puntos:
                if q in usados:
                    continue
                if abs(q[0] - cx) <= 6 and abs(q[1] - cy) <= 4:
                    usados.add(q)
                    pila.append(q)
        xs = [q[0] for q in grupo]
        ys = [q[1] for q in grupo]
        grupos.append((min(xs), min(ys), max(xs), max(ys)))
    return grupos


def recorta(im, caja_rotulo, bajada=4):
    """El personaje va justo debajo de su nombre, centrado."""
    cx = (caja_rotulo[0] + caja_rotulo[2]) // 2
    arriba = caja_rotulo[3] + bajada
    x0 = cx - TS // 2
    return im.crop((x0, arriba, x0 + TS, arriba + TS))


if __name__ == '__main__':
    ruta = sys.argv[1]
    quien = sys.argv[2] if len(sys.argv) > 2 else None
    salida = sys.argv[3] if len(sys.argv) > 3 else None
    im = Image.open(ruta).convert('RGB')
    gs = grupos_magenta(im)
    gs.sort(key=lambda g: g[2] - g[0], reverse=True)   # el nombre mas largo primero
    print(f'rotulos encontrados: {len(gs)}')
    for g in gs:
        print(f'  caja={g} ancho={g[2]-g[0]}')
    if gs and salida:
        # sin OCR: el mas ancho es el nombre mas largo (Webtest sobre test)
        g = gs[0]
        recorta(im, g).save(salida)
        print(f'recorte de {quien} -> {salida} (bajo el rotulo {g})')
