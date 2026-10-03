"""Empaqueta los 210 mapas en un unico binario comprimido.

Objetivo: que el cliente web los tenga TODOS en memoria desde el arranque, de
modo que cambiar de mapa no cargue nada. En crudo son 13 MB, pero estan llenos
de ceros y comprimen a menos de medio mega.

Formato (little-endian):
  'DBOM' u8:version u16:numMapas
  por mapa:
    u16 id | u8+bytes nombre | u8+bytes musica | u8 indoors | u8 moral
    u16[15] npcs
    961 casillas: u16[9] capas, u8[9] hoja, u8 tipo, u16 data1..3   (34 bytes)
    u16 numCarteles, por cartel: u16 casilla, u8 ranura, u16+bytes texto

Uso:
  python build_maps.py                  # los map*.dat de la carpeta de arriba
  python build_maps.py "C:/ruta/al/cliente"   # los de otra instalacion
"""
import struct, glob, os, gzip, sys, dbo_map

AQUI = os.path.dirname(os.path.abspath(__file__))
# Por defecto, la carpeta que contiene a esta: donde vive el cliente original
# con sus map*.dat. Se le puede pasar otra por linea de comandos.
ORIG = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(AQUI)
SAL  = os.path.join(AQUI, 'assets', 'maps.bin')

archivos = sorted(glob.glob(os.path.join(ORIG, 'map*.dat')),
                  key=lambda p: int(''.join(c for c in os.path.basename(p) if c.isdigit())))
out = bytearray(b'DBOM' + struct.pack('<BH', 1, len(archivos)))
desborde = 0
for p in archivos:
    m = dbo_map.load(p)
    nom = m.name.strip().encode('latin1')[:255]
    mus = m.music.strip('\x00').encode('latin1')[:255]
    out += struct.pack('<H', m.id)
    out += struct.pack('<B', len(nom)) + nom
    out += struct.pack('<B', len(mus)) + mus
    out += struct.pack('<BB', m.indoors, m.moral)
    out += struct.pack('<15H', *[min(max(n, 0), 65535) for n in m.npcs])
    carteles = []
    for i, t in enumerate(m.tiles):
        capas = []
        for v in t.layers:
            if not (0 <= v <= 65535):
                desborde += 1; v = 0
            capas.append(v)
        out += struct.pack('<9H', *capas)
        out += bytes(t.flags[:9]) + bytes(max(0, 9 - len(t.flags)))
        out += struct.pack('<B', t.type)
        out += struct.pack('<3H', *[min(max(v, 0), 65535) for v in t.data])
        for s, txt in enumerate(t.strings):
            if txt.strip():
                carteles.append((i, s, txt.encode('latin1')[:65535]))
    out += struct.pack('<H', len(carteles))
    for i, s, txt in carteles:
        out += struct.pack('<HBH', i, s, len(txt)) + txt

crudo = len(out)
comp = gzip.compress(bytes(out), 9)
open(SAL, 'wb').write(comp)
print(f'  {len(archivos)} mapas')
print(f'  crudo      {crudo/1048576:.2f} MB')
print(f'  comprimido {len(comp)/1048576:.2f} MB   -> assets/maps.bin')
if desborde:
    print(f'  AVISO: {desborde} valores de capa fuera de rango')
