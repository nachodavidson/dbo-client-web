"""Puente WebSocket para el cliente web de Dream Blue Online.

Los navegadores no pueden abrir sockets TCP crudos, asi que este puente traduce:

    navegador  --WebSocket-->  :4002 [este puente]  --TCP-->  :4000 [adapter.py]
                                                                  |
                                                                  v  :4001
                                                              server.exe

Se conecta al adaptador, no al servidor directo, para reutilizar sus arreglos
(version del login, relleno anti-trampas, campo Suerte de mas) sin duplicarlos.

El flujo de bytes del juego se reenvia tal cual en tramas binarias; el cliente
web parte por el terminador Chr(237) igual que haria el cliente original.

Sin dependencias: el handshake y el framing van implementados a mano.
"""
import socket, threading, base64, hashlib, struct, sys

ESCUCHA = ('0.0.0.0', 4002)
JUEGO = ('127.0.0.1', 4000)
GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'   # constante del RFC 6455


def leer_cabeceras(sock):
    datos = b''
    while b'\r\n\r\n' not in datos:
        trozo = sock.recv(4096)
        if not trozo:
            return None, b''
        datos += trozo
        if len(datos) > 65536:
            return None, b''
    cab, resto = datos.split(b'\r\n\r\n', 1)
    lineas = cab.decode('latin1', 'replace').split('\r\n')
    campos = {}
    for l in lineas[1:]:
        if ':' in l:
            k, v = l.split(':', 1)
            campos[k.strip().lower()] = v.strip()
    return campos, resto


def handshake(sock):
    campos, _ = leer_cabeceras(sock)
    if not campos or 'sec-websocket-key' not in campos:
        sock.sendall(b'HTTP/1.1 400 Bad Request\r\n\r\n')
        return False
    clave = campos['sec-websocket-key'].encode()
    acepta = base64.b64encode(hashlib.sha1(clave + GUID).digest()).decode()
    sock.sendall(
        b'HTTP/1.1 101 Switching Protocols\r\n'
        b'Upgrade: websocket\r\n'
        b'Connection: Upgrade\r\n'
        b'Sec-WebSocket-Accept: ' + acepta.encode() + b'\r\n\r\n')
    return True


def _recv_exacto(sock, n):
    buf = b''
    while len(buf) < n:
        t = sock.recv(n - len(buf))
        if not t:
            return None
        buf += t
    return buf


def leer_trama(sock):
    """Devuelve (opcode, payload) o (None, None) si se cerro."""
    cab = _recv_exacto(sock, 2)
    if not cab:
        return None, None
    op = cab[0] & 0x0F
    enmascarado = cab[1] & 0x80
    largo = cab[1] & 0x7F
    if largo == 126:
        ext = _recv_exacto(sock, 2)
        if not ext: return None, None
        largo = struct.unpack('>H', ext)[0]
    elif largo == 127:
        ext = _recv_exacto(sock, 8)
        if not ext: return None, None
        largo = struct.unpack('>Q', ext)[0]
    mascara = _recv_exacto(sock, 4) if enmascarado else None
    if enmascarado and mascara is None:
        return None, None
    carga = _recv_exacto(sock, largo) if largo else b''
    if carga is None:
        return None, None
    if mascara:
        carga = bytes(b ^ mascara[i & 3] for i, b in enumerate(carga))
    return op, carga


def escribir_trama(sock, carga, op=0x2):
    n = len(carga)
    if n < 126:
        cab = struct.pack('>BB', 0x80 | op, n)
    elif n < 65536:
        cab = struct.pack('>BBH', 0x80 | op, 126, n)
    else:
        cab = struct.pack('>BBQ', 0x80 | op, 127, n)
    sock.sendall(cab + carga)


def del_juego_al_navegador(tcp, ws, vivo):
    try:
        while vivo[0]:
            d = tcp.recv(65536)
            if not d:
                break
            escribir_trama(ws, d)
    except Exception:
        pass
    finally:
        vivo[0] = False
        try: ws.shutdown(socket.SHUT_RDWR)
        except Exception: pass


def atender(ws, addr):
    print(f'[ws] conexion de {addr}', flush=True)
    vivo = [True]
    tcp = None
    try:
        if not handshake(ws):
            return
        tcp = socket.create_connection(JUEGO, timeout=10)
        tcp.settimeout(None)
        threading.Thread(target=del_juego_al_navegador,
                         args=(tcp, ws, vivo), daemon=True).start()
        while vivo[0]:
            op, carga = leer_trama(ws)
            if op is None or op == 0x8:          # cerrado
                break
            if op == 0x9:                         # ping -> pong
                escribir_trama(ws, carga, op=0xA)
                continue
            if op in (0x1, 0x2) and carga:
                tcp.sendall(carga)
    except Exception as e:
        print(f'[ws] {addr} error: {e}', flush=True)
    finally:
        vivo[0] = False
        for s in (ws, tcp):
            if s:
                try: s.close()
                except Exception: pass
        print(f'[ws] fin de {addr}', flush=True)


if __name__ == '__main__':
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(ESCUCHA)
    srv.listen(8)
    print(f'puente WebSocket {ESCUCHA} -> juego {JUEGO}', flush=True)
    while True:
        c, a = srv.accept()
        threading.Thread(target=atender, args=(c, a), daemon=True).start()
