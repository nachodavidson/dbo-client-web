"""Que criatura aparece en que mapa, sacado de los propios archivos de mapa.

No hace falta interceptar nada ni conectarse a ningun sitio: cada mapN.dat
lleva en su cabecera quince ranuras con los NUMEROS de criatura que el servidor
debe hacer aparecer ahi. Eso es el reparto completo del bestiario.

Lo que NO esta en el mapa es que ES cada numero. El nombre, el sprite y la vida
maxima llegan por `UPDATENPC` al entrar al juego; el resto (fuerza, defensa,
experiencia que da, lo que suelta) no viaja nunca por la red. Ver botin.py.

Uso:
  python mobs_por_mapa.py "C:/ruta/al/cliente/Maps"
  python mobs_por_mapa.py "C:/ruta/Maps" salida.json
  python mobs_por_mapa.py "C:/ruta/Maps" salida.json botin.json

El tercer argumento es un botin.json de los que genera el adaptador: si se le
pasa, se le ponen los nombres a los numeros.
"""
import sys, os, glob, json, collections

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_web'))
import dbo_map


def recoge(carpeta):
    por_mapa, por_criatura = {}, collections.defaultdict(list)
    for p in sorted(glob.glob(os.path.join(carpeta, 'map*.dat'))):
        base = os.path.basename(p)
        digs = ''.join(c for c in base if c.isdigit())
        if not digs:
            continue
        num = int(digs)
        try:
            m = dbo_map.load(p)
        except Exception as e:
            print(f'  !! {base}: {e}')
            continue
        nombre = (m.name or '').strip()
        if not nombre:
            continue                      # plantilla vacia, no es un sitio
        criaturas = sorted({n for n in m.npcs if n})
        if not criaturas:
            continue
        por_mapa[num] = {'nombre': nombre, 'criaturas': criaturas}
        for n in criaturas:
            por_criatura[n].append(num)
    return por_mapa, dict(por_criatura)


def nombres_del_botin(ruta):
    if not ruta or not os.path.exists(ruta):
        return {}
    with open(ruta, encoding='utf-8') as f:
        d = json.load(f)
    return {int(k): v.get('nombre', '') for k, v in d.get('criaturas', {}).items()
            if k.isdigit()}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    carpeta = sys.argv[1]
    salida = sys.argv[2] if len(sys.argv) > 2 else 'mobs_por_mapa.json'
    nombres = nombres_del_botin(sys.argv[3] if len(sys.argv) > 3 else None)

    por_mapa, por_criatura = recoge(carpeta)
    print(f'  mapas con criaturas      {len(por_mapa)}')
    print(f'  criaturas referenciadas  {len(por_criatura)}'
          + (f'  (del {min(por_criatura)} al {max(por_criatura)})' if por_criatura else ''))
    if nombres:
        con = sum(1 for n in por_criatura if nombres.get(n))
        print(f'  con nombre conocido      {con} de {len(por_criatura)}')

    print('\n  las que aparecen en mas sitios:')
    for n, ms in sorted(por_criatura.items(), key=lambda kv: -len(kv[1]))[:12]:
        etq = nombres.get(n) or '(nombre desconocido)'
        print(f'    {n:4d}  {etq:22s} en {len(ms):3d} mapas')

    datos = {
        'porMapa': {str(k): v for k, v in sorted(por_mapa.items())},
        'porCriatura': {str(k): {'nombre': nombres.get(k, ''), 'mapas': sorted(v)}
                        for k, v in sorted(por_criatura.items())},
    }
    with open(salida, 'w', encoding='utf-8') as f:
        json.dump(datos, f, ensure_ascii=False, indent=1)
    print(f'\n  -> {salida}')


if __name__ == '__main__':
    main()
