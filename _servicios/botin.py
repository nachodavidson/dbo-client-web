"""Recolector: saca del trafico todo lo que el servidor cuenta del juego.

Se engancha al adaptador y va acumulando en un JSON lo que pasa por delante.
Pensado para un servidor AJENO del que no tenemos el codigo: no supone nada,
apunta lo que reconoce y DEJA CONSTANCIA de lo que no, para poder adaptarlo.

Lo que se puede sacar, y lo que no
----------------------------------
Al entrar, el servidor empuja su catalogo entero sin que nadie lo pida. Pero
no manda lo mismo de cada cosa, y la diferencia no es un capricho:

    UPDATEITEM    24 campos   el REGISTRO COMPLETO del objeto
    UPDATENPC      5 campos   num, nombre, sprite, es grande, vida maxima
    UPDATESPELL    2 campos   num, nombre

El cliente necesita el objeto entero para pintar el globo de estadisticas y
decidir si puedes equipartelo. De una criatura solo necesita dibujarla y
ponerle la barra de vida: el combate lo resuelve el servidor. Asi que la
fuerza, la defensa, la experiencia que da, lo que suelta y cada cuanto
reaparece NO VIAJAN NUNCA. No hay interceptor que los saque.

Y tampoco hay atajo por el editor: `REQUESTEDITNPC` contesta `NPCEDITOR` a
secas, sin datos. Es un permiso, no una consulta; el editor del cliente se
rellena con lo que ya tiene.

Lo que si se puede, y este modulo hace, es DEDUCIRLO de la partida:

    en que mapas aparece      MAPNPCDATA / SPAWNNPC con el mapa actual
    cuanto pega               BLITNPCDMG mientras esa criatura te ataca
    cuanto aguanta            BLITPLAYERDMG acumulado hasta NPCDEAD
    que experiencia da        damagedisplay "Has ganado N Puntos..." tras matarla
    que suelta                SPAWNITEM justo despues de NPCDEAD

Eso sale de jugar, no de pedirlo. Es incompleto por definicion, pero es real.

Uso: lo arranca el adaptador con `--botin fichero.json`.
"""
import json, os, re, threading, time

SEP = b'\x00'

# Paquetes cuyo contenido ES el catalogo: llegan solos al entrar.
# num -> campos, tal cual los manda el servidor.
CATALOGO = {
    b'UPDATEITEM':     ('objetos', ['num', 'nombre', 'pic', 'tipo', 'data1', 'data2', 'data3',
                                    'fuerzaReq', 'defensaReq', 'velocidadReq', 'claseReq',
                                    'accesoReq', 'addHP', 'addMP', 'addSP', 'addFuerza',
                                    'addDefensa', 'addMagia', 'addVelocidad', 'addEXP',
                                    'descripcion', 'durabilidad']),
    b'UPDATENPC':      ('criaturas', ['num', 'nombre', 'sprite', 'grande', 'vidaMaxima']),
    b'UPDATESPELL':    ('magias', ['num', 'nombre']),
    b'UPDATEARROW':    ('flechas', ['num', 'nombre', 'pic', 'alcance']),
    b'UPDATEEMOTICON': ('emoticonos', ['num', 'nombre', 'pic']),
}

# "Has ganado 7846 Puntos de experiencia."
EXP = re.compile(r'ganado\s+([\d.]+)\s+puntos', re.I)

# Paquetes que conocemos y que NO traen catalogo: no aportan nada al botin,
# pero tampoco son una sorpresa. Se callan para que "desconocidos" sirva de
# lo que tiene que servir: avisar de lo que este servidor hace distinto.
SABIDOS = {
    'LOGINOK', 'INGAME', 'ALLCHARS', 'MAXINFO', 'HIGHINDEX', 'CLASSESDATA',
    'NEWCHARCLASSES', 'CHECKFORMAP', 'MAPDATA', 'NEEDMAP', 'ONLINELIST',
    'PLAYERDATA', 'PLAYERINV', 'PLAYERINVUPDATE', 'PLAYERWORNEQ', 'PLAYERBANK',
    'PLAYERBANKUPDATE', 'PLAYERHP', 'PLAYERMP', 'PLAYERSP', 'PLAYERPOINTS',
    'PLAYERSTATSPACKET', 'PLAYERMOVE', 'PLAYERDIR', 'PLAYERXY', 'ITEMWORN',
    'NPCMOVE', 'NPCDIR', 'NPCATTACK', 'ATTRIBUTENPCMOVE', 'ATTRIBUTENPCDIR',
    'ATTRIBUTENPCATTACK', 'ATTRIBUTENPCHP', 'GLOBALMSG', 'BROADCASTMSG',
    'ADMINMSG', 'SAYMSG', 'GUILDMSG', 'EMOTEMSG', 'PLAINMSG', 'MAPMSG2',
    'SOUND', 'TIME', 'WEATHER', 'LEVELUP', 'SPELLANIM', 'ITEMBREAK',
    'MAPITEMDATA', 'ITEMEDITOR', 'NPCEDITOR', 'SPELLEDITOR', 'SHOPEDITOR',
    'MAPEDITOR', 'EMOTICONEDITOR', 'ARROWEDITOR', 'MAXINFO', 'BANKMSG',
    'OPENBANK', 'NPCHP', 'MENSAJE', 'PROFILE', 'ALERTMSG',
}


class Botin:
    def __init__(self, ruta, avisar=print):
        self.ruta = ruta
        self.avisar = avisar
        self.lock = threading.Lock()
        self.sucio = False
        self.datos = self._cargar()
        threading.Thread(target=self._guardar_cada_tanto, daemon=True).start()

    def _cargar(self):
        if os.path.exists(self.ruta):
            try:
                with open(self.ruta, encoding='utf-8') as f:
                    d = json.load(f)
                self.avisar(f'  ~ botin: continuo el de antes ({self.ruta})')
                return d
            except Exception as e:
                self.avisar(f'  !! botin ilegible, empiezo de cero: {e}')
        return {'objetos': {}, 'criaturas': {}, 'magias': {}, 'flechas': {},
                'emoticonos': {}, 'mapas': {}, 'desconocidos': {}}

    # --- escritura ---------------------------------------------------------
    def _guardar_cada_tanto(self):
        while True:
            time.sleep(5)
            self.guardar()

    def guardar(self):
        with self.lock:
            if not self.sucio:
                return
            tmp = self.ruta + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.datos, f, ensure_ascii=False, indent=1, sort_keys=True)
            os.replace(tmp, self.ruta)       # atomico: nunca queda a medias
            self.sucio = False

    def resumen(self):
        d = self.datos
        obs = sum(1 for c in d['criaturas'].values() if c.get('visto'))
        return (f"objetos {len(d['objetos'])} · criaturas {len(d['criaturas'])}"
                f" ({obs} vistas en juego) · magias {len(d['magias'])}"
                f" · mapas {len(d['mapas'])} · paquetes sin reconocer {len(d['desconocidos'])}")

    # --- lectura del trafico ----------------------------------------------
    def mira(self, pkt, ses):
        """Un paquete del SERVIDOR. `ses` trae el mapa en el que estamos."""
        try:
            self._mira(pkt, ses)
        except Exception as e:
            self.avisar(f'  !! botin: {e}')

    def _mira(self, pkt, ses):
        f = [c.decode('latin1', 'replace') for c in pkt.split(SEP)]
        cmd = f[0].upper().encode('latin1')
        cuerpo = [v.strip() for v in f[1:]]
        while cuerpo and cuerpo[-1] == '':
            cuerpo.pop()

        if cmd in CATALOGO:
            self._catalogo(cmd, cuerpo)
            return

        nombre = cmd.decode('latin1')
        if nombre == 'MAPNPCDATA':
            self._mapa_npcs(cuerpo, ses)
        elif nombre in ('SPAWNNPC', 'NPCDATA'):
            self._spawn(cuerpo, ses)
        elif nombre == 'NPCHP':
            self._vida(cuerpo, ses)
        elif nombre == 'BLITNPCDMG':
            self._pega_npc(cuerpo, ses)
        elif nombre == 'BLITPLAYERDMG':
            self._pego_yo(cuerpo, ses)
        elif nombre == 'NPCDEAD':
            self._muere(cuerpo, ses)
        elif nombre in ('DAMAGEDISPLAY', 'PLAYERMSG', 'MAPMSG', 'ALERTMSG'):
            self._texto(cuerpo, ses)
        elif nombre == 'SPAWNITEM':
            self._suelta(cuerpo, ses)
        elif nombre not in SABIDOS:
            self._desconocido(nombre, cuerpo)

    # --- catalogo ----------------------------------------------------------
    def _catalogo(self, cmd, cuerpo):
        seccion, campos = CATALOGO[cmd]
        if not cuerpo:
            return
        num = cuerpo[0]
        reg = dict(zip(campos, cuerpo))
        # Si el servidor manda MAS campos de los que conocemos, no se tiran: se
        # guardan con su indice. Es un servidor ajeno y puede haber crecido.
        if len(cuerpo) > len(campos):
            reg['extra'] = {str(i): v for i, v in enumerate(cuerpo[len(campos):], len(campos))}
        with self.lock:
            viejo = self.datos[seccion].get(num, {})
            visto = viejo.get('visto')          # lo observado no se pisa
            reg.update({k: v for k, v in viejo.items() if k not in reg})
            if visto:
                reg['visto'] = visto
            if self.datos[seccion].get(num) != reg:
                self.datos[seccion][num] = reg
                self.sucio = True

    # --- observado ---------------------------------------------------------
    def _crea_visto(self, num):
        c = self.datos['criaturas'].setdefault(num, {'num': num})
        return c.setdefault('visto', {'mapas': [], 'pegaA': [], 'aguanto': [],
                                      'experiencia': [], 'suelta': []})

    def _mapa_npcs(self, cuerpo, ses):
        """MAPNPCDATA: ranuras de num,x,y,dir. Dice QUE criaturas hay aqui."""
        mapa = ses.get('mapa_txt')
        if not mapa:
            return
        nums = [cuerpo[i] for i in range(0, len(cuerpo) - 3, 4)]
        nums = sorted({n for n in nums if n and n != '0'}, key=lambda x: int(x) if x.isdigit() else 0)
        with self.lock:
            m = self.datos['mapas'].setdefault(mapa, {})
            if m.get('criaturas') != nums:
                m['criaturas'] = nums
                self.sucio = True
            for n in nums:
                v = self._crea_visto(n)
                if mapa not in v['mapas']:
                    v['mapas'].append(mapa)
                    self.sucio = True
            # ranura -> num, para saber a quien se refiere un BLIT o un NPCDEAD
            ses['ranuras'] = {str(i // 4 + 1): cuerpo[i] for i in range(0, len(cuerpo) - 3, 4)}

    def _spawn(self, cuerpo, ses):
        if len(cuerpo) >= 2:
            ses.setdefault('ranuras', {})[cuerpo[0]] = cuerpo[1]

    def _quien(self, ranura, ses):
        return (ses.get('ranuras') or {}).get(str(ranura))

    def _vida(self, cuerpo, ses):
        """NPCHP <ranura> <actual> <maxima>: confirma la vida de esa criatura.

        UPDATENPC ya la trae, pero en un servidor ajeno puede no venir, o venir
        en otro campo. Esto lo comprueba contra lo que de verdad se ve en juego.
        """
        if len(cuerpo) < 3:
            return
        num = self._quien(cuerpo[0], ses)
        if not num:
            return
        with self.lock:
            c = self.datos['criaturas'].setdefault(num, {'num': num})
            if c.get('vidaMaxima') != cuerpo[2]:
                c.setdefault('visto', {}).setdefault('mapas', [])
                c['visto']['vidaMaximaVista'] = cuerpo[2]
                self.sucio = True

    def _pega_npc(self, cuerpo, ses):
        """BLITNPCDMG <cantidad>: lo que me acaba de pegar el que me ataca."""
        if not cuerpo:
            return
        num = ses.get('ultimo_atacante')
        if not num:
            return
        with self.lock:
            v = self._crea_visto(num)
            d = cuerpo[0]
            if d not in v['pegaA']:
                v['pegaA'].append(d)
                self.sucio = True

    def _pego_yo(self, cuerpo, ses):
        """BLITPLAYERDMG <cantidad> <ranura>: lo que le saco yo a esa criatura."""
        if len(cuerpo) < 2:
            return
        num = self._quien(cuerpo[1], ses)
        if not num:
            return
        acum = ses.setdefault('dano', {})
        acum[num] = acum.get(num, 0) + int(cuerpo[0] or 0)
        ses['ultimo_golpeado'] = num

    def _muere(self, cuerpo, ses):
        """NPCDEAD <ranura>: cierra la cuenta de lo que aguanto."""
        if not cuerpo:
            return
        num = self._quien(cuerpo[0], ses)
        if not num:
            return
        total = (ses.get('dano') or {}).pop(num, None)
        ses['ultimo_muerto'] = num
        if not total:
            return
        with self.lock:
            v = self._crea_visto(num)
            if total not in v['aguanto']:
                v['aguanto'].append(total)
                self.sucio = True

    def _suelta(self, cuerpo, ses):
        """SPAWNITEM justo despues de una muerte: es el botin de esa criatura."""
        num = ses.get('ultimo_muerto')
        if not num or len(cuerpo) < 2:
            return
        with self.lock:
            v = self._crea_visto(num)
            objeto = cuerpo[1]
            if objeto not in v['suelta']:
                v['suelta'].append(objeto)
                self.sucio = True

    def _texto(self, cuerpo, ses):
        """Las frases del servidor dicen cosas que ningun campo dice."""
        linea = ' '.join(cuerpo)
        m = EXP.search(linea)
        if m and ses.get('ultimo_muerto'):
            with self.lock:
                v = self._crea_visto(ses['ultimo_muerto'])
                exp = m.group(1).replace('.', '')
                if exp not in v['experiencia']:
                    v['experiencia'].append(exp)
                    self.sucio = True
        # "<criatura> te ataca" / "Golpeas a <criatura>" ayudan a saber quien pega
        for num, c in self.datos['criaturas'].items():
            n = c.get('nombre')
            if n and len(n) > 2 and n.lower() in linea.lower():
                ses['ultimo_atacante'] = num
                break

    def _desconocido(self, nombre, cuerpo):
        """Lo que no reconocemos NO se tira: es la pista para adaptarnos a
        un servidor que no conocemos."""
        with self.lock:
            d = self.datos['desconocidos']
            if nombre in d:
                d[nombre]['veces'] += 1
                self.sucio = True
                return
            d[nombre] = {'veces': 1, 'campos': len(cuerpo), 'ejemplo': cuerpo[:12]}
            self.sucio = True
            self.avisar(f'  ~ botin: paquete nuevo [{nombre}] con {len(cuerpo)} campos')
