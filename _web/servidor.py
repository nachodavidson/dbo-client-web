"""Servidor web local para desarrollo.

Igual que `python -m http.server` pero con dos diferencias que importan:

1. Manda cabeceras que PROHIBEN la cache. Sin esto el navegador se queda con
   modulos JavaScript viejos y aparecen errores fantasma del tipo
   "X is not a function" tras editar un archivo.
2. Sirve SIEMPRE la carpeta de este archivo, no desde donde se lo lanzo. Si no,
   arrancandolo desde otra carpeta el navegador mostraba el listado de esa otra
   carpeta en vez del juego.
"""
import http.server, socketserver, sys, os

RAIZ = os.path.dirname(os.path.abspath(__file__))

PUERTO = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

# Por defecto escucha en todas las interfaces para que se pueda entrar desde
# otro equipo (por la VPN). El puente de WebSocket del 4002 ya lo hacia. Para
# dejarlo solo en esta maquina:  python servidor.py 8080 127.0.0.1
DIRECCION = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'


class SinCache(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=RAIZ, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, formato, *args):
        pass                        # sin ruido en la consola


if __name__ == '__main__':
    # OJO: nada de `allow_reuse_address`. Con eso, si habia otro proceso
    # colgado en el mismo puerto, este arrancaba "bien" pero no contestaba
    # ninguna peticion: parecia que el servidor andaba y el navegador se
    # quedaba esperando para siempre. Mejor que falle a la vista.
    try:
        servidor = socketserver.TCPServer((DIRECCION, PUERTO), SinCache)
    except OSError as e:
        print('')
        print(f'  No se pudo abrir el puerto {PUERTO}: {e}', flush=True)
        print('  Seguramente hay otro proceso usandolo. Para ver cual:', flush=True)
        print(f'    netstat -ano | findstr :{PUERTO}', flush=True)
        print('  y cerralo desde el Administrador de tareas por su PID.', flush=True)
        print('')
        input('  Enter para salir...')
        sys.exit(1)

    with servidor as s:
        print(f'Dream Blue Online (web) -> http://127.0.0.1:{PUERTO}', flush=True)
        if DIRECCION == '0.0.0.0':
            print(f'  desde otro equipo: http://<este-equipo>:{PUERTO}', flush=True)
        s.serve_forever()
