"""Genera las dos pantallas de menu que el cliente original tiene en Flash y
que no pudimos extraer: la de crear cuenta y la de crear personaje.

No se dibujan de cero: se parte del arte ORIGINAL (menu_borrar.png, que tiene
los dos campos, el marco y el dragon) y se le borran las palabras que sobran.
El borrado es una difusion de los pixeles vecinos sobre la mascara de las
letras; el fondo ahi es liso, asi que no se nota. Los rotulos nuevos los pone
el HTML encima, en Georgia versalitas, que es la misma familia que usa el
juego.

    python build_ui.py
"""
import os
import numpy as np
from PIL import Image, ImageFilter

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets', 'ui')
BASE = os.path.join(RAIZ, 'menu_borrar.png')

# Cajas medidas sobre menu_borrar.png (400x400).
ROTULOS = {
    'clave':  (50, 152, 118, 179),    # la palabra "Clave"
    'accion': (95, 205, 235, 230),    # "Borrar Cuenta"
}


def mascara_letras(a, caja, margen=2):
    """Las letras son blancas con perfil negro; el fondo es turquesa medio."""
    x0, y0, x1, y1 = caja
    L = a[:, :, 0] * .299 + a[:, :, 1] * .587 + a[:, :, 2] * .114
    m = np.zeros(L.shape, bool)
    trozo = (L[y0:y1, x0:x1] > 190) | (L[y0:y1, x0:x1] < 70)
    m[y0:y1, x0:x1] = trozo
    # engordar para llevarse tambien el borde suavizado del JPEG
    for _ in range(margen):
        m |= np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
    fuera = np.ones(L.shape, bool)
    fuera[y0 - margen:y1 + margen, x0 - margen:x1 + margen] = False
    m[fuera] = False
    return m


def borra(a, m, vueltas=260):
    """Rellena la mascara con la media de los vecinos, una y otra vez."""
    img = a.astype(float).copy()
    img[m] = np.nan
    for _ in range(vueltas):
        p = img.copy()
        acum = np.zeros_like(p)
        n = np.zeros(p.shape[:2])
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            v = np.roll(np.roll(p, dy, 0), dx, 1)
            ok = ~np.isnan(v[:, :, 0])
            acum[ok] += v[ok]
            n += ok
        media = np.where(n[:, :, None] > 0, acum / np.maximum(n, 1)[:, :, None], 0)
        hueco = np.isnan(img[:, :, 0]) & (n > 0)
        img[hueco] = media[hueco]
        if not np.isnan(img[:, :, 0]).any():
            break
    img[np.isnan(img)] = 0
    # un suspiro de desenfoque solo en la zona parcheada, para que no se vea el grano
    suave = np.array(Image.fromarray(img.astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.1)), float)
    img[m] = suave[m]
    return img.astype(np.uint8)


def construye(quitar, salida):
    a = np.array(Image.open(BASE).convert('RGB'))
    m = np.zeros(a.shape[:2], bool)
    for k in quitar:
        m |= mascara_letras(a.astype(float), ROTULOS[k])
    Image.fromarray(borra(a, m)).save(os.path.join(RAIZ, salida))
    print(f'{salida}: borrado {" y ".join(quitar)}  ({int(m.sum())} px)')


if __name__ == '__main__':
    # Crear cuenta: mismos campos que borrar cuenta, sin la palabra de abajo.
    construye(['accion'], 'menu_cuenta.png')
    # Crear personaje: ademas la palabra "Clave" sobra (ahi va la raza).
    construye(['accion', 'clave'], 'menu_pjnuevo.png')
