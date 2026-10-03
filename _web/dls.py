"""Lector de gm.dls (el banco de sonidos de Windows, formato DLS nivel 1/2).

Es EXACTAMENTE el juego de muestras que usa el Microsoft GS Wavetable Synth,
que es lo que sonaba en el DBO original. Leerlo nos da el timbre real, no una
imitacion.
"""
import struct, collections

def chunks(d, ini, fin):
    p = ini
    while p + 8 <= fin:
        cid = d[p:p+4]
        sz = struct.unpack_from('<I', d, p+4)[0]
        cuerpo = p + 8
        yield cid, cuerpo, cuerpo + sz
        p = cuerpo + sz + (sz & 1)

def listas(d, ini, fin):
    for cid, a, b in chunks(d, ini, fin):
        if cid in (b'LIST', b'RIFF'):
            yield d[a:a+4], a + 4, b
        else:
            yield cid, a, b

class Region:
    __slots__ = ('kmin','kmax','vmin','vmax','onda','raiz','fino','aten','bucle','bini','blen',
                 'tiene_wsmp','art')

class Instrumento:
    def __init__(self):
        self.banco = 0; self.prog = 0; self.percusion = False
        self.regiones = []; self.nombre = ''; self.art = {}

def leer(ruta):
    d = open(ruta,'rb').read()
    assert d[:4] == b'RIFF' and d[8:12] == b'DLS '
    fin = struct.unpack_from('<I', d, 4)[0] + 8
    instrumentos, ptbl, wvpl = [], [], None

    for cid, a, b in listas(d, 12, fin):
        if cid == b'lins':
            for cid2, a2, b2 in listas(d, a, b):
                if cid2 == b'ins ': instrumentos.append(_ins(d, a2, b2))
        elif cid == b'ptbl':
            cbSize, cCues = struct.unpack_from('<II', d, a)
            ptbl = list(struct.unpack_from('<%dI' % cCues, d, a + cbSize))
        elif cid == b'wvpl':
            wvpl = (a, b)
    return d, instrumentos, ptbl, wvpl

def _ins(d, ini, fin):
    ins = Instrumento()
    for cid, a, b in listas(d, ini, fin):
        if cid == b'insh':
            _, banco, prog = struct.unpack_from('<III', d, a)
            ins.banco = banco & 0x7FFF
            ins.percusion = bool(banco & 0x80000000)
            ins.prog = prog & 0x7F
        elif cid == b'lrgn':
            for cid2, a2, b2 in listas(d, a, b):
                if cid2 in (b'rgn ', b'rgn2'):
                    r = _rgn(d, a2, b2)
                    if r: ins.regiones.append(r)
        elif cid in (b'lart', b'lar2'):
            ins.art = articulacion(d, a, b)
        elif cid == b'INFO':
            for cid2, a2, b2 in chunks(d, a, b):
                if cid2 == b'INAM': ins.nombre = d[a2:b2].split(b'\0')[0].decode('latin1')
    return ins

def _rgn(d, ini, fin):
    r = Region()
    r.raiz = 60; r.fino = 0; r.aten = 0; r.bucle = 0; r.bini = 0; r.blen = 0
    r.onda = None; r.tiene_wsmp = False; r.art = {}
    for cid, a, b in listas(d, ini, fin):
        if cid == b'rgnh':
            r.kmin, r.kmax, r.vmin, r.vmax = struct.unpack_from('<HHHH', d, a)
        elif cid == b'wsmp':
            r.tiene_wsmp = True
            cb = struct.unpack_from('<I', d, a)[0]
            r.raiz, r.fino, r.aten, opciones, nbucles = struct.unpack_from('<HhiII', d, a+4)
            if nbucles:
                p = a + cb
                _, tipo, ini2, largo = struct.unpack_from('<IIII', d, p)
                r.bucle, r.bini, r.blen = 1, ini2, largo
        elif cid in (b'lart', b'lar2'):
            r.art.update(articulacion(d, a, b))
        elif cid == b'wlnk':
            _, _, _, tabla = struct.unpack_from('<HHII', d, a)
            r.onda = tabla
    return r if r.onda is not None else None

# Destinos de la articulacion DLS que nos interesan: la envolvente de volumen.
DST = {0x0206: 'a', 0x0207: 'd', 0x0209: 's', 0x020A: 'r'}

def articulacion(d, ini, fin):
    """Lee los bloques art1/art2 y devuelve {a,d,s,r} de la envolvente 1.

    Los tiempos vienen en 'timecents' con coma fija 16.16: segundos = 2^(tc/1200).
    El sostenido viene en decimas de por ciento, tambien 16.16.
    """
    out = {}
    for cid, a, b in chunks(d, ini, fin):
        if cid not in (b'art1', b'art2'): continue
        cb, cCon = struct.unpack_from('<II', d, a)
        for k in range(cCon):
            src, ctl, dst, tr, esc = struct.unpack_from('<HHHHi', d, a + cb + k * 12)
            if src != 0 or ctl != 0: continue          # solo la conexion fija
            nombre = DST.get(dst)
            if not nombre: continue
            if nombre == 's': out['s'] = max(0.0, min(1.0, esc / 65536.0 / 1000.0))
            else:             out[nombre] = 2 ** (esc / 65536.0 / 1200.0)
    return out


def onda(d, wvpl, ptbl, idx):
    """Devuelve (frec_muestreo, bits, canales, pcm_bytes, wsmp_de_la_onda)."""
    base = wvpl[0]
    p = base + ptbl[idx]
    assert d[p:p+4] == b'LIST'
    sz = struct.unpack_from('<I', d, p+4)[0]
    a, b = p + 12, p + 8 + sz
    fmt = datos = None; ws = None
    for cid, x, y in chunks(d, a, b):
        if cid == b'fmt ': fmt = struct.unpack_from('<HHIIHH', d, x)
        elif cid == b'data': datos = (x, y)
        elif cid == b'wsmp':
            cb = struct.unpack_from('<I', d, x)[0]
            raiz, fino, aten, opciones, nb = struct.unpack_from('<HhiII', d, x+4)
            bucle = None
            if nb:
                q = x + cb
                _, tipo, i2, l2 = struct.unpack_from('<IIII', d, q)
                bucle = (i2, l2)
            ws = (raiz, fino, aten, bucle)
    return fmt, datos, ws

if __name__ == '__main__':
    d, ins, ptbl, wvpl = leer(r'C:\Windows\System32\drivers\gm.dls')
    print('instrumentos:', len(ins), ' ondas:', len(ptbl))
    mel = [i for i in ins if not i.percusion]
    per = [i for i in ins if i.percusion]
    print('melodicos:', len(mel), 'percusion:', len(per))
    for i in mel[:3]:
        print(f'  prog {i.prog:3} banco {i.banco} "{i.nombre}" regiones={len(i.regiones)}')
    fmt, datos, ws = onda(d, wvpl, ptbl, 0)
    print('onda 0: fmt', fmt, 'bytes', datos[1]-datos[0], 'wsmp', ws)
