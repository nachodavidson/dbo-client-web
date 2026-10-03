"""Adaptador de protocolo Dream Blue Online.

El cliente DBO 3.01.0121 (2006) NO tiene el atributo Suerte; el servidor de
Dreaminze Engine 1.3 (2007) lo anadio y lo manda en el paquete. Ese campo de mas
corre todo el registro de clase:

    cliente 0121:  Name HP MP SP STR DEF SPEED MAGI      MSpr FSpr Locked
    servidor 1.3:  Name HP MP SP STR DEF SPEED MAGI Luck MSpr FSpr Locked
                                                    ^^^^ sobra

Al leerse corrido, el cliente toma como `Locked` un campo que casi nunca vale 0,
da todas las clases por bloqueadas y no mete ninguna en la lista. Despues hace
`cmbClass.ListIndex = 0` sobre una lista vacia -> "Run-time error 380: Invalid
property value" al entrar a crear personaje.

Confirmado tambien por los sprites: quitando FemaleSprite en vez de Luck, el
cliente mostraba el hombre real al elegir "Femenino" y un monstruo al elegir
"Masculino" (leia Luck como indice de sprite). Y el formulario de creacion no
tiene casilla de SUERTE, coherente con que el atributo no exista en este build.

Este proxy se sienta entre el cliente (puerto 4000) y el servidor (4001) y
recorta ese campo al vuelo. No modifica ningun binario.

    cliente DBO  ->  127.0.0.1:4000  [este proxy]  ->  127.0.0.1:4001  server.exe
"""
import socket, threading, os, sys

# 0.0.0.0 = acepta tambien desde la red virtual (Tailscale) y la LAN.
# NO hay puerto abierto en el router: solo llega quien este en la VPN.
LISTEN = ('0.0.0.0', 4000)

# A que servidor se le habla. Por defecto el de esta maquina, pero se puede
# apuntar a OTRO para probar el cliente web contra un servidor ajeno:
#
#   python adapter.py                      -> 127.0.0.1:4001 (el de aqui)
#   python adapter.py 192.168.1.50:4000    -> el de esa maquina
#   python adapter.py mi.servidor.com:4000 --crudo
#
# `--crudo` apaga los arreglos de abajo (version, relleno y el campo Suerte).
# Hacen falta para el servidor de Dreaminze 1.3 con el cliente 3.01, pero si el
# servidor del otro lado esta modificado pueden estorbar en vez de ayudar: con
# --crudo el adaptador solo mira y registra, no toca ni un byte.
def _destino():
    for a in sys.argv[1:]:
        if a.startswith('-') or ':' not in a:
            continue
        host, _, puerto = a.rpartition(':')
        return (host, int(puerto))
    return ('127.0.0.1', 4001)


UPSTREAM = _destino()
ARREGLAR = '--crudo' not in sys.argv
SEP = b'\x00'
END = bytes([237])
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'adapter_log.txt')

# Paquetes con un registro repetido por clase:
#   cmd -> (campos por registro que manda el server, indice del campo a quitar)
FIX_REC = {
    #                                    0    1  2  3  4   5   6     7    8    9    10   11
    b'NEWCHARCLASSES': (12, 8),   # Name HP MP SP STR DEF SPEED MAGI Luck MSpr FSpr Locked
    b'CLASSESDATA':    (10, 8),   # Name HP MP SP STR DEF SPEED MAGI Luck Locked
}

# Cliente -> servidor: el cliente R2 anuncia version 6.0.0 y el servidor de
# Dreaminze 1.3 la rechaza con "Version de DBO anterior". Se reescribe a la que
# si acepta. Inofensivo para el cliente 3.01, que ya manda esos valores.
VERSION_OK = (b'3', b'1', b'121')

# El servidor tambien valida los campos de relleno del login (anti-trampas
# ingenuo): con otros contesta "Estas usando una version antigua del juego o
# no es el cliente original...". R2 los manda distintos, asi que se sustituyen
# por los del cliente 3.01, que son los unicos que acepta.
RELLENO_OK = (
    b'pyrjhgfdsacvnvnsdinaoiwheoewyriusdyrflsdjncjkxzncisdughfusyfuapsipiuahfpaijnflkjnvjnuahguiryasbdlfkjblsahgfauygewuifaunfaur',
    b'aoiuytrewqwuegeguigdfjkldsnoksamdihuehfidsuhdushdsisjsyayejrioehdoisahdjlasndowijapdnaidhaioshnksfnifohaifhaoinfiwnfinsaihfas',
    b'asdfghjklzgoihwbdpiaugsdcapvhvinbudhbpidusbnvduisysayaspiufhpijsanfioasnpuvnupashuasohdaiofhaosifnvnuvnuahiosaodiubaota',
    b'45776543214619123425676749756722829121973794379467987945762347631462572792798792492416127957989742945642908',
)

# Paquetes planos: cmd -> indice del campo a quitar (1 = primero tras el nombre)
FIX_FLAT = {
    # STR DEF SPEED MAGI Luck ExpSiguiente Exp Nivel
    b'PLAYERSTATSPACKET': 5,      # quitar Luck
}

lock = threading.Lock()
VERBOSE = '-v' in sys.argv

# ---------------------------------------------------------------------------
# WARPMETO / WARPTOME
# ---------------------------------------------------------------------------
# El cliente DBO manda estos dos comandos, pero el servidor de Dreaminze 1.3 NO
# los tiene: su tabla solo trae `warpto`. Un comando que no conoce lo toma por
# intento de trampa y te expulsa ("... ha sido expulsado por ()").
#
# Tampoco hay ningun comando que diga donde esta otro jugador ni que mueva a
# nadie mas que a uno mismo, asi que no se puede resolver desde el cliente. Pero
# el adaptador es UN SOLO proceso con TODAS las conexiones delante, y el
# servidor le manda a cada cliente su propio PLAYERDATA:
#
#     PLAYERDATA -> [indice, nombre, sprite, MAPA, x, y, dir, acceso]
#
# Con eso se lleva un registro de quien esta donde y por que conexion, y los dos
# comandos se traducen a `warpto`:
#     WARPMETO otro -> `warpto <mapa del otro>`  por MI conexion
#     WARPTOME otro -> `warpto <mi mapa>`        por la conexion DEL OTRO
JUGADORES = {}                    # nombre en minusculas -> sesion
lock_jug = threading.Lock()


def avisar(ses, texto):
    """Mete un PLAYERMSG hacia el cliente, como si lo mandara el servidor."""
    cli = ses.get('cli')
    if not cli:
        return
    try:
        cli.sendall(SEP.join([b'PLAYERMSG', texto.encode('latin1', 'replace'), b'13', b'']) + END)
    except Exception:
        pass


def anotar_jugador(pkt, ses):
    """Aprende de los paquetes del servidor quien es esta conexion y donde esta."""
    f = pkt.split(SEP)
    cmd = f[0].upper()
    if cmd == b'LOGINOK' and len(f) > 1:
        ses['indice'] = f[1].strip()
        log(f'  ~ conexion identificada: indice {ses["indice"]!r}')
        return
    if cmd != b'PLAYERDATA' or len(f) < 5:
        return
    # El servidor manda PLAYERDATA de TODOS los del mapa por cada conexion, asi
    # que solo sirve el que lleva el indice de esta conexion.
    if not ses.get('indice') or f[1].strip() != ses['indice']:
        return
    mapa = f[4].strip()                       # se queda en bytes: va tal cual al server
    nombre = f[2].strip().decode('latin1', 'replace')
    if not nombre or mapa in (b'', b'0'):
        return                     # mapa 0 = esta saliendo del mapa, no es sitio
    anterior = ses.get('nombre')
    if ses.get('mapa') != mapa or anterior != nombre:
        log(f'  ~ {nombre} esta en el mapa {mapa.decode("latin1")}')
    ses['nombre'], ses['mapa'] = nombre, mapa
    ses['x'], ses['y'] = f[5].strip(), f[6].strip()
    with lock_jug:
        if anterior and anterior.lower() != nombre.lower():
            JUGADORES.pop(anterior.lower(), None)
        # La clave es TEXTO en minusculas. Ojo: si se guarda en bytes, la
        # busqueda de interceptar_warp (que compara con texto) no encuentra
        # nunca a nadie y todo el mundo parece desconectado.
        JUGADORES[nombre.lower()] = ses


def interceptar_warp(pkt, ses):
    """Traduce WARPMETO/WARPTOME. Devuelve el paquete a reenviar, o None."""
    f = pkt.split(SEP)
    cmd = f[0].upper()
    if cmd not in (b'WARPMETO', b'WARPTOME'):
        return pkt
    quien = f[1].strip().decode('latin1', 'replace') if len(f) > 1 else ''
    if not quien:
        avisar(ses, 'Falta el nombre del jugador.')
        return None
    with lock_jug:
        otro = JUGADORES.get(quien.lower())
    if otro is None or not otro.get('mapa'):
        avisar(ses, f'{quien} no esta conectado.')
        return None
    if otro is ses:
        avisar(ses, 'Ya estas donde estas.')
        return None

    # `warpto` SOLO acepta el numero de mapa: te deja en las coordenadas que ya
    # tenias. Comprobado que ni `warpto mapa x y` ni `warp mapa x y` mueven, asi
    # que el servidor no tiene forma de colocarte. Y aterrizar a ciegas es lo
    # que dejaba a la gente encerrada dentro de una roca.
    #
    # Quien si sabe que casillas estan bloqueadas es el CLIENTE WEB: lleva los
    # 210 mapas en memoria. Asi que en vez de warpear aqui, se le manda a quien
    # tenga que moverse un DBOWARP con el destino, y el se coloca solo.
    if cmd == b'WARPMETO':
        destino, quien_va, etiqueta = otro, ses, 'vas tu'
    else:
        if not ses.get('mapa'):
            avisar(ses, 'Todavia no se en que mapa estas.')
            return None
        destino, quien_va, etiqueta = ses, otro, 'va el otro'

    # Cerrojo: mover a la cuenta equivocada es lo peor que puede hacer esto, y
    # las sesiones se emparejan por el indice que da LOGINOK, que el servidor
    # reasigna en cada reconexion (se ha visto pasar de 1 a 6). Si el indice se
    # cruzara, el DBOWARP acabaria en otro jugador. Antes de mandarlo se
    # comprueba que el destinatario es de verdad quien toca.
    esperado = quien if cmd == b'WARPTOME' else ses.get('nombre')
    if not quien_va.get('nombre') or quien_va['nombre'].lower() != (esperado or '').lower():
        log(f'  !! {cmd.decode()} {quien}: destinatario inesperado '
            f'({quien_va.get("nombre")!r} en vez de {esperado!r}), no se manda nada')
        avisar(ses, 'No pude identificar a ese jugador con seguridad.')
        return None

    try:
        # Va tambien el nombre: el cliente sigue al objetivo en vivo, porque
        # para cuando termine de caminar el otro ya se habra movido.
        quien_va['cli'].sendall(SEP.join([
            b'DBOWARP', destino['mapa'],
            destino.get('x') or b'0', destino.get('y') or b'0',
            (destino.get('nombre') or '').encode('latin1', 'replace'), b'']) + END)
        log(f'  ~ {cmd.decode()} {quien}: DBOWARP mapa {destino["mapa"].decode()} '
            f'({destino.get("x", b"?").decode()},{destino.get("y", b"?").decode()}) [{etiqueta}]')
        if cmd == b'WARPTOME':
            avisar(ses, f'{quien} viene hacia ti.')
    except Exception as e:
        log(f'  !! {cmd.decode()} {quien}: {e}')
        avisar(ses, f'No se pudo mover a {quien}.')
    return None

# paquetes cuyo contenido completo se vuelca al log, para diagnosticar
WATCH = {b'LOGINOK', b'loginok', b'UPDATEITEM', b'PLAYERWORNEQ', b'itemworn', b'PLAYERINV',
         b'PLAYERSTATSPACKET', b'PLAYERHP', b'PLAYERMP', b'PLAYERSP',
         b'PLAYERPOINTS', b'PLAYERDATA'}
# todo lo que el cliente manda se registra (es poco y revela los comandos)
WATCH_UP = True


def log(line):
    with lock:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
        print(line, flush=True)


def drop_field(pkt, stride, idx):
    """Quita el campo `idx` de cada registro de clase.

    Formato: CMD, count, [ stride campos ] x (count+1), '' final.
    Devuelve el paquete intacto si no encaja con ese formato, para no romper
    nada que no entendamos.
    """
    f = pkt.split(SEP)
    if len(f) < 3:
        return pkt
    try:
        n = int(f[1]) + 1                      # count es el indice maximo
    except ValueError:
        return pkt
    body, tail = f[2:2 + stride * n], f[2 + stride * n:]
    if len(body) != stride * n:
        return pkt                              # longitud inesperada: no tocar
    out = []
    for k in range(n):
        rec = body[k * stride:(k + 1) * stride]
        out += rec[:idx] + rec[idx + 1:]
    return SEP.join(f[:2] + out + tail)


def pump(src, dst, tag, fix, ses):
    buf = b''
    try:
        while True:
            d = src.recv(65536)
            if not d:
                break
            buf += d
            out = b''
            while END in buf:
                pkt, buf = buf.split(END, 1)
                if not pkt:
                    continue
                if fix and ARREGLAR:
                    cmd = pkt.split(SEP)[0]
                    if cmd in FIX_REC:
                        stride, idx = FIX_REC[cmd]
                        new = drop_field(pkt, stride, idx)
                        if new != pkt:
                            log(f'  ~ {cmd.decode()}: {stride} -> {stride-1} campos por '
                                f'registro (quitado Luck)')
                        pkt = new
                    elif cmd in FIX_FLAT:
                        f = pkt.split(SEP)
                        i = FIX_FLAT[cmd]
                        if len(f) > i + 1:
                            pkt = SEP.join(f[:i] + f[i + 1:])
                            log(f'  ~ {cmd.decode()}: quitado el campo {i} (Luck)')
                if not fix and ARREGLAR and pkt.split(SEP)[0] == b'logination':
                    f = pkt.split(SEP)
                    if len(f) > 9:
                        cambios = []
                        if tuple(f[3:6]) != VERSION_OK:
                            cambios.append('version ' + b'.'.join(f[3:6]).decode('latin1', 'replace'))
                            f[3:6] = list(VERSION_OK)
                        if tuple(f[6:10]) != RELLENO_OK:
                            cambios.append('relleno')
                            f[6:10] = list(RELLENO_OK)
                        if cambios:
                            pkt = SEP.join(f)
                            log('  ~ logination: corregido ' + ' y '.join(cambios))

                cmd0 = pkt.split(SEP)[0]
                if VERBOSE or cmd0 in WATCH or (WATCH_UP and not fix):
                    fl = [c.decode('latin1', 'replace') for c in pkt.split(SEP)]
                    cuerpo = ' | '.join(f'{i}:{v[:40]!r}' for i, v in enumerate(fl[1:], 1))
                    log(f'{tag} [{fl[0][:30]}] n={len(fl)}  {cuerpo[:1400]}')

                if fix:
                    anotar_jugador(pkt, ses)     # quien es y donde esta
                else:
                    pkt = interceptar_warp(pkt, ses)
                    if pkt is None:
                        continue                 # resuelto aqui: no llega al servidor
                out += pkt + END
            if out:
                dst.sendall(out)
    except Exception as e:
        log(f'{tag} !! {e}')
    finally:
        # Al caerse la conexion el jugador deja de estar localizable, o
        # WARPTOME intentaria escribir en un socket muerto.
        nombre = ses.get('nombre')
        if nombre:
            with lock_jug:
                if JUGADORES.get(nombre.lower()) is ses:
                    del JUGADORES[nombre.lower()]
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass


def handle(c, addr):
    log(f'\n===== conexion {addr} =====')
    try:
        u = socket.create_connection(UPSTREAM, timeout=10)
        u.settimeout(None)
        c.settimeout(None)
    except Exception as e:
        log(f'!! sin servidor en {UPSTREAM}: {e}')
        c.close()
        return
    # Estado compartido por los dos sentidos de ESTA conexion. `up` es por donde
    # se le habla al servidor en nombre de este jugador: es lo que permite que
    # WARPTOME mueva a otro.
    ses = {'cli': c, 'up': u, 'indice': None, 'nombre': None, 'mapa': None}
    threading.Thread(target=pump, args=(c, u, 'C->S', False, ses), daemon=True).start()
    threading.Thread(target=pump, args=(u, c, 'S->C', True, ses), daemon=True).start()


if __name__ == '__main__':
    open(LOG, 'w').close()
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(5)
    modo = 'con arreglos de Dreaminze 1.3' if ARREGLAR else 'CRUDO (sin tocar nada)'
    log(f'adaptador  {LISTEN[0]}:{LISTEN[1]} -> {UPSTREAM[0]}:{UPSTREAM[1]}   {modo}')
    while True:
        c, a = srv.accept()
        threading.Thread(target=handle, args=(c, a), daemon=True).start()
