"""
Parser del formato mapN.dat de Dream Blue Online 3.01 (motor Dreaminze, VB6 + DirectX7).
Formato deducido por ingenieria inversa - validado contra los 210 mapas del cliente.

LAYOUT
------
HEADER
  0   .. 39   Name        String*40 (relleno con espacios)
  40  .. 43   Revision    Long
  44         Moral       Byte  (0,1,2)
  45  .. 60   Up/Down/Left/Right  4 Longs (siempre 0 en este cliente)
  61  .. 62   len(Music)  Integer
  63  ..      Music       String (variable, p.ej. "Music10.mid")
  +0  .. +9   10 bytes    (siempre 0: BootMap/BootX/BootY?)
  +10         Indoors     Byte (0/1)
  +11 .. +12  Integer = 2 (constante)
  +13 .. +16  MaxX = 31
  +17 .. +20  Long = 0
  +21 .. +24  MaxY = 31
  +25 .. +28  Long = 0
TILES: 961 registros (31x31, orden row-major: idx = y*31 + x)
  0  .. 35    9 Longs: Ground, Mask, Anim, Mask2, M2Anim, Fringe, FAnim, Fringe2, F2Anim
  36          Type   Byte
  37 .. 48    Data1, Data2, Data3  (3 Longs) -> en warps: mapa destino, X, Y
  49 ..       5 Strings con prefijo Integer de longitud (mensaje, wav, ...)
  +9 bytes    9 bytes de flags (valores 0/1/2/4)
FOOTER: 60 bytes = 15 Longs con los IDs de NPC que spawnean en el mapa
  (algunos mapas tienen strings extra tras el footer)
"""
import struct, glob, os

TILE_TYPES = {0: "none", 1: "blocked", 2: "warp", 3: "?", 4: "walkable/none2",
              5: "?", 6: "?", 7: "?", 8: "?", 9: "?", 10: "?", 11: "?",
              13: "?", 14: "?", 15: "?", 16: "?", 19: "?", 21: "?"}

class Tile:
    __slots__ = ("x","y","layers","type","data","strings","flags")

class Map:
    pass

def load(path):
    d = open(path, "rb").read()
    m = Map()
    m.file = os.path.basename(path)
    m.id = int("".join(c for c in m.file if c.isdigit()))
    m.name = d[:40].decode("latin1").rstrip()
    m.revision = struct.unpack_from("<i", d, 40)[0]
    m.moral = d[44]
    n = struct.unpack_from("<H", d, 61)[0]
    m.music = d[63:63+n].decode("latin1")
    o = 63 + n
    m.indoors = d[o+10]
    m.width = struct.unpack_from("<i", d, o+13)[0]
    m.height = struct.unpack_from("<i", d, o+21)[0]
    o += 29
    m.tiles = []
    for i in range(961):
        t = Tile()
        t.x, t.y = i % 31, i // 31
        t.layers = list(struct.unpack_from("<9i", d, o)); o += 36
        t.type = d[o]; o += 1
        t.data = list(struct.unpack_from("<3i", d, o)); o += 12
        t.strings = []
        for _ in range(5):
            L = struct.unpack_from("<H", d, o)[0]; o += 2
            t.strings.append(d[o:o+L].decode("latin1")); o += L
        t.flags = list(d[o:o+9]); o += 9
        m.tiles.append(t)
    f = d[o:]
    m.npcs = [struct.unpack_from("<i", f, i)[0] for i in range(0, 60, 4)]
    m.footer_extra = f[60:]
    return m

def tile(m, x, y):
    return m.tiles[y*31 + x]

if __name__ == "__main__":
    import sys
    for p in (sys.argv[1:] or sorted(glob.glob("map*.dat"))):
        m = load(p)
        warps = [(t.x, t.y, t.data) for t in m.tiles if t.type == 2]
        print(f"{m.file:14s} id={m.id:3d} {m.name[:34]:34s} music={m.music:24s} "
              f"warps={len(warps):3d} npcs={[n for n in m.npcs if n]}")
