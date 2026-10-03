"""Dibuja un mapa desde maps.bin + los WebP y lo compara con el render de
referencia ya validado contra capturas reales del juego. Si coincide, el
pipeline de assets y el modelo de dibujado son correctos."""
import struct, gzip, sys, os
from PIL import Image, ImageChops

_AQUI = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(_AQUI, 'assets')
TS, STRIDE = 32, 14


def leer_mapas(path):
    d = gzip.decompress(open(path, 'rb').read())
    assert d[:4] == b'DBOM'
    ver, n = struct.unpack_from('<BH', d, 4)
    o = 7
    mapas = {}
    for _ in range(n):
        mid, = struct.unpack_from('<H', d, o); o += 2
        ln = d[o]; o += 1; nom = d[o:o+ln].decode('latin1'); o += ln
        lm = d[o]; o += 1; mus = d[o:o+lm].decode('latin1'); o += lm
        indoors, moral = d[o], d[o+1]; o += 2
        npcs = struct.unpack_from('<15H', d, o); o += 30
        casillas = []
        for _ in range(961):
            capas = struct.unpack_from('<9H', d, o); o += 18
            hojas = d[o:o+9]; o += 9
            tipo = d[o]; o += 1
            data = struct.unpack_from('<3H', d, o); o += 6
            casillas.append((capas, hojas, tipo, data))
        nc, = struct.unpack_from('<H', d, o); o += 2
        carteles = []
        for _ in range(nc):
            idx, ranura, L = struct.unpack_from('<HBH', d, o); o += 5
            carteles.append((idx, ranura, d[o:o+L].decode('latin1'))); o += L
        mapas[mid] = dict(nombre=nom, musica=mus, indoors=indoors, moral=moral,
                          npcs=npcs, casillas=casillas, carteles=carteles)
    return mapas


def dibujar(mapa, hojas):
    img = Image.new('RGBA', (31*TS, 31*TS), (0, 0, 0, 255))
    for i, (capas, hj, tipo, data) in enumerate(mapa['casillas']):
        x, y = (i % 31)*TS, (i // 31)*TS
        for slot in range(9):
            v = capas[slot]
            if v == 0:
                continue
            hoja = hojas.get(hj[slot])
            if hoja is None:
                continue
            col, fila = v % STRIDE, v // STRIDE
            if col*TS + TS > hoja.width or fila*TS + TS > hoja.height:
                continue
            img.alpha_composite(hoja.crop((col*TS, fila*TS, col*TS+TS, fila*TS+TS)), (x, y))
    return img


if __name__ == '__main__':
    mid = int(sys.argv[1]) if len(sys.argv) > 1 else 32
    hojas = {n: Image.open(os.path.join(BASE, f'tiles{n}.webp')).convert('RGBA') for n in range(7)}
    mapas = leer_mapas(os.path.join(BASE, 'maps.bin'))
    m = mapas[mid]
    img = dibujar(m, hojas)
    salida = os.path.join(BASE, '..', f'check_map{mid}.png')
    img.convert('RGB').save(salida)
    print(f'  mapa {mid}: {m["nombre"]!r}  musica={m["musica"]!r}')

    ref_p = os.path.join(os.path.dirname(_AQUI), '_extracted', f'FINAL_map{mid}.png')
    if os.path.exists(ref_p):
        ref = Image.open(ref_p).convert('RGB')
        mio = img.convert('RGB')
        if ref.size != mio.size:
            print(f'  tamanos distintos: referencia {ref.size} vs nuevo {mio.size}')
        else:
            dif = ImageChops.difference(ref, mio)
            caja = dif.getbbox()
            distintos = sum(1 for p in dif.getdata() if p != (0, 0, 0))
            total = mio.size[0]*mio.size[1]
            print(f'  pixeles distintos: {distintos} de {total} ({100*distintos/total:.2f}%)')
            print('  IDENTICO' if caja is None else f'  difiere en la zona {caja}')
