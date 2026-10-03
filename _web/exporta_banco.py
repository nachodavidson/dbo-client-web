"""Construye el banco de sonidos para el cliente web a partir de gm.dls.

gm.dls es el juego de muestras del Microsoft GS Wavetable Synth: EXACTAMENTE lo
que sonaba cuando el juego original reproducia sus MIDI en Windows. Usarlo es la
unica forma de que la musica suene igual y no parecida.

Solo se exportan los instrumentos que los 28 MIDI del juego usan de verdad.

Salida:
  assets/soundbank.bin   PCM 16 bits con signo, todas las ondas seguidas
  assets/soundbank.json  indice: instrumentos -> regiones -> onda, afinacion,
                         bucle y envolvente
"""
import json, os, struct, glob, collections
import dls

GM = r'C:\Windows\System32\drivers\gm.dls'
SALIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')


def varint(d, p):
    v = 0
    while True:
        b = d[p]; p += 1
        v = (v << 7) | (b & 0x7F)
        if not (b & 0x80): return v, p


def usados(carpeta):
    """Programas melodicos y notas de percusion que aparecen en los MIDI."""
    progs, drums = set(), set()
    for ruta in glob.glob(os.path.join(carpeta, '*.mid')):
        d = open(ruta, 'rb').read()
        n = struct.unpack_from('>H', d, 10)[0]
        p = 14
        for _ in range(n):
            if d[p:p+4] != b'MTrk': break
            largo = struct.unpack_from('>I', d, p+4)[0]
            q, fin = p + 8, p + 8 + largo
            estado = 0; prog = [0]*16
            while q < fin:
                _, q = varint(d, q)
                if d[q] & 0x80: estado = d[q]; q += 1
                t, c = estado & 0xF0, estado & 0x0F
                if estado == 0xFF:
                    q += 1; L, q = varint(d, q); q += L
                elif estado in (0xF0, 0xF7):
                    L, q = varint(d, q); q += L
                elif t == 0xC0: prog[c] = d[q]; q += 1
                elif t == 0xD0: q += 1
                elif t in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                    a, b = d[q], d[q+1]; q += 2
                    if t == 0x90 and b > 0:
                        (drums if c == 9 else progs).add(a if c == 9 else prog[c])
                else: q += 1
            p = fin
    return sorted(progs), sorted(drums)


def main():
    d, instrumentos, ptbl, wvpl = dls.leer(GM)
    mel = {i.prog: i for i in instrumentos if not i.percusion and i.banco == 0}
    kit = next(i for i in instrumentos if i.percusion and i.prog == 0)

    progs, drums = usados(os.path.join(SALIDA, 'music'))
    print(f'{len(progs)} programas y {len(drums)} notas de percusion en los MIDI')

    pcm = bytearray()
    indice_onda = {}          # idx original -> posicion en nuestra lista
    ondas = []

    def meter(idx):
        if idx in indice_onda: return indice_onda[idx]
        fmt, datos, ws = dls.onda(d, wvpl, ptbl, idx)
        canales, hz, bits = fmt[1], fmt[2], fmt[5]
        assert canales == 1 and bits == 16, (canales, bits)
        cuerpo = d[datos[0]:datos[1]]
        off = len(pcm) // 2
        pcm.extend(cuerpo)
        raiz, fino, aten, bucle = ws
        ondas.append({
            'off': off, 'n': len(cuerpo) // 2, 'hz': hz,
            'raiz': raiz, 'fino': fino, 'aten': aten,
            'bini': bucle[0] if bucle else -1, 'blen': bucle[1] if bucle else 0,
        })
        indice_onda[idx] = len(ondas) - 1
        return indice_onda[idx]

    def exportar(ins, filtro=None):
        fuera = []
        for r in ins.regiones:
            if filtro and not any(r.kmin <= n <= r.kmax for n in filtro): continue
            w = meter(r.onda)
            art = dict(ins.art); art.update(r.art)
            reg = {'kmin': r.kmin, 'kmax': r.kmax, 'vmin': r.vmin, 'vmax': r.vmax, 'w': w}
            if r.tiene_wsmp:
                reg.update({'raiz': r.raiz, 'fino': r.fino, 'aten': r.aten,
                            'bini': r.bini if r.bucle else -1, 'blen': r.blen})
            for k in 'adsr':
                if k in art: reg[k] = round(art[k], 5)
            fuera.append(reg)
        return fuera

    banco = {'prog': {}, 'perc': exportar(kit, drums)}
    for p in progs:
        if p not in mel:
            print('  sin instrumento para el programa', p); continue
        banco['prog'][str(p)] = exportar(mel[p])

    banco['ondas'] = ondas
    with open(os.path.join(SALIDA, 'soundbank.bin'), 'wb') as f:
        f.write(pcm)
    with open(os.path.join(SALIDA, 'soundbank.json'), 'w', encoding='utf-8') as f:
        json.dump(banco, f, separators=(',', ':'))

    print(f'ondas exportadas: {len(ondas)}')
    print(f'soundbank.bin : {len(pcm)/1024/1024:.2f} MB')
    print(f'soundbank.json: {os.path.getsize(os.path.join(SALIDA,"soundbank.json"))/1024:.0f} KB')


if __name__ == '__main__':
    main()
