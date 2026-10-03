"""Deduce la geografia del mundo y la guarda en mundo.json.

El problema: los mapN.dat NO guardan su posicion. El encabezado tiene campos
Up/Down/Left/Right pero en este cliente estan todos en cero. Asi que hay que
reconstruir el mapa del mundo a partir de los warps.

La clave es distinguir COSTURA de PUERTA:
  - costura: warp en un borde que aterriza en el borde OPUESTO del vecino.
             Eso significa que los dos mapas son contiguos en el espacio.
  - puerta:  warp que aterriza en mitad del destino. Es una tienda, una cueva,
             un teleport. NO implica contiguidad.
Sin esa distincion "Venta de armas" acabaria flotando encima del bosque.
"""
import sys, glob, os, json, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dbo_map

_AQUI = os.path.dirname(os.path.abspath(__file__))
# La carpeta con los map*.dat; se le puede pasar otra por linea de comandos.
ORIG = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(_AQUI)
SAL  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mundo.json')

TOL  = 3                       # margen para considerar que se cae en el borde
DIRS = {'N': (0, -1), 'S': (0, 1), 'O': (-1, 0), 'E': (1, 0)}

mapas = {}
for p in sorted(glob.glob(os.path.join(ORIG, 'map*.dat')),
                key=lambda q: int(''.join(c for c in os.path.basename(q) if c.isdigit()))):
    m = dbo_map.load(p)
    mapas[m.id] = m

# ---- 1. costuras ----------------------------------------------------------
costuras = collections.defaultdict(collections.Counter)
puertas = collections.defaultdict(list)
for m in mapas.values():
    for t in m.tiles:
        if t.type != 2:
            continue
        d, dx, dy = t.data
        if d not in mapas:
            continue
        if   t.y == 0  and dy >= 30 - TOL: costuras[(m.id, 'N')][d] += 1
        elif t.y == 30 and dy <= TOL:      costuras[(m.id, 'S')][d] += 1
        elif t.x == 0  and dx >= 30 - TOL: costuras[(m.id, 'O')][d] += 1
        elif t.x == 30 and dx <= TOL:      costuras[(m.id, 'E')][d] += 1
        else: puertas[m.id].append([t.x, t.y, d, dx, dy])

vecinos = collections.defaultdict(dict)
for (mid, dr), cnt in costuras.items():
    vecinos[mid][dr] = cnt.most_common(1)[0][0]

# ---- 2. colocacion por componentes ---------------------------------------
colocado, comp_de, componentes, desplazados = {}, {}, [], set()
for raiz in sorted(mapas):
    if raiz in colocado:
        continue
    local, usados = {raiz: (0, 0)}, {(0, 0): raiz}
    cola = collections.deque([raiz])
    while cola:
        a = cola.popleft()
        ax, ay = local[a]
        for dr, (ddx, ddy) in DIRS.items():
            b = vecinos.get(a, {}).get(dr)
            if b is None or b in colocado or b in local:
                continue
            p = (ax + ddx, ay + ddy)
            if p in usados:
                # el grafo de warps no siempre es plano: buscamos el hueco mas
                # cercano en espiral para no perder el mapa y lo marcamos.
                r, puesto = 1, False
                while r < 40 and not puesto:
                    for oy in range(-r, r + 1):
                        for ox in range(-r, r + 1):
                            if max(abs(ox), abs(oy)) != r:
                                continue
                            q = (ax + ddx + ox, ay + ddy + oy)
                            if q not in usados:
                                p, puesto = q, True
                                break
                        if puesto:
                            break
                    r += 1
                desplazados.add(b)
            local[b] = p; usados[p] = b; cola.append(b)
    ci = len(componentes)
    for k, v in local.items():
        colocado[k] = v; comp_de[k] = ci
    componentes.append(local)

# ---- 3. empaquetado de componentes en el lienzo global -------------------
# El continente principal manda: va arriba a la izquierda. El resto se acomoda
# en estantes a su derecha, de mayor a menor.
HUECO = 1                                    # casillas de aire entre componentes
cajas = []
for i, c in enumerate(componentes):
    xs = [p[0] for p in c.values()]; ys = [p[1] for p in c.values()]
    cajas.append({'i': i, 'x0': min(xs), 'y0': min(ys),
                  'w': max(xs) - min(xs) + 1, 'h': max(ys) - min(ys) + 1, 'n': len(c)})
cajas.sort(key=lambda b: (-b['n'], -b['w'] * b['h']))

principal = cajas[0]
ANCHO_TIRA = principal['w']
offs = {principal['i']: (0, 0)}
cursor_y = principal['h'] + HUECO * 2
fila_x, fila_alto = 0, 0
for b in cajas[1:]:
    if fila_x + b['w'] > ANCHO_TIRA and fila_x > 0:
        cursor_y += fila_alto + HUECO
        fila_x, fila_alto = 0, 0
    offs[b['i']] = (fila_x, cursor_y)
    fila_x += b['w'] + HUECO
    fila_alto = max(fila_alto, b['h'])

salida = {}
for mid, (lx, ly) in colocado.items():
    ci = comp_de[mid]
    b = next(q for q in cajas if q['i'] == ci)
    ox, oy = offs[ci]
    salida[mid] = {
        'gx': ox + lx - b['x0'],
        'gy': oy + ly - b['y0'],
        'comp': ci,
        'desplazado': mid in desplazados,
        'vecinos': vecinos.get(mid, {}),
        'puertas': puertas.get(mid, []),
    }

gw = max(v['gx'] for v in salida.values()) + 1
gh = max(v['gy'] for v in salida.values()) + 1
doc = {
    'anchoRejilla': gw, 'altoRejilla': gh,
    'compPrincipal': principal['i'],
    'tamComp': {str(b['i']): b['n'] for b in cajas},
    'mapas': {str(k): v for k, v in salida.items()},
}
json.dump(doc, open(SAL, 'w', encoding='utf-8'), separators=(',', ':'))

print(f'  mapas            {len(mapas)}')
print(f'  componentes      {len(componentes)}  (principal: {principal["n"]} mapas, {principal["w"]}x{principal["h"]})')
print(f'  costuras         {sum(len(v) for v in vecinos.values())}')
print(f'  puertas/teleport {sum(len(v) for v in puertas.values())}')
print(f'  desplazados      {len(desplazados)}')
print(f'  rejilla global   {gw}x{gh}  ->  mundo.json ({os.path.getsize(SAL)/1024:.0f} KB)')
