// Conexion con el servidor a traves del puente WebSocket.
//
// El protocolo es el mismo del juego original (un fork de Mirage Source):
// campos separados por Chr(0) y paquete terminado en Chr(237). Texto plano.
// El puente reenvia el flujo de bytes tal cual, asi que aqui se reconstruyen
// los paquetes igual que lo haria el cliente de VB6.

const SEP = 0x00;
const FIN = 237;

// Relleno que el servidor valida como "cliente original". El adaptador lo
// reescribe de todos modos, pero se manda coherente por si algun dia se
// conecta directo.
const RELLENO = ['p'.repeat(120), 'a'.repeat(120), 'b'.repeat(118), '4'.repeat(107)];

export class Red extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.conectado = false;
  }

  conectar() {
    return new Promise((ok, err) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => { this.conectado = true; ok(); };
      ws.onerror = () => err(new Error('no se pudo conectar al puente'));
      ws.onclose = () => {
        this.conectado = false;
        this.dispatchEvent(new CustomEvent('cerrado'));
      };
      ws.onmessage = (ev) => this._entrada(new Uint8Array(ev.data));
    });
  }

  _entrada(trozo) {
    const nuevo = new Uint8Array(this.buf.length + trozo.length);
    nuevo.set(this.buf); nuevo.set(trozo, this.buf.length);
    this.buf = nuevo;

    let ini = 0;
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i] !== FIN) continue;
      const crudo = this.buf.subarray(ini, i);
      ini = i + 1;
      if (crudo.length === 0) continue;
      this._paquete(crudo);
    }
    this.buf = this.buf.subarray(ini);
  }

  _paquete(crudo) {
    const campos = [];
    let ini = 0;
    for (let i = 0; i <= crudo.length; i++) {
      if (i === crudo.length || crudo[i] === SEP) {
        campos.push(latin1(crudo.subarray(ini, i)));
        ini = i + 1;
      }
    }
    const cmd = campos[0];
    this.dispatchEvent(new CustomEvent('paquete', { detail: { cmd, campos } }));
    // El servidor no es coherente con las mayusculas: manda `NPCMOVE` pero
    // `npchp`, `PLAYERDATA` pero `saymsg`. Se normaliza a mayusculas para que
    // un cambio de capitalizacion no deje un paquete sin atender en silencio.
    this.dispatchEvent(new CustomEvent(cmd.toUpperCase(), { detail: campos }));
  }

  enviar(...campos) {
    if (!this.conectado) return;
    const texto = campos.map(String).join('\0') + '\0';
    const bytes = new Uint8Array(texto.length + 1);
    for (let i = 0; i < texto.length; i++) bytes[i] = texto.charCodeAt(i) & 0xFF;
    bytes[texto.length] = FIN;
    this.ws.send(bytes);
  }

  cerrar() { try { this.ws && this.ws.close(); } catch (e) {} }

  // --- mensajes concretos del juego ---
  login(cuenta, clave) { this.enviar('logination', cuenta, clave, 3, 1, 121, ...RELLENO); }
  elegirPersonaje(n)   { this.enviar('usagakarim', n); }
  // Cuentas y personajes. Los nombres de los comandos vienen revueltos a
  // proposito en este motor (`newaccount` -> `newfaccountied`); son los que
  // lleva dentro el server.exe y los que acepta, comprobado uno por uno.
  //
  // Crear y borrar cuenta NO necesitan haber entrado: se hacen sobre una
  // conexion recien abierta y el servidor contesta con un `mensaje`.
  crearCuenta(cuenta, clave)  { this.enviar('newfaccountied', cuenta, clave); }
  borrarCuenta(cuenta, clave) { this.enviar('delimaccounted', cuenta, clave); }
  pedirClases()               { this.enviar('gatglasses'); }
  // sexo 0 = varon (usa MaleSprite de la clase), 1 = mujer (FemaleSprite).
  // La ranura va de 1 a 3, como las secciones [CHAR1..3] del fichero de cuenta.
  crearPersonaje(nombre, sexo, clase, ranura) { this.enviar('addachara', nombre, sexo, clase, ranura); }
  borrarPersonaje(ranura)     { this.enviar('delimbocharu', ranura); }
  pedirMapa(tengo)     { this.enviar('needmap', tengo ? 'no' : 'yes'); }
  mover(dir, correr)   { this.enviar('playermove', dir, correr ? 2 : 1); }
  mirar(dir)           { this.enviar('playerdir', dir); }
  atacar()             { this.enviar('attack'); }
  decir(texto)         { this.enviar('saymsg', texto); }
  recoger()            { this.enviar('mapgetitem'); }
  buscar(x, y)         { this.enviar('search', x, y); }
  lanzar(ranura)       { this.enviar('cast', ranura); }
  pedirHechizos()      { this.enviar('spells'); }
  refrescar()          { this.enviar('refresh'); }
  privado(a, texto)    { this.enviar('playermsg', a, texto); }
  alClan(texto)        { this.enviar('guildmsg', texto); }
  // El cliente pregunta al servidor si un /comando que no conoce existe.
  comandoDesconocido(c){ this.enviar('checkcommands', c); }
  // La flecha la vuela el CLIENTE; al servidor solo se le dice donde cayo.
  // tipo 1 = cayo sobre una criatura, 0 = cayo en el suelo.
  flechaCayo(tipo, num, x, y) { this.enviar('arrowhit', tipo, num, x, y); }
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
