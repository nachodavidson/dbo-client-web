import { cargarMapas, ANCHO, ALTO, TS, tipoEn, datoEn, idx, esSolido } from './maps.js';
import { Render } from './render.js';
import { Actor, DIR } from './sprite.js';
import { Audio2 } from './audio.js';
import { Red } from './red.js';
import { Interfaz, COLS_INV, FILAS_INV, CELDA_INV, SITIOS_EQUIPO } from './ui.js';
import { Musica } from './midi.js';
import { Efectos, color } from './efectos.js';

const MS_POR_CASILLA = 150;     // velocidad de caminata (ajustable en vivo)
const HOJAS_TILES = 7;

const $ = (s) => document.querySelector(s);
const estado = {
  mapas: null, mapa: null, jugador: null, otros: new Map(),
  render: null, audio: null, msPorCasilla: MS_POR_CASILLA,
  red: null, miIndice: null, enLinea: false, hojaSprites: null,
  npcDefs: new Map(), npcs: new Map(),   // definiciones y los vivos en el mapa
  hojaGrandes: null, musica: null,
  ui: null, clases: [], miClase: 0,
  efectos: null, suelo: new Map(),     // objetos tirados: ranura -> {num,pic,x,y}
  flechas: new Map(),                  // definiciones de flecha: num -> {pic, alcance}
  hechizos: [], hechizoElegido: 0,
  hojaItems: null,                     // hoja de objetos, para vestir a cualquiera
  equipoDe: new Map(),                 // indice de jugador -> `pic` de sus 7 ranuras
  diagWarp: [],                        // caja negra de los saltos de mapa
  // --- registro: cuenta, personajes y razas ---
  cuenta: '', clave: '',               // lo tecleado, para volver a entrar solo
  ranuras: [],                         // las 3 de ALLCHARS: {nombre, clase, nivel}
  ranuraSel: 1,
  razas: [],                           // NEWCHARCLASSES completo, para el formulario
  cerrandoAdrede: false,               // para no gritar "se perdio la conexion"
};

// El servidor contesta a TODO con `mensaje`, salga bien o mal, asi que lo unico
// que distingue un exito de un rechazo es el texto. Estos son los suyos,
// sacados del propio server.exe.
const MENSAJES_BUENOS = [
  'Tu cuenta ha sido creada con exito!',
  'Has borrado la cuenta',
  'El personaje se creo con exito!',
  'El personaje ha sido borrado!',
];
const esBueno = (t) => MENSAJES_BUENOS.some((b) => (t || '').startsWith(b));

// Asomado a la consola para poder diagnosticar en vivo: `estado.ui.inv`,
// `estado.ui.equipo`, `estado.suelo`... Solo lectura en la practica; el juego
// no depende de esta linea.
window.estado = estado;

// Las hojas se guardan en WebP, pero WebP no admite mas de 16383 px de lado y
// alguna hoja grande (la de sprites de ciertos clientes) se pasa: esas van en
// PNG. Se prueban las dos antes de darlo por perdido.
function cargarHoja(nombre) {
  return cargarImagen(`assets/${nombre}.webp`)
    .catch(() => cargarImagen(`assets/${nombre}.png`));
}

function cargarImagen(url) {
  return new Promise((ok, err) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => err(new Error('no se pudo cargar ' + url));
    i.src = url;
  });
}

async function cargarTodo(progreso) {
  const t0 = performance.now();
  const tareas = [];
  for (let i = 0; i < HOJAS_TILES; i++) tareas.push(cargarHoja(`tiles${i}`));
  tareas.push(cargarHoja('sprites'));
  tareas.push(cargarHoja('bigsprites'));
  tareas.push(cargarHoja('items'));
  tareas.push(cargarHoja('arrows'));
  tareas.push(cargarHoja('spells'));
  tareas.push(cargarMapas('assets/maps.bin'));

  let hechas = 0;
  const conAviso = tareas.map(p => p.then(r => { progreso(++hechas, tareas.length); return r; }));
  const res = await Promise.all(conAviso);

  const tiles = res.slice(0, HOJAS_TILES);
  return {
    tiles, sprites: res[HOJAS_TILES], grandes: res[HOJAS_TILES + 1],
    items: res[HOJAS_TILES + 2], flechas: res[HOJAS_TILES + 3],
    hechizos: res[HOJAS_TILES + 4], mapas: res[HOJAS_TILES + 5],
    ms: performance.now() - t0,
  };
}

// Sube con cada cambio de mapa efectivo. Sirve para descartar avisos del
// servidor que llegan tarde: si el contador cambio desde que se recibio el
// aviso, ese aviso ya no habla del mapa en el que estamos.
let seqMapa = 0;

// Caja negra de los saltos de mapa. Los fallos de warp solo aparecen cruzando
// deprisa, y eso no se puede reproducir a mano: hay que mirar el registro
// despues. Se consulta con `estado.diagWarp` en la consola del navegador.
const DIAG_MAX = 120;
function anotarSalto(origen, datos) {
  estado.diagWarp.push({ t: Math.round(performance.now()), origen, ...datos });
  if (estado.diagWarp.length > DIAG_MAX) estado.diagWarp.shift();
}

function entrarAMapa(id, x, y, origen = '?') {
  const m = estado.mapas.get(id);
  if (!m) return false;
  seqMapa++;
  anotarSalto(origen, { a: id, en: `${x},${y}`, desde: estado.mapa ? estado.mapa.id : null });
  estado.mapa = m;
  const j = estado.jugador;
  j.x = x; j.y = y; j.px = x * TS; j.py = y * TS;
  j.moviendo = false; j.destino = null;
  estado.npcs.clear();                       // los NPCs son de cada mapa
  estado.suelo.clear();
  estado.render.componer(m);                 // compone y cachea: sin espera visible
  $('#mapa').textContent = `${m.nombre || '(sin nombre)'}  ·  mapa ${m.id}`;
  estado.render.nombreMapa = (m.nombre || '').trim();
  $('#musica').textContent = m.musica || '—';
  if (estado.musica) estado.musica.poner(m.musica);
  return true;
}

// El bucle reintenta el paso en CADA fotograma mientras la tecla siga pulsada.
// Si al chocar mandaramos `playerdir` sin mas, saldrian ~144 paquetes por
// segundo y el ataque se quedaba sepultado en la cola. Solo se avisa cuando la
// direccion cambia de verdad.
let dirEnviada = null;
function mirar(dir) {
  estado.jugador.dir = dir;
  if (!estado.enLinea || dir === dirEnviada) return;
  dirEnviada = dir;
  estado.red.mirar(dir);
}

function intentarMover(dir) {
  const j = estado.jugador;
  if (j.moviendo) return;
  j.dir = dir;
  const corriendo = teclas.has('ShiftLeft') || teclas.has('ShiftRight');
  const d = { [DIR.ARRIBA]: [0, -1], [DIR.ABAJO]: [0, 1], [DIR.IZQ]: [-1, 0], [DIR.DER]: [1, 0] }[dir];
  const nx = j.x + d[0], ny = j.y + d[1];
  if (nx < 0 || ny < 0 || nx >= ANCHO || ny >= ALTO) return;
  if (esSolido(tipoEn(estado.mapa, nx, ny))) return;
  if (ocupada(nx, ny)) { mirar(dir); return; }
  j.destino = { x: nx, y: ny, dx: d[0], dy: d[1] };
  j.moviendo = true;
  j.t0 = performance.now();
  j.ms = corriendo ? Math.round(estado.msPorCasilla / 2) : estado.msPorCasilla;
  if (estado.enLinea) estado.red.mover(dir, corriendo);
  dirEnviada = dir;              // el propio paso ya le dice al servidor hacia donde miro
}

// Criaturas y jugadores estorban: no se puede caminar por encima de ellos.
// Se comprueba tambien la casilla de DESTINO de quien se esta moviendo, o se
// podria entrar en la casilla a la que otro ya esta entrando.
function ocupada(x, y) {
  for (const n of estado.npcs.values()) if (n.x === x && n.y === y) return true;
  for (const a of estado.otros.values()) {
    if (a.mapa !== undefined && estado.mapa && a.mapa !== estado.mapa.id) continue;
    if (a.x === x && a.y === y) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Teletransporte junto a un jugador  (/warpmeto y /warptome)
// ---------------------------------------------------------------------------
// El servidor no sabe colocarte: `warpto` solo acepta el numero de mapa y te
// deja en las coordenadas que ya tenias. Comprobado que ni `warpto mapa x y` ni
// `warp mapa x y` mueven nada. Por eso se podia aterrizar dentro de una roca y
// quedarse encerrado sin poder caminar.
//
// Quien si sabe que casillas estan bloqueadas es este cliente: lleva los 210
// mapas en memoria. El adaptador manda un DBOWARP con el mapa y la casilla del
// otro, y aqui se hace lo que el servidor no puede:
//   1. si la casilla actual esta bloqueada EN EL MAPA DESTINO, se camina a una
//      que no lo este, para no caer dentro de una pared;
//   2. se salta con `warpto`, que conserva la casilla;
//   3. ya en el mapa bueno, se termina de caminar hasta al lado del otro.
const PASOS = [[DIR.ARRIBA, 0, -1], [DIR.ABAJO, 0, 1], [DIR.IZQ, -1, 0], [DIR.DER, 1, 0]];
const PASOS_MAX = 60;                 // tope por tramo, para no andar sin fin
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const dentro = (x, y) => x >= 0 && y >= 0 && x < ANCHO && y < ALTO;

// Ojo con los warps (tipo 2): pisarlos dispara un cambio de mapa, asi que para
// caminar cuentan como bloqueados aunque se pueda andar por ellos.
const pisable = (m, x, y) =>
  dentro(x, y) && !esSolido(tipoEn(m, x, y)) && tipoEn(m, x, y) !== 2;

// Ruta mas corta por casillas pisables. `meta` dice si una casilla sirve;
// `coste` (opcional) desempata entre todas las que sirven.
function rutaHasta(m, x0, y0, meta, coste) {
  const visto = new Set([y0 * ANCHO + x0]);
  const cola = [{ x: x0, y: y0, camino: [] }];
  let mejor = null;
  for (let k = 0; k < cola.length; k++) {
    const n = cola[k];
    if (meta(n.x, n.y)) {
      if (!coste) return n.camino;           // sin desempate, el primero es el mas corto
      const c = coste(n.x, n.y);
      if (!mejor || c < mejor.c) mejor = { c, camino: n.camino };
    }
    if (n.camino.length >= PASOS_MAX) continue;
    for (const [dir, dx, dy] of PASOS) {
      const nx = n.x + dx, ny = n.y + dy;
      const clave = ny * ANCHO + nx;
      if (visto.has(clave) || !pisable(m, nx, ny)) continue;
      visto.add(clave);
      cola.push({ x: nx, y: ny, camino: [...n.camino, dir] });
    }
  }
  return mejor ? mejor.camino : null;
}

// Recorre la ruta. El servidor no tiene ningun comando que fije la posicion
// (`warpto` solo acepta el mapa y conserva la casilla; comprobado que
// `warpto mapa x y` y `warp mapa x y` ignoran las coordenadas), asi que la
// unica forma de colocarse es moverse de casilla en casilla. Para que no se
// vea como una caminata se recorre a MS_TP por casilla en vez de los 150
// normales: a esa velocidad el reajuste dura un parpadeo y parece parte del
// salto. Cada paso sigue siendo un `playermove` corriente, asi que el
// servidor no ve nada raro.
const MS_TP = 40;

async function caminar(camino) {
  const j = estado.jugador;
  const normal = estado.msPorCasilla;
  estado.msPorCasilla = MS_TP;
  try {
    for (const dir of camino) {
      let t = 0;
      while (j.moviendo && t < 1500) { await espera(10); t += 10; }
      const ax = j.x, ay = j.y;
      intentarMover(dir);
      t = 0;
      while (j.moviendo && t < 1500) { await espera(10); t += 10; }
      if (j.x === ax && j.y === ay) return false;   // algo estorba: se deja ahi
    }
    return true;
  } finally {
    estado.msPorCasilla = normal;
  }
}

let tpEnCurso = false;

// La casilla libre mas pegada al objetivo. La suya propia no vale: la ocupa el.
// Se busca en anillos cada vez mas amplios porque el otro puede estar metido
// DENTRO de una pared (el servidor teletransporta sin mirar si la casilla es
// pisable), y en ese caso dejarte a tres casillas es mejor que no ir.
// `ocupada` solo cuenta si el mapa examinado es en el que estoy ahora: mide
// criaturas y jugadores vivos, y de otro mapa no se sabe nada.
function huecoJuntoA(m, tx, ty, radio = 6) {
  const aqui = estado.mapa && estado.mapa.id === m.id;
  let mejor = null, mejorD = Infinity;
  for (let dy = -radio; dy <= radio; dy++) {
    for (let dx = -radio; dx <= radio; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d === 0 || d > radio || d >= mejorD) continue;
      const x = tx + dx, y = ty + dy;
      if (!pisable(m, x, y) || (aqui && ocupada(x, y))) continue;
      mejor = [x, y]; mejorD = d;
    }
  }
  return mejor;
}

async function irJuntoA(mapaId, tx, ty, nombre) {
  const destino = estado.mapas.get(mapaId);
  if (!destino) { estado.ui.chat('No tengo ese mapa cargado.', '#e07a6a'); return; }
  if (!huecoJuntoA(destino, tx, ty)) {
    estado.ui.chat('No hay ninguna casilla libre junto a esa persona.', '#e07a6a');
    return;
  }

  const j = estado.jugador;
  if (!estado.mapa || estado.mapa.id !== mapaId) {
    // 1. no aterrizar en una pared: `warpto` conserva la casilla, asi que si
    //    aqui estoy en una que alli esta bloqueada, me quedo encerrado.
    if (!pisable(destino, j.x, j.y)) {
      const salida = rutaHasta(estado.mapa, j.x, j.y,
        (x, y) => pisable(destino, x, y),
        (x, y) => Math.abs(x - tx) + Math.abs(y - ty));
      if (!salida) {
        estado.ui.chat('No puedo colocarme para saltar sin quedar encerrado.', '#e07a6a');
        return;
      }
      await caminar(salida);
    }
    // 2. el salto
    estado.red.enviar('WARPTO', mapaId);
    let t = 0;
    while ((!estado.mapa || estado.mapa.id !== mapaId) && t < 6000) { await espera(100); t += 100; }
    if (!estado.mapa || estado.mapa.id !== mapaId) {
      estado.ui.chat('El salto no llego a hacerse.', '#e07a6a');
      return;
    }
    await espera(400);                 // PLAYERDATA acaba de corregir la casilla
  }

  // 3. acercarse del todo. Se reintenta porque por el camino hay criaturas que
  //    se mueven: un paso bloqueado no significa que no se pueda llegar, solo
  //    que hay que recalcular. Y el objetivo tambien anda, asi que se le sigue
  //    en vivo por su nombre en vez de ir a la casilla que tenia al empezar.
  for (let intento = 0; intento < 6; intento++) {
    let ox = tx, oy = ty;
    if (nombre) {
      for (const a of estado.otros.values()) {
        if (a.nombre === nombre) { ox = a.x; oy = a.y; break; }
      }
    }
    // Exactamente al lado. Distancia 0 NO vale: al saltar los dos caen en la
    // misma casilla y quedan uno encima del otro.
    if (Math.abs(j.x - ox) + Math.abs(j.y - oy) === 1) return;
    const hueco = huecoJuntoA(estado.mapa, ox, oy);
    if (!hueco) { await espera(500); continue; }
    const ruta = rutaHasta(estado.mapa, j.x, j.y, (x, y) => x === hueco[0] && y === hueco[1]);
    if (!ruta) {
      estado.ui.chat('Llegue al mapa, pero no hay camino hasta esa persona.', '#e0c060');
      return;
    }
    if (await caminar(ruta)) return;
    await espera(400);                 // algo estorbaba: se recalcula y se repite
  }
  estado.ui.chat('Llegue al mapa, pero no pude acercarme mas.', '#e0c060');
}

function alLlegar() {
  const j = estado.jugador, m = estado.mapa;
  j.paso = (j.paso + 1) & 3;
  const t = tipoEn(m, j.x, j.y);
  if (t === 2) {                                   // warp
    const destino = datoEn(m, j.x, j.y, 0);
    const dx = datoEn(m, j.x, j.y, 1), dy = datoEn(m, j.x, j.y, 2);
    if (estado.mapas.has(destino)) {
      estado.audio.efecto('warp.wav');
      entrarAMapa(destino, dx, dy, 'warp de casilla');
      return;
    }
  }
  const carteles = m.carteles.get(idx(j.x, j.y));
  const texto = carteles && carteles.find(s => s && s.trim());
  $('#cartel').textContent = texto ? texto.trim() : '';
}

const teclas = new Set();
let pendiente = null;   // ultima direccion pulsada, para toques muy breves
// Solo las flechas. El juego original no usa WASD, y ademas esas letras hacen
// falta para escribir en el chat.
const MAPA_TECLAS = {
  ArrowUp: DIR.ARRIBA,
  ArrowDown: DIR.ABAJO,
  ArrowLeft: DIR.IZQ,
  ArrowRight: DIR.DER,
};

function bucle(ahora) {
  const j = estado.jugador;

  if (j.moviendo && j.destino) {
    const p = Math.min(1, (ahora - j.t0) / (j.ms || estado.msPorCasilla));
    j.px = (j.x + j.destino.dx * p) * TS;
    j.py = (j.y + j.destino.dy * p) * TS;
    if (p >= 1) {
      j.x = j.destino.x; j.y = j.destino.y;
      j.px = j.x * TS; j.py = j.y * TS;
      j.moviendo = false; j.destino = null;
      alLlegar();
    }
  } else {
    // Primero las teclas mantenidas (caminar sostenido); si no hay ninguna,
    // se atiende un toque suelto que pudo ocurrir entre dos fotogramas.
    let dir = null;
    for (const [code, d] of Object.entries(MAPA_TECLAS)) {
      if (teclas.has(code)) { dir = d; break; }
    }
    if (dir === null && pendiente !== null) dir = pendiente;
    // El toque se consume SIEMPRE que se inicia un paso. Si no, la tecla
    // mantenida movia una casilla y el 'pendiente' sin limpiar movia otra:
    // un toque daba dos pasos.
    pendiente = null;
    if (dir !== null) intentarMover(dir);
  }

  // Solo se pinta a quien esta en MI mapa. El servidor manda PLAYERDATA con
  // mapa 0 cuando alguien deja el mapa, y `otros` conserva la entrada; sin
  // filtrar aqui, ese jugador se quedaba dibujado como un fantasma en la
  // casilla donde estaba cuando se fue. Lo veias ahi, no estaba, y encima lo
  // atravesabas: `ocupada` si miraba el mapa, pero el dibujo no.
  const enMiMapa = (a) => a.mapa === undefined || (estado.mapa && a.mapa === estado.mapa.id);
  const actores = [j, ...[...estado.otros.values()].filter(enMiMapa),
                   ...estado.npcs.values()];
  for (const a of actores) if (a !== j) a.actualizar(ahora);

  // Las flechas paran al topar con una pared o con cualquier criatura.
  estado.efectos.actualizar(ahora, (x, y) => {
    if (esSolido(tipoEn(estado.mapa, x, y))) return true;
    for (const n of estado.npcs.values()) if (n.x === x && n.y === y) return true;
    return false;
  });

  estado.render.dibujar(estado.mapa, actores, j.px, j.py,
                        { suelo: estado.suelo.values(), efectos: estado.efectos });

  // contador de fotogramas
  fps.n++;
  if (ahora - fps.t >= 500) {
    $('#fps').textContent = Math.round(fps.n * 1000 / (ahora - fps.t));
    fps.n = 0; fps.t = ahora;
  }
  $('#pos').textContent = `${j.x},${j.y}`;
  requestAnimationFrame(bucle);
}
const fps = { n: 0, t: 0 };


function ponerEnSuelo(ranura, num, x, y) {
  const def = estado.ui.items.get(num);
  estado.suelo.set(ranura, { num, pic: def ? def.pic : 0, x, y });
}

// El cuadro de magias del cliente muestra SIEMPRE las 20 ranuras; las vacias
// ponen "<vacio>". Se elige con doble clic y se lanza con el boton o con Insert.
function pintarHechizos() {
  const filas = [];
  for (let i = 0; i < 20; i++) {
    const num = estado.hechizos[i] || 0;
    filas.push(num ? estado.ui.nombreHechizo(num) : '<vacio>');
  }
  estado.ui.pintaLista($('#lista-magias'), filas, estado.hechizoElegido - 1);
}

function pintarOnline(nombres) {
  estado.ui.pintaLista($('#lista-online'), nombres, -1);
}

function lanzarMagia() {
  if (!estado.enLinea) return;
  // mensajes textuales del cliente original
  if (estado.jugador.moviendo) {
    estado.ui.chat('No puedes lanzar la magia al caminar!', '#e07a6a');
    return;
  }
  if (!estado.hechizoElegido) { estado.ui.chat('Elige una magia aprendida.', '#e07a6a'); return; }
  estado.red.lanzar(estado.hechizoElegido);
}

// F6/F7/F8: busca en el inventario la primera pocion del tipo pedido y la usa.
// Tipos: 5 = +HP, 6 = +MP, 7 = +SP.
const AVISO_POCION = {
  5: ['Restauras puntos de vida, te sientes mas fuerte!', 'No tienes ningun item que restaure puntos de vida!'],
  6: ['Restauras puntos de mana!', 'No tienes ningun item que restaure puntos de mana!'],
  7: ['Restauras puntos de SP', 'No tienes ningun item que restaure puntos de SP!'],
};
function usarPocion(tipo) {
  if (!estado.enLinea) return;
  const [bien, mal] = AVISO_POCION[tipo];
  for (let i = 0; i < estado.ui.inv.length; i++) {
    const r = estado.ui.inv[i];
    if (!r || !r.num) continue;
    const def = estado.ui.items.get(r.num);
    if (def && def.tipo === tipo) {
      estado.red.enviar('USEITEM', i + 1);
      estado.ui.chat(bien, '#7fd17f');
      return;
    }
  }
  estado.ui.chat(mal, '#e07a6a');
}

// Todo lo que se escribe en el chat pasa por aqui. El original distingue por
// el primer caracter: '!' privado, '%' al clan, '/' comando; el resto se habla.
function mandarChat(t) {
  const red = estado.red;
  if (t[0] === '!') {                       // !nombre mensaje
    const hueco = t.indexOf(' ');
    if (hueco < 2) { estado.ui.chat('Usar: !Nombre del jugador mensaje', '#e07a6a'); return; }
    red.privado(t.slice(1, hueco), t.slice(hueco + 1));
    estado.ui.chat(t, '#c8a2e8');
    return;
  }
  if (t[0] === '%') { red.alClan(t.slice(1)); estado.ui.chat(t, '#7fd1c8'); return; }
  if (t[0] === '/') { comando(t); return; }
  estado.ui.chat('> ' + t, '#9a8f7d');
  red.enviar('saymsg', t);
}

// Cada comando del cliente original y el paquete al que corresponde. Los que
// no estan aqui se mandan con `checkcommands`, que es lo que hace el cliente
// de verdad: le pregunta al servidor si ese comando existe (asi funcionan los
// comandos de guion como /guardar, /gm o /ausente).
function comando(linea) {
  const red = estado.red;
  const trozos = linea.split(/\s+/);
  const c = trozos[0].toLowerCase();
  const resto = linea.slice(trozos[0].length).trim();
  const arg = (n) => trozos[n] || '';

  switch (c) {
    case '/online':        red.enviar('ONLINELIST'); return;
    case '/fps':           estado.ui.chat('FPS: ' + $('#fps').textContent); return;
    case '/inventario':    estado.ui.mostrarPestana('inventario'); return;
    case '/estadisticas':  red.enviar('getstats'); estado.ui.mostrarPestana('inventario'); return;
    case '/loc':           red.enviar('REQUESTLOCATION'); return;
    case '/info':          red.enviar('playerinforequest', resto); return;
    case '/nochat':        red.enviar('dchat'); return;
    case '/sichat':        red.enviar('achat'); return;
    case '/comerciar':
      if (!resto) { estado.ui.chat('Usar: /comerciar Nombre del jugador aqui', '#e07a6a'); return; }
      red.enviar('PPTRADE', resto); return;
    case '/sicomerciar':   red.enviar('ATRADE'); return;
    case '/nocomerciar':   red.enviar('DTRADE'); return;
    case '/weather':       red.enviar('weather', resto || 'none'); return;
    case '/respawn':       red.enviar('MAPRESPAWN'); return;
    case '/mapreport':     red.enviar('mapreport'); return;
    case '/motd':          red.enviar('SETMOTD', resto); return;
    case '/kick':          red.enviar('KICKPLAYER', resto); return;
    case '/ban':           red.enviar('BANPLAYER', resto); return;
    case '/banlist':       red.enviar('BANLIST'); return;
    case '/destroybanlist':red.enviar('BANDESTROY'); return;
    case '/setaccess':     red.enviar('SETACCESS', arg(1), arg(2)); return;
    case '/setsprite':     red.enviar('SETSPRITE', arg(1)); return;
    case '/setplayersprite': red.enviar('SETPLAYERSPRITE', arg(1), arg(2)); return;
    case '/edititem':      red.enviar('REQUESTEDITITEM'); return;
    case '/editnpc':       red.enviar('REQUESTEDITNPC'); return;
    case '/editshop':      red.enviar('REQUESTEDITSHOP'); return;
    case '/editspell':     red.enviar('REQUESTEDITSPELL'); return;
    case '/editarrow':     red.enviar('REQUESTEDITARROW'); return;
    case '/editemoticon':  red.enviar('REQUESTEDITEMOTICON'); return;
    case '/mapeditor':     red.enviar('REQUESTEDITMAP'); return;
    // Teletransporte. El cliente original no trae estos comandos escritos
    // (lo hace desde sus ventanas), pero los paquetes son los suyos.
    // Vuelca la caja negra de saltos de mapa en el chat, para poder mirarla
    // despues de reproducir un fallo de warp sin tener que abrir la consola.
    case '/warplog': {
      const reg = estado.diagWarp.slice(-14);
      if (!reg.length) { estado.ui.chat('Sin saltos registrados.', '#e0c060'); return; }
      const t0 = reg[0].t;
      estado.ui.chat(`--- ultimos ${reg.length} saltos de mapa ---`, '#e0c060');
      for (const r of reg) {
        const donde = r.en ? ` en ${r.en}` : '';
        const antes = r.desde !== undefined && r.desde !== null ? ` (desde ${r.desde})` : '';
        estado.ui.chat(`+${r.t - t0}ms  ${r.origen}  -> mapa ${r.a}${donde}${antes}`, '#9fd0ff');
      }
      return;
    }
    case '/warpto':        red.enviar('WARPTO', arg(1)); return;
    case '/warpmeto':      red.enviar('WARPMETO', resto); return;
    case '/warptome':      red.enviar('WARPTOME', resto); return;
    default:               red.comandoDesconocido(linea);
  }
}

// Cuadro de cantidad, el que usa el cliente para arrojar y para el banco.
// Devuelve el numero elegido, o null si se cancela.
function pedirCantidad(texto) {
  return new Promise((listo) => {
    const dlg = $('#dialogo'), campo = $('#dlg-cant');
    $('#dlg-texto').textContent = texto;
    campo.value = '';
    dlg.classList.add('visible');
    campo.focus();
    const cerrar = (v) => {
      dlg.classList.remove('visible');
      $('#dlg-ok').removeEventListener('click', ok);
      $('#dlg-no').removeEventListener('click', no);
      campo.removeEventListener('keydown', tecla);
      listo(v);
    };
    const ok = () => cerrar(parseInt(campo.value, 10));
    const no = () => cerrar(null);
    const tecla = (e) => {
      if (e.key === 'Enter') ok();
      if (e.key === 'Escape') no();
      e.stopPropagation();
    };
    $('#dlg-ok').addEventListener('click', ok);
    $('#dlg-no').addEventListener('click', no);
    campo.addEventListener('keydown', tecla);
  });
}

// Arrojar al suelo. Si el objeto se acumula (monedas, pociones) el cliente
// pregunta cuanto, con este texto exacto.
async function arrojar() {
  const i = estado.ui.seleccion;
  if (i === null || !estado.enLinea) return;
  const r = estado.ui.inv[i];
  if (!r || !r.num) return;
  const tiene = r.cant || 0;

  // Los objetos que no se acumulan (armas, armaduras) vienen con cantidad 0:
  // eso NO significa que no los tengas, significa que no son una pila. Se
  // tiran de uno en uno, sin preguntar.
  //
  // El bloqueo que habia aqui sobraba: las expulsiones por "(Coneccion pobre)"
  // venian de que el inventario del cliente se desincronizaba y las ranuras ya
  // no coincidian con las del servidor. Eso se arreglo atendiendo
  // PLAYERINVUPDATE; lo que si hay que respetar es no pedir mas de lo que hay.
  // La cantidad que se manda tiene que ser EXACTAMENTE la que dice el
  // inventario: un objeto que no se acumula vale 0, y mandarle 1 es lo que
  // provoca la expulsion por "(Coneccion pobre)". Comprobado en el servidor de
  // pruebas: con 0 lo tira bien, con 1 te echa.
  if (tiene <= 1) { estado.red.enviar('MAPDROPITEM', i + 1, tiene); return; }

  const nombre = estado.ui.nombreDe(r.num);
  const n = await pedirCantidad(`Cantidad de ${nombre} (${tiene}) Que cantidad vas a arrojar?`);
  if (n === null || isNaN(n)) return;
  if (n <= 0) { estado.ui.chat('Cantidad no permitida!', '#e07a6a'); return; }
  if (n > tiene) { estado.ui.chat('No tienes esa cantidad para arrojar!', '#e07a6a'); return; }
  estado.red.enviar('MAPDROPITEM', i + 1, Math.min(n, tiene));
}

// Fin: gira sobre el sitio sin dar un paso.
function girar() {
  const j = estado.jugador;
  if (j.moviendo) return;
  mirar((j.dir + 1) & 3);
}

// ---------------------------------------------------------------- red

const DIAG = { conteo: new Map(), ejemplo: new Map(), npcCrudo: [] };

// Copiado literalmente de la ayuda del cliente original.
const AYUDA = [
  ':: Controles basicos ::',
  ' - Usa las flechas de tu teclado para mover al personaje.',
  ' - Usa la tecla Shif para correr con el personaje.',
  ' - Usa la tecla Ctrl para golpear a un enemigo.',
  ' - Usa la tecla Insert para lanzar la magia elegida sin tener que usar el mouse.',
  ' - Usa las teclas F6 - F7 - F8 para restaurar puntos de HP - MP - SP respectivamente.',
  ' - Usa la tecla Fin Rotar el personaje sin la necesidad de moverse del lugar',
  ' - Para mandar un mensaje privado Tipea ! !nombre del jugador Texto aqui.',
  ' - Para mandar un mensaje a los miembros de tu clan Tipea % %Texto aqui.',
];

// Los textos son los del cliente original, palabra por palabra.
function estadoRed(texto, clase) {
  const el = $('#aviso');
  if (el) el.textContent = texto;
  if (clase === 'mal') el.style.color = '#ff9a8a';
  else el.style.color = '#ffe9a8';
}

// El menu principal: el panel del dragon con su musica, antes de entrar.
function abrirMenu() {
  $('#menu').style.display = 'grid';
  // Volver a la portada: quedarse en la lista de personajes con la conexion
  // muerta no sirve de nada, y los botones no harian nada.
  if (estado.pantallaMenu) estado.pantallaMenu('menu');
  if (estado.musica) estado.musica.poner('Title.mid');
  comprobarServidor();
}

function cerrarMenu() {
  $('#menu').style.display = 'none';
  if (estado.musica && estado.mapa) estado.musica.poner(estado.mapa.musica);
}

// --- personajes de la cuenta -------------------------------------------
// Cada cuenta guarda TRES personajes, en las secciones [CHAR1..3] de su
// fichero. ALLCHARS trae los tres seguidos, ocupados o no:
//   ALLCHARS | nombre1 | raza1 | nivel1 | nombre2 | ... | nivel3 |
const RANURAS = 3;

function leerRanuras(f) {
  estado.ranuras = [];
  for (let i = 0; i < RANURAS; i++) {
    estado.ranuras.push({
      nombre: (f[1 + i * 3] || '').trim(),
      raza:   (f[2 + i * 3] || '').trim(),
      nivel:  parseInt(f[3 + i * 3], 10) || 0,
    });
  }
  // Si la ranura marcada se ha quedado vacia (se acaba de borrar), se salta a
  // la primera con personaje; y si no hay ninguno, a la primera libre.
  const sel = estado.ranuras[estado.ranuraSel - 1];
  if (!sel || !sel.nombre) {
    const conPj = estado.ranuras.findIndex((r) => r.nombre);
    estado.ranuraSel = (conPj >= 0 ? conPj : 0) + 1;
  }
  pintarRanuras();
}

function pintarRanuras() {
  const caja = $('#ranuras');
  caja.innerHTML = '';
  estado.ranuras.forEach((r, i) => {
    const fila = document.createElement('div');
    fila.className = 'fila' + (r.nombre ? '' : ' vacia')
                   + (estado.ranuraSel === i + 1 ? ' sel' : '');
    // "<Vacio>" es la palabra que usa el propio cliente para una ranura libre.
    fila.textContent = r.nombre ? `${r.nombre} · ${r.raza} · nivel ${r.nivel}` : '<Vacio>';
    fila.addEventListener('click', () => {
      estado.ranuraSel = i + 1;
      estado.confirmaBorrar = false;
      pintarRanuras();
    });
    caja.appendChild(fila);
  });
}

// "Estado del Server:" — se abre y se cierra una conexion al puente, que es lo
// que hace el cliente original contra el servidor: si alguien acepta, Online.
function comprobarServidor() {
  const el = $('#srvestado');
  el.textContent = '...'; el.className = '';
  let ws;
  try { ws = new WebSocket(urlPuente()); }
  catch (e) { el.textContent = 'Offline'; el.className = 'no'; return; }
  // No alcanza con que el puente acepte la conexion: si el servidor del juego
  // no esta arriba, el puente acepta y se cae en seguida. Antes eso mostraba
  // "Online" y despues el login decia "El server esta apagado", que es de las
  // cosas mas confusas que puede hacer una pantalla. Se espera un momento a
  // ver si la conexion SIGUE viva.
  let resuelto = false;
  const poner = (ok) => {
    if (resuelto) return;
    resuelto = true;
    el.textContent = ok ? 'Online' : 'Offline';
    el.className = ok ? 'si' : 'no';
    try { ws.close(); } catch (e) {}
  };
  const fallo = setTimeout(() => poner(false), 4000);
  ws.onopen = () => setTimeout(() => {
    clearTimeout(fallo);
    poner(ws.readyState === WebSocket.OPEN);
  }, 1500);
  ws.onerror = () => { clearTimeout(fallo); poner(false); };
  ws.onclose = () => { clearTimeout(fallo); poner(false); };
}

function urlPuente() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:4002`;
}

// Crear y borrar cuenta se hacen SIN haber entrado: el servidor los acepta en
// una conexion recien abierta y contesta con un `mensaje`. Se abre una aparte,
// se manda el paquete, se recoge la respuesta y se cierra; asi estas dos
// opciones del menu no dependen de tener sesion ni ensucian la del juego.
function conexionSuelta(manda) {
  return new Promise((listo, falla) => {
    const r = new Red(urlPuente());
    const corte = setTimeout(() => { r.cerrar(); falla(new Error('El servidor no contesta')); }, 8000);
    r.addEventListener('MENSAJE', (e) => {
      clearTimeout(corte);
      const texto = (e.detail[1] || '').trim();
      r.cerrar();
      listo(texto);
    });
    r.conectar()
      .then(() => manda(r))
      .catch(() => {
        clearTimeout(corte);
        falla(new Error('El server esta apagado, volve a intentarlo mas tarde'));
      });
  });
}

function conectar() {
  const cuenta = $('#cuenta').value.trim();
  const clave = $('#clave').value;
  if (cuenta.length < 3 || clave.length < 3) {
    estadoRed('Tu nombre y contraseña tienen que tener tres caracteres de largo como minimo', 'mal');
    return;
  }

  estado.cuenta = cuenta; estado.clave = clave;
  estado.cerrandoAdrede = false;
  const red = new Red(urlPuente());
  estado.red = red;
  estadoRed('Iniciando TCP...');

  // Diagnostico: cuenta cada tipo de paquete y guarda un ejemplo. Sirve para
  // descubrir los que todavia no manejamos (movimiento de otros, NPCs, chat).
  red.addEventListener('paquete', (e) => {
    const c = e.detail.cmd;
    DIAG.conteo.set(c, (DIAG.conteo.get(c) || 0) + 1);
    if (!DIAG.ejemplo.has(c)) DIAG.ejemplo.set(c, e.detail.campos);
  });

  red.addEventListener('cerrado', () => {
    const estaba = estado.enLinea;
    estado.enLinea = false;
    estado.otros.clear();
    // Salir de la eleccion de personaje cierra la sesion a proposito: no es
    // una caida y no hay que alarmar a nadie.
    if (estado.cerrandoAdrede) { estado.cerrandoAdrede = false; return; }
    if (estaba) { abrirMenu(); estadoRed('Se ha perdido la conexion con el servidor.', 'mal'); }
    else estadoRed('El server esta apagado, volve a intentarlo mas tarde', 'mal');
  });

  // `mensaje` es el paquete de rechazo del servidor ("No se permiten multiples
  // cuentas.", "El personaje no existe!"). Va en MAYUSCULAS como todos los
  // demas: escuchandolo en minusculas no saltaba nunca y el menu se quedaba
  // mudo cuando el login fallaba.
  red.addEventListener('MENSAJE', (e) => {
    const t = (e.detail[1] || 'Rechazado').trim();
    estadoRed(t, esBueno(t) ? null : 'mal');
  });

  // Tras entrar, el servidor manda las tres ranuras de personaje de la cuenta.
  // Tambien las vuelve a mandar cada vez que se crea o se borra uno.
  red.addEventListener('ALLCHARS', (e) => {
    leerRanuras(e.detail);
    if (estado.enLinea) return;          // ya jugando: esto es solo un refresco
    // Al venir del login sobra el "Conectando con el servidor..."; al venir de
    // crear o borrar un personaje NO, porque el servidor manda su aviso justo
    // detras de este paquete y hay que dejarlo hablar.
    const desdeLogin = estado.pantalla !== 'personajes' && estado.pantalla !== 'nuevopj';
    estado.pantallaMenu('personajes');
    if (desdeLogin) estadoRed('');
  });

  red.addEventListener('LOGINOK', (e) => { estado.miIndice = parseInt(e.detail[1], 10); });

  // CHECKFORMAP llega en CADA cambio de mapa: al entrar, al cruzar un warp y
  // al morir (el servidor te manda a la ciudad). Campo 1 = mapa, campo 2 =
  // revision. Antes solo se contestaba, sin cambiar de mapa: al morir el
  // cliente se quedaba en el mapa viejo, sin criaturas ni objetos, y solo se
  // arreglaba volviendo a entrar.
  // CHECKFORMAP solo trae el NUMERO de mapa, no la casilla. Antes se usaba para
  // saltar de inmediato, poniendo la casilla del jugador (`j.x, j.y`), y eso
  // daba dos problemas:
  //   - entrabas al mapa nuevo con las coordenadas del viejo. Medido: cruzando
  //     del 44 al 32 el cliente aparecia en (17,1) en vez de (14,28), porque el
  //     servidor pisaba el warp y avisaba antes de que el cliente terminara el
  //     paso. Si esa casilla resulta ser otro warp, encadenas a un tercer mapa.
  //   - cruzando dos veces seguidas, el aviso del PRIMER salto llegaba cuando ya
  //     habias vuelto, y te devolvia al otro mapa unos segundos.
  // PLAYERDATA llega detras con mapa Y casilla correctos, asi que se le deja el
  // salto a el. Esto queda solo de red de seguridad por si no llegara (la
  // muerte), y se descarta si algo nos movio mientras tanto.
  red.addEventListener('CHECKFORMAP', (e) => {
    const destino = parseInt(e.detail[1], 10);
    red.pedirMapa(true);                // los 210 mapas ya los tenemos en local
    anotarSalto('aviso CHECKFORMAP', { a: destino, estoyEn: estado.mapa ? estado.mapa.id : null });
    if (!destino || !estado.mapas.has(destino)) return;
    if (estado.mapa && estado.mapa.id === destino) return;
    const seq = seqMapa;
    setTimeout(() => {
      if (seq !== seqMapa) return;                       // ya nos movimos: el aviso caduco
      if (estado.mapa && estado.mapa.id === destino) return;
      const j = estado.jugador;
      entrarAMapa(destino, j.x, j.y, 'CHECKFORMAP (red de seguridad)');
    }, 800);
  });

  // DBOWARP no es del juego original: lo inventa el adaptador para /warpmeto y
  // /warptome, porque el servidor de Dreaminze no tiene esos comandos ni sabe
  // colocar a nadie en una casilla concreta.
  red.addEventListener('DBOWARP', async (e) => {
    if (tpEnCurso) return;              // un tp a la vez, o se pisan las rutas
    tpEnCurso = true;
    try {
      await irJuntoA(parseInt(e.detail[1], 10), parseInt(e.detail[2], 10),
                     parseInt(e.detail[3], 10), (e.detail[4] || '').trim());
    } finally {
      tpEnCurso = false;
    }
  });

  red.addEventListener('PLAYERDATA', (e) => {
    const f = e.detail;
    const indice = parseInt(f[1], 10);
    const nombre = f[2], sprite = parseInt(f[3], 10) || 0;
    const mapa = parseInt(f[4], 10), x = parseInt(f[5], 10), y = parseInt(f[6], 10);
    const dir = parseInt(f[7], 10) || 0;
    const acceso = parseInt(f[8], 10) || 0;      // 0 normal ... 4 administrador

    if (indice === estado.miIndice) {
      estado.miClase = parseInt(f[12], 10) || 0;
      if (estado.clases.length) estado.ui.setRaza(estado.clases[estado.miClase] || '');
      const primeraVez = !estado.enLinea;
      estado.enLinea = true;
      if (primeraVez) cerrarMenu();
      const j = estado.jugador;
      j.sprite = sprite; j.nombre = nombre; j.acceso = acceso;

      // Solo se acepta la posicion del servidor al entrar, al cambiar de mapa
      // o si nos hemos desincronizado de verdad (mas de una casilla). Si no,
      // manda la prediccion local: reposicionar en cada paquete haria que el
      // personaje volviera atras constantemente.
      const cambioMapa = !estado.mapa || estado.mapa.id !== mapa;
      const lejos = Math.abs(j.x - x) > 1 || Math.abs(j.y - y) > 1;
      if (cambioMapa) {
        entrarAMapa(mapa, x, y, 'PLAYERDATA (el servidor manda)');
        j.dir = dir;
      } else if (primeraVez || (lejos && !j.moviendo)) {
        anotarSalto('PLAYERDATA recoloca', { a: mapa, en: `${x},${y}`, estabaEn: `${j.x},${j.y}` });
        j.x = x; j.y = y; j.px = x*TS; j.py = y*TS;
        j.moviendo = false; j.destino = null; j.dir = dir;
      }
      return;
    }
    // otro jugador
    let a = estado.otros.get(indice);
    if (!a) { a = new Actor(estado.hojaSprites, sprite, x, y); estado.otros.set(indice, a); }
    a.sprite = sprite; a.nombre = nombre; a.dir = dir; a.acceso = acceso;
    a.x = x; a.y = y; a.px = x*TS; a.py = y*TS;
    a.mapa = mapa;
    // Su equipo pudo llegar antes que este paquete, asi que se aplica aqui
    // tambien: sin la hoja de objetos el personaje se dibuja desnudo.
    a.hojaItems = estado.hojaItems;
    const suEquipo = estado.equipoDe.get(indice);
    if (suEquipo) a.puesto = suEquipo;
  });

  // --- NPCs ---
  // UPDATENPC llega al entrar: num, nombre, sprite
  red.addEventListener('UPDATENPC', (e) => {
    const f = e.detail;
    DIAG.npcCrudo.push(f.slice(0, 8));
    // campo 4 = usa BIGSPRITES (bloques de 64x64), campo 5 = vida maxima
    estado.npcDefs.set(parseInt(f[1], 10), {
      nombre: f[2].trim(),
      sprite: parseInt(f[3], 10) || 0,
      grande: f[4] === '1',
      vidaMax: parseInt(f[5], 10) || 0,
    });
  });

  // MAPNPCDATA: 15 ranuras de (num, x, y, dir) para el mapa actual
  red.addEventListener('MAPNPCDATA', (e) => {
    const f = e.detail;
    estado.npcs.clear();
    for (let ranura = 1; ranura <= 15; ranura++) {
      const b = 1 + (ranura - 1) * 4;
      const num = parseInt(f[b], 10);
      if (!num) continue;
      const x = parseInt(f[b+1], 10), y = parseInt(f[b+2], 10), dir = parseInt(f[b+3], 10) || 0;
      const def = estado.npcDefs.get(num) || { nombre: '', sprite: 0, grande: false };
      const a = new Actor(estado.hojaSprites, def.sprite, x, y);
      a.dir = dir;
      a.nombre = def.nombre;
      a.esNpc = true;
      a.grande = def.grande;
      a.hojaGrande = estado.hojaGrandes;
      estado.npcs.set(ranura, a);
    }
    $('#npcs').textContent = estado.npcs.size;
  });

  red.addEventListener('NPCMOVE', (e) => {
    const f = e.detail;
    const a = estado.npcs.get(parseInt(f[1], 10));
    if (!a) return;
    a.moverA(parseInt(f[2], 10), parseInt(f[3], 10), parseInt(f[4], 10),
             parseInt(f[5], 10) === 2 ? 110 : 220);   // 2 = corriendo
  });

  red.addEventListener('NPCHP', (e) => {
    const a = estado.npcs.get(parseInt(e.detail[1], 10));
    if (a) { a.hp = parseInt(e.detail[2], 10); a.hpMax = parseInt(e.detail[3], 10); }
  });

  // --- movimiento de los demas jugadores ---
  // playermove: indice, x, y, direccion, paso(1 andando / 2 corriendo)
  red.addEventListener('PLAYERMOVE', (e) => {
    const f = e.detail;
    const i = parseInt(f[1], 10);
    if (i === estado.miIndice) return;              // de mi mismo mando yo
    const a = estado.otros.get(i);
    if (!a) return;
    a.moverA(parseInt(f[2], 10), parseInt(f[3], 10), parseInt(f[4], 10),
             parseInt(f[5], 10) === 2 ? 90 : 180);
  });

  red.addEventListener('PLAYERDIR', (e) => {
    const a = estado.otros.get(parseInt(e.detail[1], 10));
    if (a) a.dir = parseInt(e.detail[2], 10) || 0;
  });

  // playerxy: recolocacion seca, sin interpolar (teletransportes)
  red.addEventListener('PLAYERXY', (e) => {
    const f = e.detail;
    const a = estado.otros.get(parseInt(f[1], 10));
    if (!a) return;
    a.x = parseInt(f[2], 10); a.y = parseInt(f[3], 10);
    a.px = a.x * TS; a.py = a.y * TS; a.moviendo = false; a.hasta = null;
  });

  // --- criaturas ---
  red.addEventListener('SPAWNNPC', (e) => {
    const f = e.detail;
    const ranura = parseInt(f[1], 10);
    const num = parseInt(f[2], 10);
    const def = estado.npcDefs.get(num) || { nombre: '', sprite: 0, grande: false };
    const a = new Actor(estado.hojaSprites, def.sprite, parseInt(f[3], 10), parseInt(f[4], 10));
    a.dir = parseInt(f[5], 10) || 0;
    a.nombre = def.nombre; a.esNpc = true;
    a.grande = def.grande; a.hojaGrande = estado.hojaGrandes;
    estado.npcs.set(ranura, a);
    $('#npcs').textContent = estado.npcs.size;
  });

  red.addEventListener('NPCDEAD', (e) => {
    estado.npcs.delete(parseInt(e.detail[1], 10));
    $('#npcs').textContent = estado.npcs.size;
  });

  red.addEventListener('NPCATTACK', (e) => {
    const a = estado.npcs.get(parseInt(e.detail[1], 10));
    if (a) a.atacar();
  });

  red.addEventListener('NPCDIR', (e) => {
    const a = estado.npcs.get(parseInt(e.detail[1], 10));
    if (a) a.dir = parseInt(e.detail[2], 10) || 0;
  });

  // --- dano ---
  // Capturado peleando de verdad contra vanx. Ojo con los nombres, que enganan:
  //   BLITPLAYERDMG <cantidad> <ranuraNpc>  = lo que PEGA el jugador  -> sobre el npc
  //   BLITNPCDMG    <cantidad>              = lo que pega el npc      -> sobre mi
  //   damagedisplay <0 pego / 1 me pegan> <texto> <color>  = linea para el chat
  // Cuando la defensa de la criatura supera tu fuerza el servidor manda un
  // dano NEGATIVO (p.ej. -1715) junto con "El ataque no hace nada.". Ese numero
  // no se pinta: el mensaje ya va al chat.
  const numero = (quien, cuanto, tono) => {
    const n = parseInt(cuanto, 10);
    if (!quien || !n || n <= 0) return;
    estado.efectos.texto(n, quien.x, quien.y, tono);
  };
  red.addEventListener('BLITPLAYERDMG', (e) => {
    const npc = estado.npcs.get(parseInt(e.detail[2], 10));
    numero(npc || estado.jugador, e.detail[1], 'golpe');
  });
  red.addEventListener('BLITNPCDMG', (e) =>
    numero(estado.jugador, e.detail[1], 'dano'));
  red.addEventListener('DAMAGEDISPLAY', (e) =>
    estado.ui.chat(e.detail[2], color(e.detail[3])));

  // --- objetos tirados en el suelo ---
  // MAPITEMDATA: 20 ranuras de (num, valor, durabilidad, x, y)
  red.addEventListener('MAPITEMDATA', (e) => {
    const f = e.detail;
    estado.suelo.clear();
    for (let r = 0; r < 20; r++) {
      const b = 1 + r * 5;
      const num = parseInt(f[b], 10);
      if (!num) continue;
      // Ojo: SPAWNITEM numera las ranuras desde 1. Si aqui se guardan desde 0,
      // el borrado nunca encuentra la ranura y el objeto se queda pegado al
      // suelo aunque ya lo hayas levantado.
      ponerEnSuelo(r + 1, num, parseInt(f[b + 3], 10), parseInt(f[b + 4], 10));
    }
  });
  red.addEventListener('SPAWNITEM', (e) => {
    const f = e.detail;
    const r = parseInt(f[1], 10);
    const num = parseInt(f[2], 10);
    if (!num) estado.suelo.delete(r);
    else ponerEnSuelo(r, num, parseInt(f[5], 10), parseInt(f[6], 10));
  });

  // --- flechas ---
  // El servidor solo dice "dispara la flecha N": el vuelo lo calcula el
  // cliente y despues avisa donde cayo. Asi lo hace el original.
  red.addEventListener('UPDATEARROW', (e) => {
    const f = e.detail;
    estado.flechas.set(parseInt(f[1], 10),
                       { pic: parseInt(f[3], 10) || 0, alcance: parseInt(f[4], 10) || 5 });
  });
  red.addEventListener('CHECKARROWS', (e) => {
    const num = parseInt(e.detail[2], 10);
    const def = estado.flechas.get(num) || { pic: num, alcance: 6 };
    const j = estado.jugador;
    estado.efectos.flecha(def.pic, j.x, j.y, j.dir, def.alcance, (x, y) => {
      const sobre = [...estado.npcs.values()].some(n => n.x === x && n.y === y);
      estado.red.flechaCayo(sobre ? 1 : 0, num, x, y);
    });
  });

  // --- hechizos ---
  red.addEventListener('SPELLS', (e) => {
    estado.hechizos = e.detail.slice(1, 21).map(v => parseInt(v, 10) || 0);
    pintarHechizos();
  });
  red.addEventListener('UPDATESPELL', (e) => {
    estado.ui.definirHechizo(parseInt(e.detail[1], 10), e.detail[2].trim());
    pintarHechizos();
  });
  red.addEventListener('SPELLANIM', (e) => {
    const f = e.detail;
    estado.efectos.magia(parseInt(f[1], 10), parseInt(f[2], 10), parseInt(f[3], 10));
  });

  // --- ambiente ---
  red.addEventListener('WEATHER', (e) => {
    estado.render.clima = parseInt(e.detail[1], 10) || 0;
  });
  red.addEventListener('TIME', (e) => {
    estado.render.noche = parseInt(e.detail[1], 10) === 1;
  });

  // --- sonidos que pide el servidor ---
  // El servidor manda un NOMBRE DE SUCESO, no un fichero: "attack" suena con
  // sword.wav. La correspondencia sale de la tabla del propio cliente.
  const SONIDOS = {
    attack: 'sword.wav', critical: 'critical.wav', miss: 'miss.wav',
    key: 'key.wav', warp: 'warp.wav', pain: 'pain.wav', thunder: 'Thunder.wav',
  };
  red.addEventListener('SOUND', (e) => {
    const n = (e.detail[1] || '').trim();
    if (!n) return;
    // las magias van numeradas: magic1.wav, magic2.wav...
    const f = SONIDOS[n] || (n.endsWith('.wav') ? n : n + '.wav');
    estado.audio.efecto(f);
  });
  red.addEventListener('LEVELUP', () => {
    estado.audio.efecto('level.wav');
    estado.ui.chat('¡Has subido de nivel!', '#e8c86a');
  });
  red.addEventListener('ITEMBREAK', (e) =>
    estado.ui.chat(`Se te ha roto ${estado.ui.nombreDe(parseInt(e.detail[1], 10))}.`, '#e07a6a'));

  red.addEventListener('ONLINELIST', (e) => {
    $('#online').textContent = e.detail.slice(2).filter(s => s).join(', ') || '—';
  });

  // --- datos que alimentan la interfaz ---
  red.addEventListener('UPDATEITEM', (e) => {
    const f = e.detail;
    estado.ui.definirItem(parseInt(f[1], 10), {
      nombre: f[2].trim(), pic: parseInt(f[3], 10) || 0, tipo: parseInt(f[4], 10) || 0,
      data1: parseInt(f[5], 10) || 0,
      data2: parseInt(f[6], 10) || 0,          // dibujo que se le ve PUESTO al personaje
      data3: parseInt(f[7], 10) || 0,          // numero de flecha si es un arco
      reqStr: parseInt(f[8], 10) || 0,
      reqDef: parseInt(f[9], 10) || 0,
      reqSpeed: parseInt(f[10], 10) || 0,
      adds: [13,14,15,16,17,18,19,20].map(i => parseInt(f[i], 10) || 0),
      desc: (f[21] || '').trim(),
    });
  });

  // El servidor manda el inventario y el equipo a TODO EL MAPA, no solo a su
  // dueno, y cada paquete lleva dentro el indice del jugador al que pertenece.
  // Sin comprobarlo, lo que hace otro jugador te lo aplicas tu: se te vacian
  // ranuras que no tocaste, se te cambia lo que llevas puesto, y a la siguiente
  // accion el servidor te expulsa por "(Coneccion pobre)" porque tu inventario
  // ya no coincide con el suyo.
  //
  // Comprobado con dos sesiones a la vez: pc2 (indice 2) recibia el
  // PLAYERINVUPDATE de Webtest (indice 1) al tirar este su ranura 3, y se
  // vaciaba su propia ranura 3. Mientras miIndice todavia no se sabe (llega en
  // LOGINOK, antes que el inventario) no se filtra nada.
  const deOtroJugador = (campo) => {
    const i = parseInt(campo, 10);
    return estado.miIndice !== null && !isNaN(i) && i !== estado.miIndice;
  };

  // PLAYERINV: indice del jugador y luego 24 tripletes (item, cantidad, durab).
  red.addEventListener('PLAYERINV', (e) => {
    if (deOtroJugador(e.detail[1])) return;
    estado.ui.setInventario(e.detail);
  });

  // PLAYERINVUPDATE: ranura, indice del jugador, item, cantidad, durabilidad.
  // Capturado tirando 100 monedas de una pila de 400: llega `12 2 12 300 0 2`.
  red.addEventListener('PLAYERINVUPDATE', (e) => {
    const f = e.detail;
    if (deOtroJugador(f[2])) return;
    estado.ui.actualizaRanura(parseInt(f[1], 10) - 1, {
      num:  parseInt(f[3], 10) || 0,
      cant: parseInt(f[4], 10) || 0,
      dur:  parseInt(f[5], 10) || 0,
    });
  });

  // itemworn: indice del jugador y las 7 ranuras de equipo. `setEquipo` ya lee
  // desde el campo 2 por eso mismo. (PLAYERWORNEQ no lo manda este servidor,
  // pero se filtra igual porque el resto del codigo los trata como el mismo.)
  // Los `pic` de cada ranura, para pintarlos sobre el personaje.
  // El dibujo que se le ve puesto es el MISMO `Pic` del objeto: en el editor
  // del cliente hay un unico "Sprite del Item". Las filas bajas de la hoja
  // (alas, armaduras, cascos de perfil, baculos) estan pensadas justo para
  // eso, y se eligen desde ese mismo selector.
  const picsDeEquipo = (campos) => [1, 2, 3, 4, 5, 6, 7].map((i) => {
    const num = parseInt(campos[i + 1], 10) || 0;
    const d = num && estado.ui.items.get(num);
    return d ? d.pic : 0;
  });

  const refrescarEquipo = (e) => {
    const quien = parseInt(e.detail[1], 10);
    const pics = picsDeEquipo(e.detail);

    // `itemworn` se emite a TODO el mapa con el indice de su dueno, asi que de
    // aqui sale tambien el equipo de los demas. Antes se descartaba y cada uno
    // se veia solo a si mismo vestido. Se guarda por indice porque el paquete
    // puede llegar antes que el PLAYERDATA que crea a ese jugador.
    if (!isNaN(quien)) {
      estado.equipoDe.set(quien, pics);
      const otro = estado.otros.get(quien);
      if (otro) { otro.hojaItems = estado.hojaItems; otro.puesto = pics; }
    }

    if (deOtroJugador(e.detail[1])) return;
    estado.ui.setEquipo(e.detail);
    estado.jugador.puesto = pics;
  };
  red.addEventListener('PLAYERWORNEQ', refrescarEquipo);
  red.addEventListener('ITEMWORN',     refrescarEquipo);
  red.addEventListener('PLAYERHP', (e) => {
    estado.ui.setVital('hp', +e.detail[2], +e.detail[1]);
    estado.jugador.hp = +e.detail[2]; estado.jugador.hpMax = +e.detail[1];
  });
  red.addEventListener('PLAYERMP', (e) => estado.ui.setVital('mp', +e.detail[2], +e.detail[1]));
  red.addEventListener('PLAYERSP', (e) => estado.ui.setVital('sp', +e.detail[2], +e.detail[1]));
  red.addEventListener('PLAYERPOINTS', (e) => estado.ui.setPuntos(e.detail[1]));
  red.addEventListener('PLAYERSTATSPACKET', (e) => estado.ui.setStats(e.detail));

  // nombres de las razas, para mostrar la del personaje
  red.addEventListener('CLASSESDATA', (e) => {
    const f = e.detail;
    const n = parseInt(f[1], 10) + 1;
    estado.clases = [];
    for (let k = 0; k < n; k++) estado.clases.push(f[2 + k * 9]);
    estado.ui.setRaza(estado.clases[estado.miClase] || '');
  });

  // El mismo listado pero con todo lo que hace falta para el formulario de
  // creacion. El adaptador ya le ha quitado el campo Suerte que este cliente
  // no conoce, asi que quedan 11 campos por raza.
  red.addEventListener('NEWCHARCLASSES', (e) => {
    const f = e.detail;
    const n = parseInt(f[1], 10) + 1;
    const PASO = 11;
    estado.razas = [];
    for (let k = 0; k < n; k++) {
      const r = f.slice(2 + k * PASO, 2 + (k + 1) * PASO);
      estado.razas.push({
        num: k, nombre: r[0],
        hp: r[1], mp: r[2], sp: r[3],
        fue: r[4], def: r[5], vel: r[6], mag: r[7],
        // `Locked` = raza que el servidor no deja elegir todavia.
        cerrada: parseInt(r[10], 10) !== 0,
      });
    }
    estado.clases = estado.razas.map((r) => r.nombre);
    if (estado.pintarRazas) estado.pintarRazas();
  });

  // El servidor manda el color de cada mensaje como indice QBColor de VB6.
  for (const p of ['GLOBALMSG', 'PLAYERMSG', 'BROADCASTMSG', 'MAPMSG', 'ADMINMSG',
                   'ALERTMSG', 'PLAINMSG', 'SAYMSG', 'GUILDMSG', 'EMOTEMSG']) {
    red.addEventListener(p, (e) => estado.ui.chat(e.detail[1], color(e.detail[2])));
  }

  red.addEventListener('ONLINELIST', (e) => {
    pintarOnline(e.detail.slice(2).filter(s => s));
  });

  red.addEventListener('GLOBALMSG', (e) => { $('#cartel').textContent = e.detail[1] || ''; });

  red.conectar()
    .then(() => { estadoRed('Conectando con el servidor...'); red.login(cuenta, clave); })
    .catch(() => estadoRed('El server esta apagado, volve a intentarlo mas tarde', 'mal'));
}

function atacar() {
  const j = estado.jugador;
  if (performance.now() < j.atacandoHasta) return;   // no encadenar golpes
  j.atacar();
  estado.audio.efecto('sword.wav');
  if (estado.enLinea) estado.red.atacar();
}

function usarRanura(i) {
  if (!estado.enLinea) { estado.ui.chat('No estas conectado al servidor.', '#e07a6a'); return; }
  const r = estado.ui.inv[i];
  if (!r || !r.num) return;
  // El servidor guarda el equipo por NUMERO de objeto, no por ranura, asi que
  // dos copias iguales le resultan indistinguibles. Aqui al menos se recuerda
  // desde que ranura se uso, para marcar esa y no siempre la primera.
  estado.ui.ultimaRanura.set(r.num, i);
  estado.red.enviar('USEITEM', i + 1);     // el servidor cuenta las ranuras desde 1
}

async function iniciar() {
  const cv = $('#pantalla');
  const barra = $('#progreso');
  const recursos = await cargarTodo((hechas, total) => {
    barra.style.width = `${Math.round(100 * hechas / total)}%`;
  });

  estado.mapas = recursos.mapas;
  estado.audio = new Audio2('assets/sfx');
  estado.musica = new Musica('assets/music', 'assets');
  estado.render = new Render(cv, recursos.tiles);
  estado.hojaSprites = recursos.sprites;
  estado.hojaGrandes = recursos.grandes;
  estado.ui = new Interfaz(recursos.items);
  estado.efectos = new Efectos(recursos.flechas, recursos.hechizos);
  estado.render.hojaItems = recursos.items;
  estado.hojaItems = recursos.items;
  estado.jugador = new Actor(recursos.sprites, 9, 15, 15);
  estado.jugador.soyYo = true;
  estado.jugador.hojaItems = recursos.items;
  estado.jugador.nombre = '';

  const primero = estado.mapas.has(1) ? 1 : estado.mapas.keys().next().value;
  entrarAMapa(primero, 15, 15);

  $('#carga').style.display = 'none';
  abrirMenu();
  $('#stats').textContent =
    `${estado.mapas.size} mapas · cargado en ${(recursos.ms / 1000).toFixed(2)} s`;

  addEventListener('keydown', (e) => {
    // Mientras se escribe en el chat el teclado es del chat, no del juego.
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    // Ojo: "arriba" es la direccion 0, que en JavaScript es falso. Hay que
    // comprobar la existencia de la clave, no la verdad del valor.
    if (e.code in MAPA_TECLAS) {
      teclas.add(e.code);
      pendiente = MAPA_TECLAS[e.code];
      e.preventDefault();
    }
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') { atacar(); e.preventDefault(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') teclas.add(e.code);
    if (e.code === 'Digit1') estado.render.escala = 1;
    if (e.code === 'Digit2') estado.render.escala = 2;
    if (e.code === 'Digit3') estado.render.escala = 3;
  });
  addEventListener('keyup', (e) => teclas.delete(e.code));

  // Las teclas que documenta la ayuda del propio juego:
  //   Insert lanza la magia elegida · F6/F7/F8 restauran HP/MP/SP
  //   Fin gira sin moverse del sitio · Espacio recoge del suelo
  addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    switch (e.code) {
      case 'Insert':  lanzarMagia(); break;
      case 'F6':      usarPocion(5, 'vida');  break;
      case 'F7':      usarPocion(6, 'mana');  break;
      case 'F8':      usarPocion(7, 'SP');    break;
      case 'End':     girar(); break;
      case 'Space':   if (estado.enLinea) estado.red.recoger(); break;
      default:        return;
    }
    e.preventDefault();
  });

  // Si la ventana pierde el foco con una tecla pulsada, el keyup nunca llega y
  // el personaje caminaria solo para siempre. Se sueltan todas.
  addEventListener('blur', () => { teclas.clear(); pendiente = null; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { teclas.clear(); pendiente = null; }
  });

  // Doble clic sobre el mapa: seleccionar blanco, igual que el original
  // ("haces 2 click sobre el blanco ya sea oponente o criatura").
  cv.addEventListener('dblclick', (ev) => {
    if (!estado.enLinea) return;
    const r = cv.getBoundingClientRect();
    const escalaX = cv.width / r.width, escalaY = cv.height / r.height;
    const { cx, cy } = estado.render.camara(estado.jugador.px, estado.jugador.py);
    const x = (((ev.clientX - r.left) * escalaX) / estado.render.escala + cx) / TS | 0;
    const y = (((ev.clientY - r.top) * escalaY) / estado.render.escala + cy) / TS | 0;
    estado.red.buscar(x, y);
  });

  $('#irA').addEventListener('change', (e) => {
    const id = parseInt(e.target.value, 10);
    if (!estado.mapas.has(id)) return;
    // Estando conectado el salto lo tiene que hacer el SERVIDOR, o el juego
    // seguiria creyendote en el mapa anterior. Sin conexion es solo mirar.
    if (estado.enLinea) estado.red.enviar('WARPTO', id);
    else entrarAMapa(id, 15, 15);
  });

  const lista = $('#irA');
  for (const [id, m] of [...estado.mapas].sort((a, b) => a[0] - b[0])) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = `${id} — ${m.nombre || '(vacio)'}`;
    if (id === primero) o.selected = true;
    lista.appendChild(o);
  }

  // Pestanas. En el cliente la franja de abajo es SIEMPRE el chat: lo que
  // cambia es el recuadro del dragon. Y Clanes y Opciones abren ventanas
  // flotantes sobre el mapa en vez de ocupar ese recuadro.
  const VENTANAS = { clanes: '#v-clanes', opciones: '#v-opciones' };
  document.querySelectorAll('.tab').forEach(b => {
    b.addEventListener('click', () => {
      const cual = b.dataset.tab;
      if (VENTANAS[cual]) {
        const v = $(VENTANAS[cual]);
        v.classList.toggle('visible');
        return;                       // el recuadro no cambia
      }
      if (cual === 'chat') { $('#entrada').focus(); return; }
      // Pulsar una pestana SIEMPRE muestra su panel; el dragon solo se ve al
      // entrar, hasta que se elige algo. (Hacerlo conmutable despistaba: un
      // segundo clic cerraba el panel.)
      estado.ui.mostrarPestana(cual);
      document.querySelectorAll('.tab').forEach(t =>
        t.classList.toggle('activa', t.dataset.tab === cual));
    });
  });
  document.querySelectorAll('[data-cerrar]').forEach(b => {
    b.addEventListener('click', () => b.closest('.ventana').classList.remove('visible'));
  });

  // flechas del inventario
  const desplazar = (d) => {
    const max = 24 - COLS_INV * FILAS_INV;
    estado.ui.desplazamiento = Math.max(0, Math.min(max, estado.ui.desplazamiento + d * COLS_INV));
    estado.ui.pintaInventario();
  };
  $('#btn-sube').addEventListener('click', () => desplazar(-1));
  $('#btn-baja').addEventListener('click', () => desplazar(1));
  $('#btn-lanzar').addEventListener('click', lanzarMagia);

  // elegir magia con un clic en la lista
  $('#lista-magias').addEventListener('click', (ev) => {
    const d = ev.target.closest('div[data-i]');
    if (!d) return;
    const i = +d.dataset.i;
    if (!estado.hechizos[i]) return;
    estado.hechizoElegido = i + 1;
    pintarHechizos();
  });

  // El boton R del cliente: "refresca la pantalla y sirve para cuando nos
  // quedamos pegados por lag".
  $('#b-refrescar').addEventListener('click', () => {
    if (estado.enLinea) estado.red.refrescar();
  });
  // Las casillas de la ventana de Opciones hacen lo que dicen.
  const op = (id, fn) => {
    const c = $(id);
    if (c) { c.addEventListener('change', () => fn(c.checked)); fn(c.checked); }
  };
  op('#o-pnombre', v => { estado.jugador.verNombre = v;
                          for (const a of estado.otros.values()) a.verNombre = v; });
  op('#o-nnombre', v => { for (const a of estado.npcs.values()) a.verNombre = v; });
  op('#o-pbarra',  v => estado.render.opciones.barraJugador = v);
  op('#o-nbarra',  v => estado.render.opciones.barraNpc = v);
  op('#o-musica',  v => {
    if (!estado.musica) return;
    estado.musica.activa = v;
    if (!v) estado.musica.parar();
    else if (estado.mapa) estado.musica.poner(estado.mapa.musica);
  });
  op('#o-sonidos', v => { if (estado.audio) estado.audio.activo = v; });

  $('#b-ayuda').addEventListener('click', () => {
    for (const l of AYUDA) estado.ui.chat(l, '#e8c86a');
    $('#entrada').focus();
  });

  // inventario: seleccionar con un clic, usar con doble clic
  const cvInv = $('#cv-inv');
  const ranuraEn = (ev) => {
    const r = cvInv.getBoundingClientRect();
    // el marco se escala para caber en la ventana: hay que deshacer la escala
    const k = cvInv.width / r.width;
    const cx = (((ev.clientX - r.left) * k) / CELDA_INV) | 0;
    const cy = (((ev.clientY - r.top) * k) / CELDA_INV) | 0;
    if (cx < 0 || cx >= COLS_INV || cy < 0 || cy >= FILAS_INV) return null;
    const i = cy * COLS_INV + cx + estado.ui.desplazamiento;
    return i < 24 ? i : null;
  };
  // el globo con las estadisticas al pasar por encima
  const globo = $('#globo');
  const ocultarGlobo = () => globo.classList.remove('visible');
  const mostrarGlobo = (num, ev) => {
    const lineas = num ? estado.ui.globoDe(num) : null;
    if (!lineas) { ocultarGlobo(); return; }
    globo.innerHTML = '';
    for (const l of lineas) {
      const d = document.createElement('div');
      d.textContent = l.t;
      if (l.c) d.className = l.c;
      globo.appendChild(d);
    }
    globo.classList.add('visible');
    // se coloca dentro del marco, en coordenadas del propio marco
    const marco = $('#juego').getBoundingClientRect();
    const k = 950 / marco.width;
    globo.style.left = Math.round((ev.clientX - marco.left) * k + 12) + 'px';
    globo.style.top  = Math.round((ev.clientY - marco.top) * k - 130) + 'px';
  };
  cvInv.addEventListener('mousemove', (ev) => {
    const i = ranuraEn(ev);
    const r = i !== null ? estado.ui.inv[i] : null;
    mostrarGlobo(r && r.num, ev);
  });
  cvInv.addEventListener('mouseleave', ocultarGlobo);

  // --- panel de equipo: mismo globo, y doble clic para quitarse algo ---
  const cvEq = $('#cv-equipo');
  const ranuraEquipo = (ev) => {
    const r = cvEq.getBoundingClientRect();
    const k = cvEq.width / r.width;
    const x = (ev.clientX - r.left) * k, y = (ev.clientY - r.top) * k;
    for (let i = 0; i < SITIOS_EQUIPO.length; i++) {
      const [sx, sy] = SITIOS_EQUIPO[i];
      if (x >= sx - 2 && x < sx + 33 && y >= sy - 2 && y < sy + 33) return i;
    }
    return null;
  };
  cvEq.addEventListener('mousemove', (ev) => {
    const i = ranuraEquipo(ev);
    mostrarGlobo(i !== null ? estado.ui.equipo[i] : 0, ev);
  });
  cvEq.addEventListener('mouseleave', ocultarGlobo);
  // Para quitarse una pieza el cliente manda USEITEM con la ranura del
  // INVENTARIO donde esta ese objeto: el servidor lo trata como un interruptor.
  cvEq.addEventListener('dblclick', (ev) => {
    const i = ranuraEquipo(ev);
    if (i === null) return;
    const num = estado.ui.equipo[i];
    if (!num) return;
    const enInv = estado.ui.inv.findIndex(r => r && r.num === num);
    if (enInv >= 0) usarRanura(enInv);
  });

  cvInv.addEventListener('click', (ev) => {
    const i = ranuraEn(ev);
    if (i === null) return;
    // Antes aqui se escribia en un cuadro `#detalle` que ya no existe: el
    // dereferencia a null reventaba el manejador ANTES de repintar, y por eso
    // el borde rojo de seleccion no aparecia nunca.
    estado.ui.seleccion = i;
    estado.ui.pintaInventario();
  });
  // Un clic elige (borde rojo); DOBLE clic usa el objeto, que segun el tipo
  // lo equipa, lo consume o lo aprende. Igual que en el cliente.
  cvInv.addEventListener('dblclick', (ev) => {
    const i = ranuraEn(ev);
    if (i !== null) { ocultarGlobo(); usarRanura(i); }
  });
  $('#btn-usar').addEventListener('click', () => {
    if (estado.ui.seleccion !== null) usarRanura(estado.ui.seleccion);
  });
  $('#btn-tirar').addEventListener('click', arrojar);

  // repartir puntos de caracteristicas
  document.querySelectorAll('.subir').forEach(b => {
    b.addEventListener('click', () => {
      if (estado.enLinea) estado.red.enviar('usestatpoint', b.dataset.stat);
    });
  });

  // chat y comandos
  $('#entrada').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const t = ev.target.value.trim();
    ev.target.value = '';
    if (!t || !estado.enLinea) return;
    mandarChat(t);
  });

  // Los navegadores bloquean el audio hasta que el usuario interactua.
  // Al primer clic o tecla se arranca la musica del mapa actual.
  const despertarAudio = () => {
    const enMenu = $('#menu').style.display !== 'none';
    if (estado.musica) estado.musica.poner(enMenu ? 'Title.mid' : (estado.mapa && estado.mapa.musica));
    removeEventListener('pointerdown', despertarAudio);
    removeEventListener('keydown', despertarAudio);
  };
  addEventListener('pointerdown', despertarAudio);
  addEventListener('keydown', despertarAudio);

  // --- menu principal ---
  // Las opciones ya estan escritas en el arte original: aqui solo se ponen las
  // zonas pulsables encima, en las coordenadas medidas sobre la imagen.
  const panelMenu = $('#panelmenu');
  // Cada pantalla: la imagen de fondo (el arte ya trae escritas sus opciones,
  // por eso las zonas van vacias), que se puede pulsar y que formulario se ve.
  const PANTALLAS = {
    menu:        { zonas: ['#z-ingresar', '#z-nueva', '#z-borrar', '#z-info'] },
    login:       { zonas: ['#z-aceptar'],  form: '#entrar' },
    nueva:       { zonas: ['#z-crearc'],   form: '#entrar',  fondo: 'cuenta' },
    borrarcta:   { zonas: ['#z-borrarc'],  form: '#entrar',  fondo: 'borrarc' },
    personajes:  { zonas: ['#z-pj-crear', '#z-pj-borrar', '#z-pj-entrar'], form: '#ranuras' },
    nuevopj:     { zonas: ['#z-pj-crearlo'], form: '#crearpj', fondo: 'pjnuevo' },
    credito:     { zonas: [] },
  };
  const ZONAS = [...new Set(Object.values(PANTALLAS).flatMap((p) => p.zonas))];
  const FORMS = ['#entrar', '#ranuras', '#crearpj'];

  function pantallaMenu(cual) {
    const p = PANTALLAS[cual] || PANTALLAS.menu;
    panelMenu.className = cual === 'menu' ? '' : (p.fondo || cual);
    ZONAS.forEach((id) => { $(id).style.display = p.zonas.includes(id) ? 'block' : 'none'; });
    $('#z-volver').style.display = cual === 'menu' ? 'none' : 'block';
    FORMS.forEach((id) => $(id).classList.toggle('visible', p.form === id));
    $('#srvestado').style.display = cual === 'credito' ? 'none' : 'block';
    estado.pantalla = cual;
    estado.confirmaBorrar = false;
    if (p.form === '#entrar') $('#cuenta').focus();
    if (cual === 'nuevopj') $('#pjnombre').focus();
  }

  $('#z-ingresar').addEventListener('click', () => { estadoRed(''); pantallaMenu('login'); });
  $('#z-info').addEventListener('click',     () => { estadoRed(''); pantallaMenu('credito'); });
  $('#z-aceptar').addEventListener('click', conectar);

  // Regresar depende de donde estes: del formulario de personaje vuelves a la
  // lista, y de la lista SALES de la cuenta (la sesion ya esta abierta).
  $('#z-volver').addEventListener('click', () => {
    estadoRed('');
    if (estado.pantalla === 'nuevopj') { pantallaMenu('personajes'); return; }
    if (estado.pantalla === 'personajes' && estado.red) {
      estado.cerrandoAdrede = true;
      estado.red.cerrar();
      estado.red = null;
    }
    pantallaMenu('menu');
  });

  // --- crear y borrar cuenta ---
  async function accionCuenta(crear) {
    const cuenta = $('#cuenta').value.trim(), clave = $('#clave').value;
    if (cuenta.length < 3 || clave.length < 3) {
      estadoRed('Tu nombre y contraseña tienen que tener tres caracteres de largo como minimo', 'mal');
      return;
    }
    estadoRed(crear ? 'Creando la cuenta...' : 'Borrando la cuenta...');
    try {
      const t = await conexionSuelta((r) =>
        crear ? r.crearCuenta(cuenta, clave) : r.borrarCuenta(cuenta, clave));
      const bien = esBueno(t);
      // Recien creada la cuenta lo siguiente es entrar, con los datos puestos.
      if (bien && crear) pantallaMenu('login');
      if (bien && !crear) $('#clave').value = '';
      estadoRed(t, bien ? null : 'mal');
    } catch (e) {
      estadoRed(e.message, 'mal');
    }
  }
  $('#z-nueva').addEventListener('click',   () => { estadoRed(''); pantallaMenu('nueva'); });
  $('#z-borrar').addEventListener('click',  () => { estadoRed(''); pantallaMenu('borrarcta'); });
  $('#z-crearc').addEventListener('click',  () => accionCuenta(true));
  $('#z-borrarc').addEventListener('click', () => accionCuenta(false));

  // --- eleccion de personaje ---
  const ranuraActual = () => estado.ranuras[estado.ranuraSel - 1];

  $('#z-pj-entrar').addEventListener('click', () => {
    const r = ranuraActual();
    if (!r || !r.nombre) { estadoRed('No existe un personaje!', 'mal'); return; }
    estadoRed('Cargando datos del juego...');
    estado.red.elegirPersonaje(estado.ranuraSel);
  });

  $('#z-pj-crear').addEventListener('click', () => {
    const r = ranuraActual();
    if (r && r.nombre) { estadoRed('Ya existe un personaje!', 'mal'); return; }
    abrirCrearPersonaje();
  });

  // Borrar pregunta antes, con la frase del cliente: el primer clic avisa y el
  // segundo borra de verdad. Cambiar de ranura o de pantalla cancela.
  $('#z-pj-borrar').addEventListener('click', () => {
    const r = ranuraActual();
    if (!r || !r.nombre) { estadoRed('No existe un personaje!', 'mal'); return; }
    if (!estado.confirmaBorrar) {
      estado.confirmaBorrar = true;
      estadoRed('Estas seguro que quieres borrar tu personaje? Pulsa Borrar otra vez.', 'mal');
      return;
    }
    estado.confirmaBorrar = false;
    estado.red.borrarPersonaje(estado.ranuraSel);
  });

  // --- creacion de personaje ---
  // Las razas y sus atributos llegan en NEWCHARCLASSES, que se pide al abrir
  // el formulario: asi siempre se ve lo que el servidor tiene HOY.
  function pintarRazas() {
    const sel = $('#pjraza'), antes = sel.value;
    sel.innerHTML = '';
    for (const r of estado.razas) {
      if (r.cerrada) continue;            // el servidor no la deja elegir
      const o = document.createElement('option');
      o.value = r.num; o.textContent = r.nombre;
      sel.appendChild(o);
    }
    if (antes && [...sel.options].some((o) => o.value === antes)) sel.value = antes;
    pintarAtributos();
  }
  estado.pintarRazas = pintarRazas;

  function pintarAtributos() {
    const r = estado.razas.find((x) => String(x.num) === $('#pjraza').value);
    $('#pjstats').textContent = r
      ? `HP ${r.hp} · MP ${r.mp} · SP ${r.sp} · Fuerza ${r.fue} · Defensa ${r.def} · Velocidad ${r.vel} · Magia ${r.mag}`
      : '';
  }
  $('#pjraza').addEventListener('change', pintarAtributos);

  // El sexo elige entre MaleSprite y FemaleSprite de la raza.
  let sexoElegido = 0;
  $('#sexos').addEventListener('click', (e) => {
    const s = e.target.dataset && e.target.dataset.sexo;
    if (s === undefined) return;
    sexoElegido = parseInt(s, 10);
    [...$('#sexos').children].forEach((c) => c.classList.toggle('sel', c.dataset.sexo === s));
  });

  function abrirCrearPersonaje() {
    $('#pjnombre').value = '';
    estadoRed('');
    pantallaMenu('nuevopj');
    if (estado.razas.length) pintarRazas();
    estado.red.pedirClases();
  }

  function crearPersonaje() {
    const nombre = $('#pjnombre').value.trim();
    if (nombre.length < 3) {
      estadoRed('El nombre del personaje tiene que tener tres caracteres como minimo', 'mal');
      return;
    }
    // El servidor rechaza los signos, asi que se avisa antes con su frase.
    if (!/^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ]+$/.test(nombre)) {
      estadoRed('No puedes utilizar signos en tu nombre', 'mal');
      return;
    }
    const raza = parseInt($('#pjraza').value, 10);
    if (isNaN(raza)) { estadoRed('Todavia no se que razas hay: espera un momento', 'mal'); return; }
    estadoRed('Creando el personaje...');
    estado.red.crearPersonaje(nombre, sexoElegido, raza, estado.ranuraSel);
  }
  $('#z-pj-crearlo').addEventListener('click', crearPersonaje);
  $('#pjnombre').addEventListener('keydown', (e) => { if (e.key === 'Enter') crearPersonaje(); });
  $('#z-salir').addEventListener('click', () => {
    if (estado.musica) estado.musica.parar();
    estadoRed('Gracias por jugar a Dream Blue Online');
  });
  $('#z-salirdbo').addEventListener('click', () => {
    if (estado.red && estado.red.ws) estado.red.ws.close();
  });
  // Los dos campos son los mismos en las tres pantallas que los usan, asi que
  // Enter tiene que hacer lo de la pantalla en la que estas, no siempre entrar.
  const AL_PULSAR_ENTER = {
    login:     conectar,
    nueva:     () => accionCuenta(true),
    borrarcta: () => accionCuenta(false),
  };
  for (const id of ['#cuenta', '#clave']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const hacer = AL_PULSAR_ENTER[estado.pantalla];
      if (hacer) hacer();
    });
  }
  estado.pantallaMenu = pantallaMenu;
  pantallaMenu('menu');

  // El marco mide 950x660 fijos, y debajo va la linea de informacion, que
  // arranca en 664 y ocupa unos 14: 678 en total.
  //
  // Se encoge para caber en ventanas pequenas, pero NO se agranda: a escala 1
  // el marco mide lo mismo que la ventana del cliente de Windows, que es como
  // se quiere ver. Antes llegaba a 1.6 y en una pantalla alta el marco crecia
  // hasta comerse la linea de abajo, que se salia por el borde (el zoom sale
  // del centro, asi que al crecer se pierde por arriba y por abajo).
  const ALTO_TOTAL = 678;
  const ajustar = () => {
    const k = Math.min(innerWidth / 950, innerHeight / ALTO_TOTAL, 1);
    $('#escala').style.transform = `scale(${k})`;
  };
  addEventListener('resize', ajustar);
  ajustar();

  // expuesto para inspeccionar desde la consola del navegador
  window.__dbo = { estado, DIAG };

  fps.t = performance.now();
  requestAnimationFrame(bucle);
}

iniciar().catch(e => {
  document.querySelector('#carga').innerHTML =
    `<p style="color:#f66">Error al iniciar: ${e.message}</p>`;
  console.error(e);
});
