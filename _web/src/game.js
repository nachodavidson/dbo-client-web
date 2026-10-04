import { ANCHO, ALTO, TS, tipoEn, datoEn, idx, esSolido, mapaDeCampos } from './maps.js';
import { Render } from './render.js?v=10';
import { Actor, DIR } from './sprite.js';
import { Audio2 } from './audio.js';
import { Red } from './red.js';
import { Interfaz, COLS_INV, FILAS_INV, CELDA_INV, SITIOS_EQUIPO } from './ui.js';
import { Musica } from './midi.js';
import { Efectos, color } from './efectos.js';

const MS_POR_CASILLA = 233;     // andar, ~23% mes lent que 190
const MS_CORRER = 147;
// Tope de busqueda, no cuenta real: se cargan tiles0, tiles1... hasta que
// falte uno. Esta instalacion tiene 7; otras tienen mas.
const HOJAS_TILES_MAX = 32;

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

// Cuantas hojas de tiles hay NO se sabe de antemano: depende de la
// instalacion (aqui 7, el cliente de Dreaminze tiene 11). Se cargan hasta que
// falte la siguiente, asi nadie tiene que acordarse de cambiar un numero.
async function cargarTiles(progreso) {
  const hojas = [];
  for (let i = 0; i < HOJAS_TILES_MAX; i++) {
    try {
      hojas.push(await cargarHoja(`tiles${i}`));
      progreso();
    } catch (e) {
      break;
    }
  }
  if (!hojas.length) throw new Error('no hay ni una hoja de tiles en assets/');
  return hojas;
}

async function cargarTodo(progreso) {
  const t0 = performance.now();
  // Las hojas de tiles van en serie (hay que ver donde se acaban); el resto en
  // paralelo. El total es aproximado: la barra solo tiene que avanzar.
  const aviso = () => progreso(++hechas, PASOS);
  let hechas = 0;
  const PASOS = HOJAS_TILES_MAX + 6;

  const tiles = await cargarTiles(aviso);
  const tareas = ['sprites', 'bigsprites', 'items', 'arrows', 'spells']
    .map((n) => cargarHoja(n));
  const res = await Promise.all(tareas.map((p) => p.then((r) => { aviso(); return r; })));

  return {
    tiles, sprites: res[0], grandes: res[1], items: res[2],
    flechas: res[3], hechizos: res[4],
    ms: performance.now() - t0,
  };
}

// Sube con cada cambio de mapa efectivo. Sirve para descartar avisos del
// servidor que llegan tarde: si el contador cambio desde que se recibio el
// aviso, ese aviso ya no habla del mapa en el que estamos.
let seqMapa = 0;
let ajusteHasta = 0;
let saltoHasta = 0;
let forzarPos = false;
let tSalto = 0;
function pausaDeSalto() {
  saltoHasta = performance.now() + 350;
  clearTimeout(tSalto);
  tSalto = setTimeout(() => { saltoHasta = 0; }, 350);
}
function finDeSalto() {
  saltoHasta = 0;
  clearTimeout(tSalto);
}
function refrescarPosicion() {
  if (!estado.enLinea || !estado.red) return;
  forzarPos = true;
  ajusteHasta = performance.now() + 1500;
  pausaDeSalto();
  estado.red.refrescar();
}

function fijarMiPos(x, y) {
  const j = estado.jugador;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  j.x = x; j.y = y; j.px = x * TS; j.py = y * TS;
  j.moviendo = false; j.destino = null;
}

// Caja negra de los saltos de mapa. Los fallos de warp solo aparecen cruzando
// deprisa, y eso no se puede reproducir a mano: hay que mirar el registro
// despues. Se consulta con `estado.diagWarp` en la consola del navegador.
const DIAG_MAX = 120;
function anotarSalto(origen, datos) {
  estado.diagWarp.push({ t: Math.round(performance.now()), origen, ...datos });
  if (estado.diagWarp.length > DIAG_MAX) estado.diagWarp.shift();
}

let esperandoMapa = 0;
let mapaPendiente = null;

function aplicarMapaRecibido(m) {
  estado.mapas.set(m.id, m);
  if (estado.render) estado.render.cache.delete(m.id);
  const pendiente = mapaPendiente && mapaPendiente.id === m.id ? mapaPendiente : null;
  if (esperandoMapa === m.id) esperandoMapa = 0;
  if (pendiente) {
    mapaPendiente = null;
    entrarAMapa(m.id, pendiente.x, pendiente.y, 'MAPDATA');
    if (pendiente.dir) estado.jugador.dir = pendiente.dir;
    return;
  }
  if (estado.mapa && estado.mapa.id === m.id) {
    m.abiertas = estado.mapa.abiertas || new Set();
    estado.mapa = m;
    if (estado.render) {
      estado.render.componer(m);
      estado.render.nombreMapa = (m.nombre || '').trim();
      estado.render.moralMapa = m.moral | 0;
    }
    const el = document.getElementById('mapa');
    if (el) el.textContent = `${m.nombre || '(sin nombre)'}  ·  mapa ${m.id}`;
    const mus = document.getElementById('musica');
    if (mus) mus.textContent = m.musica || '—';
    if (estado.musica) estado.musica.poner(m.musica);
  }
  const lista = document.getElementById('irA');
  if (lista && !lista.querySelector('option[value="' + m.id + '"]')) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.id + ' — ' + (m.nombre || '');
    lista.appendChild(o);
  }
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
  // En línia el servidor ja ha enviat MAPNPCDATA i MAPITEMDATA ABANS del
  // PLAYERDATA que entra al mapa. Esborrar-los aquí els feia desaparèixer
  // fins que es premia R (el refresh no canvia de mapa, així que no passava
  // per aquí). Fora de línia sí que s'han de buidar.
  if (!estado.enLinea) {
    estado.npcs.clear();
    estado.suelo.clear();
  }
  m.abiertas = new Set();
  if (estado.render) estado.render.cache.delete(m.id);
  estado.render.componer(m);                 // compone y cachea: sin espera visible
  $('#mapa').textContent = `${m.nombre || '(sin nombre)'}  ·  mapa ${m.id}`;
  estado.render.nombreMapa = (m.nombre || '').trim();
  estado.render.moralMapa = m.moral | 0;
  $('#musica').textContent = m.musica || '—';
  if (estado.musica) estado.musica.poner(m.musica);
  finDeSalto();
  recuperarTeclado();
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

let razaAviso = 0;
let costeApariencia = '';
let vetoTile = null;
let casillaAnterior = null;
function razaBloqueada(x, y) {
  if (!estado.mapa || tipoEn(estado.mapa, x, y) !== 10) return false;
  // La casella type 10 es d'UNA raza. Data1 es aquesta raza:
  // 0 Mummins, 1 Lindors, 2 Mundols. El 0 no vol dir "lliure".
  return (datoEn(estado.mapa, x, y, 0) | 0) !== (estado.miClase | 0);
}
function avisarRaza() {
  const ahora = performance.now();
  if (ahora - razaAviso < 1200) return;
  razaAviso = ahora;
  if (estado.ui) estado.ui.chat('Tu raza no puede cruzar por aqui.', '#ff5555');
}
function tornarEnrere(prohibida) {
  const j = estado.jugador;
  if (prohibida) vetoTile = prohibida;
  if (casillaAnterior) fijarMiPos(casillaAnterior.x, casillaAnterior.y);
  else fijarMiPos(j.x, j.y);
  saltoHasta = performance.now() + 200;
}

function puertaTancada(x, y) {
  const m = estado.mapa;
  if (!m) return false;
  const t = tipoEn(m, x, y);
  if (t !== 5 && t !== 15) return false;
  return !(m.abiertas && m.abiertas.has(x + ',' + y));
}
function intentarMover(dir) {
  const j = estado.jugador;
  if (performance.now() < saltoHasta) return;
  if (j.moviendo) return;
  j.dir = dir;
  const corriendo = estaCorriendo();
  const d = { [DIR.ARRIBA]: [0, -1], [DIR.ABAJO]: [0, 1], [DIR.IZQ]: [-1, 0], [DIR.DER]: [1, 0] }[dir];
  const nx = j.x + d[0], ny = j.y + d[1];
  if (nx < 0 || ny < 0 || nx >= ANCHO || ny >= ALTO) return;
  if (esSolido(tipoEn(estado.mapa, nx, ny))) return;
  if (puertaTancada(nx, ny)) {
    mirar(dir);
    if (estado.enLinea) estado.red.mover(dir, corriendo);
    return;
  }
  if (vetoTile && vetoTile.x === nx && vetoTile.y === ny) { mirar(dir); return; }
  if (razaBloqueada(nx, ny)) {
    mirar(dir);
    vetoTile = { x: nx, y: ny };
    avisarRaza();
    return;
  }
  if (ocupada(nx, ny)) { mirar(dir); return; }
  casillaAnterior = { x: j.x, y: j.y };
  j.destino = { x: nx, y: ny, dx: d[0], dy: d[1] };
  j.moviendo = true;
  j.t0 = performance.now();
  j.ms = corriendo ? MS_CORRER : estado.msPorCasilla;
  if (estado.enLinea) estado.red.mover(dir, corriendo);
  dirEnviada = dir;
  if (tipoEn(estado.mapa, nx, ny) === 9) mostrarMarcoTienda();
  else cerrarTienda();
  if (tipoEn(estado.mapa, nx, ny) !== 13) cerrarApariencia();
}

const TABS_TIENDA = ['Armas', 'Escudos', 'Armaduras', 'Cascos', 'Magias', 'Otros Objetos/Ventas'];

function esMoneda(num) {
  if (!num) return false;
  const d = estado.ui && estado.ui.items.get(num);
  if (d && d.tipo === 12) return true;
  return /dorad|moneda|\boro\b|guita|\bgold\b|coin/.test(((d && d.nombre) || '').toLowerCase());
}
function esVenta(tr) {
  return tr.give > 0 && esMoneda(tr.get) && !esMoneda(tr.give);
}
function iconoItem(num) {
  const cv = document.createElement('canvas');
  cv.width = 32;
  cv.height = 32;
  cv.style.cssText = 'display:block;width:32px;height:32px;margin:3px auto;image-rendering:pixelated';
  const d = estado.ui && estado.ui.items.get(num);
  if (d && estado.ui.hojaItems && d.pic) {
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    estado.ui.dibujaIcono(ctx, d.pic, 0, 0);
  }
  return cv;
}
function asegurarTienda() {
  if (document.getElementById('tienda')) return;
  const st = document.createElement('style');
  st.textContent = '#tienda{display:none;position:absolute;left:292px;top:36px;width:620px;height:452px;z-index:40;color:#f3e6c4;padding:8px 10px;background:radial-gradient(circle at 20% 0%,#4a3018 0%,transparent 42%),repeating-linear-gradient(90deg,#2a1a10 0 2px,#3a2414 2px 7px);border:3px solid #e0b45a;box-shadow:inset 0 0 0 2px #6a4a18,0 10px 28px #000}#td-titulo{text-align:center;color:#f0d080;font:bold 18px Georgia,serif;margin-bottom:4px}#td-tabs{display:flex;gap:8px;justify-content:center;margin-bottom:6px;flex-wrap:wrap}#td-tabs button{background:transparent;border:0;color:#d8c49a;cursor:pointer;font:12px Verdana,sans-serif}#td-tabs button.sel{color:#7dff4a;text-decoration:underline}#td-cuerpo{display:flex;gap:8px;height:318px}#td-rejilla{width:360px;height:318px;overflow:auto;display:grid;grid-template-columns:repeat(8,42px);gap:2px;align-content:start;background:#1a100a;border:2px solid #e0b45a;padding:4px}#td-rejilla .celda{width:40px;height:40px;background:#0c0c0c center no-repeat;border:1px solid #c9a24a;position:relative;cursor:pointer}#td-rejilla .celda.sel{outline:2px solid #3ec6ff;outline-offset:-3px}#td-rejilla .v{position:absolute;right:1px;bottom:0;color:#ffe14a;font:bold 11px Verdana,sans-serif;text-shadow:0 0 2px #000}#td-ficha{flex:1;border:2px solid #e0b45a;background:#070707;padding:6px 8px;overflow:auto;font-size:12px;line-height:1.35}#td-ficha .cab{color:#e0b45a;font-weight:bold;margin-top:4px}#td-ficha .nom{color:#fff}#td-pie{display:flex;align-items:center;gap:10px;margin-top:6px}#td-pago{width:200px;font-size:12px}#td-pie button{background:transparent;border:0;color:#f0e6c8;cursor:pointer;font:13px Verdana,sans-serif}';
  document.head.appendChild(st);
  const box = document.createElement('div');
  box.id = 'tienda';
  box.innerHTML = '<div id="td-titulo">Bienvenido Viajero!</div><div id="td-tabs"></div>'
    + '<div id="td-cuerpo"><div id="td-rejilla"></div><div id="td-ficha"></div></div>'
    + '<div id="td-pie"><div id="td-pago"></div>'
    + '<button type="button" id="td-negociar">Negociar</button>'
    + '<button type="button" id="td-reparar">Reparar Items</button>'
    + '<button type="button" id="td-cerrar">Regresar</button></div>';
  (document.getElementById('juego') || document.body).appendChild(box);
}
function mostrarMarcoTienda() {
  asegurarTienda();
  const box = document.getElementById('tienda');
  box.style.display = 'block';
  if (!estado.tienda) {
    document.getElementById('td-ficha').innerHTML = 'Cargando el comercio...';
  }
}
function cerrarTienda() {
  estado.tienda = null;
  const el = document.getElementById('tienda');
  if (el) el.style.display = 'none';
}
function pintarTienda() {
  asegurarTienda();
  const td = estado.tienda;
  const box = document.getElementById('tienda');
  if (!td || !box) return;
  box.style.display = 'block';
  const neg = document.getElementById('td-negociar');
  if (neg && !neg.dataset.listo) {
    neg.dataset.listo = '1';
    neg.onclick = negociarTienda;
    document.getElementById('td-cerrar').onclick = cerrarTienda;
    document.getElementById('td-reparar').onclick = () => {
      if (estado.ui) estado.ui.chat('Esta tienda no repara objetos.', '#e0b070');
    };
  }
  const tabs = document.getElementById('td-tabs');
  tabs.innerHTML = TABS_TIENDA.map((n, i) =>
    '<button type="button" data-p="' + i + '" class="' + (i === td.pagina ? 'sel' : '') + '">' + n + '</button>').join('');
  tabs.querySelectorAll('button').forEach(b => {
    b.onclick = () => { td.pagina = +b.dataset.p; td.sel = null; pintarTienda(); };
  });
  const slots = td.paginas[td.pagina] || [];
  let last = 0;
  slots.forEach((s, i) => { if (s.get) last = i; });
  const n = Math.min(66, Math.max(48, last + 1));
  const rej = document.getElementById('td-rejilla');
  rej.innerHTML = slots.slice(0, n).map((s, i) => {
    if (!s.get) return '<div class="celda" data-i="' + i + '"></div>';
    const venta = esVenta(s);
    const num = venta ? s.give : s.get;
    return '<div class="celda' + (td.sel === i ? ' sel' : '') + '" data-i="' + i + '" data-num="' + num + '">'
      + (venta ? '<span class="v">V</span>' : '') + '</div>';
  }).join('');
  rej.querySelectorAll('.celda[data-num]').forEach(el => {
    const num = +el.dataset.num;
    if (num) el.insertBefore(iconoItem(num), el.firstChild);
  });
  rej.querySelectorAll('.celda').forEach(el => {
    el.onclick = () => { td.sel = +el.dataset.i; pintarTienda(); };
  });
  const tr = td.sel != null ? slots[td.sel] : null;
  const ficha = document.getElementById('td-ficha');
  const pago = document.getElementById('td-pago');
  if (!tr || !tr.get) { ficha.innerHTML = ''; pago.innerHTML = ''; return; }
  const venta = esVenta(tr);
  const num = venta ? tr.give : tr.get;
  const d = (estado.ui && estado.ui.items.get(num)) || { nombre: '#' + num, adds: [] };
  const a = d.adds || [];
  const cant = venta ? (tr.gval || 1) : (tr.getv || 1);
  ficha.innerHTML =
    '<div>Nombre: <span class="nom">' + (d.nombre || '') + '</span></div>' +
    '<div>Cantidad: ' + cant + '</div>' +
    '<div class="cab">Requerimientos</div>' +
    '<div>Fuerza: ' + (d.reqStr || 0) + '</div>' +
    '<div>Defensa: ' + (d.reqDef || 0) + '</div>' +
    '<div>Magia: ' + (d.reqMag || 0) + '</div>' +
    '<div class="cab">Añade</div>' +
    '<div>Fuerza: ' + (a[3] || 0) + '</div>' +
    '<div>Defensa: ' + (a[4] || 0) + '</div>' +
    '<div>Magia: ' + (a[5] || 0) + '</div>' +
    '<div>Intelig: ' + (a[6] || 0) + '</div>' +
    '<div>Hp: ' + (a[0] || 0) + '</div><div>Mp: ' + (a[1] || 0) + '</div><div>Sp: ' + (a[2] || 0) + '</div>' +
    '<div>Experiencia %: ' + (a[7] || 0) + '</div>' +
    '<div class="cab">Descripcion:</div><div>' + (d.desc || '') + '</div>';
  const paga = estado.ui.items.get(venta ? tr.get : tr.give);
  const cuanto = venta ? (tr.getv || 0) : (tr.gval || 0);
  pago.innerHTML = 'Negociar por: ' + ((paga && paga.nombre) || (cuanto ? 'Dorados' : 'Nada'))
    + '<br>Cantidad: ' + cuanto;
}
function cerrarApariencia() {
  const el = document.getElementById('apariencia');
  if (el) el.style.display = 'none';
}
function abrirApariencia() {
  if (!document.getElementById('apariencia')) {
    const st = document.createElement('style');
    st.textContent = '#apariencia{display:none;position:absolute;left:340px;top:150px;width:360px;z-index:50;background:#1a1008;border:3px solid #e0b45a;box-shadow:inset 0 0 0 2px #6a4a18,0 10px 28px #000;color:#f3e6c4;padding:16px 18px;text-align:center;font:15px Georgia,serif}#apariencia h3{margin:0 0 10px;color:#f0d080}#apariencia p{margin:0 0 14px;font:13px Verdana,sans-serif;line-height:1.4}#apariencia button{margin:0 8px;background:#d8d0c0;color:#401010;border:2px outset #f0e8d8;padding:5px 16px;cursor:pointer;font:13px Verdana,sans-serif}';
    document.head.appendChild(st);
    const box = document.createElement('div');
    box.id = 'apariencia';
    box.innerHTML = '<h3>Cambiar de apariencia</h3><p id="ap-txt"></p>'
      + '<button type="button" id="ap-si">Confirmar</button>'
      + '<button type="button" id="ap-no">Cancelar</button>';
    (document.getElementById('juego') || document.body).appendChild(box);
    document.getElementById('ap-si').onclick = () => {
      if (estado.red && estado.enLinea) estado.red.enviar('buysprite');
      cerrarApariencia();
    };
    document.getElementById('ap-no').onclick = cerrarApariencia;
  }
  document.getElementById('ap-txt').textContent =
    costeApariencia || '¿Confirmar el cambio de apariencia?';
  document.getElementById('apariencia').style.display = 'block';
}
function negociarTienda() {
  const td = estado.tienda;
  if (!td || td.sel == null || !estado.enLinea) return;
  const tr = td.paginas[td.pagina][td.sel];
  if (!tr || !tr.get) return;
  estado.red.enviar('TRADEREQUEST', td.pagina + 1, tr.slot);
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
  if (razaBloqueada(j.x, j.y)) {
    const mala = { x: j.x, y: j.y };
    tornarEnrere(mala);
    avisarRaza();
    return;
  }
  j.paso = (j.paso + 1) & 3;
  const t = tipoEn(m, j.x, j.y);
  if (t === 2) {                                   // warp
    // No saltar amb la casella del mapa local: no coincideix amb la del servidor
    // i el personatge queda mal colocat. El servidor envia la posicio real.
    estado.audio.efecto('warp.wav');
    j.moviendo = false;
    j.destino = null;
    pausaDeSalto();
    return;
  }
  const carteles = m.carteles.get(idx(j.x, j.y));
  const texto = carteles && carteles.find(s => s && s.trim());
  $('#cartel').textContent = texto ? texto.trim() : '';
}

const teclas = new Set();
let movilCorre = false;
let pendiente = null;   // ultima direccion pulsada, para toques muy breves
const DEF_TECLAS = {
  arriba: 'KeyW', abajo: 'KeyS', izq: 'KeyA', der: 'KeyD',
  correr: 'ShiftLeft', golpe: 'ControlLeft', recoger: 'Space',
  girar: 'End', chat: 'KeyT', refrescar: 'KeyR',
  vida: 'F6', mana: 'F7', energia: 'F8', lanzar: 'Insert',
};
const NOMBRE_ACCION = [
  ['arriba', 'Mover arriba'], ['abajo', 'Mover abajo'],
  ['izq', 'Mover izquierda'], ['der', 'Mover derecha'],
  ['correr', 'Correr (mantener)'], ['golpe', 'Golpe fisico'],
  ['recoger', 'Recoger'], ['girar', 'Girar sin moverse'],
  ['chat', 'Abrir chat'], ['refrescar', 'Refrescar'],
  ['vida', 'Pocion de vida'], ['mana', 'Pocion de mana'],
  ['energia', 'Pocion de energia'], ['lanzar', 'Lanzar magia elegida'],
];
let TECLAS_CFG = Object.assign({}, DEF_TECLAS);
try { Object.assign(TECLAS_CFG, JSON.parse(localStorage.getItem('dbo_teclas') || '{}')); } catch (e) {}
let esperandoTecla = null;
let movTeclas = {};
function guardarTeclas() { localStorage.setItem('dbo_teclas', JSON.stringify(TECLAS_CFG)); }
function codigoDe(accion) { return TECLAS_CFG[accion] || ''; }
function mismaTecla(cfg, code) {
  if (!cfg || !code) return false;
  if (cfg === code) return true;
  if ((cfg === 'ShiftLeft' || cfg === 'ShiftRight') && (code === 'ShiftLeft' || code === 'ShiftRight')) return true;
  if ((cfg === 'ControlLeft' || cfg === 'ControlRight') && (code === 'ControlLeft' || code === 'ControlRight')) return true;
  return false;
}
function esTecla(accion, code) { return mismaTecla(codigoDe(accion), code); }
function nombreTecla(code) {
  if (!code) return '—';
  const fijos = {
    ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control',
    Space: 'Espacio', Enter: 'Enter', Escape: 'Esc', End: 'Fin', Insert: 'Insert',
    ArrowUp: 'Flecha arriba', ArrowDown: 'Flecha abajo', ArrowLeft: 'Flecha izq.', ArrowRight: 'Flecha der.',
  };
  if (fijos[code]) return fijos[code];
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
function aplicarTeclas() {
  movTeclas = {
    ArrowUp: DIR.ARRIBA, ArrowDown: DIR.ABAJO, ArrowLeft: DIR.IZQ, ArrowRight: DIR.DER,
  };
  const dir = { arriba: DIR.ARRIBA, abajo: DIR.ABAJO, izq: DIR.IZQ, der: DIR.DER };
  for (const id of Object.keys(dir)) {
    const c = codigoDe(id);
    if (c) movTeclas[c] = dir[id];
  }
}
function estaCorriendo() {
  if (movilCorre) return true;
  for (const c of teclas) if (esTecla('correr', c)) return true;
  return false;
}
function teclasAbiertas() {
  const w = document.getElementById('teclas-win');
  return !!(w && w.classList.contains('visible'));
}
function pintarTeclas() {
  const lista = document.getElementById('teclas-lista');
  if (!lista) return;
  lista.innerHTML = NOMBRE_ACCION.map(([id, nom]) => {
    const espera = esperandoTecla === id;
    const txt = espera ? 'pulsa...' : nombreTecla(codigoDe(id));
    return '<div class="fila"><span>' + nom + '</span><button type="button" data-acc="' + id + '" class="' + (espera ? 'espera' : '') + '">' + txt + '</button></div>';
  }).join('');
}
function abrirTeclas() {
  esperandoTecla = null;
  pintarTeclas();
  const w = document.getElementById('teclas-win');
  if (w) w.classList.add('visible');
}
function cerrarTeclas() {
  esperandoTecla = null;
  const w = document.getElementById('teclas-win');
  if (w) w.classList.remove('visible');
}
aplicarTeclas();
const BINDS = JSON.parse(localStorage.getItem('dbo_binds') || '{}');
function guardarBinds() { localStorage.setItem('dbo_binds', JSON.stringify(BINDS)); }
function enJuego() {
  if (!estado.enLinea || !estado.mapa) return false;
  const menu = document.getElementById('menu');
  if (menu && menu.style.display !== 'none') return false;
  const tut = document.getElementById('tutorial');
  if (tut && tut.classList.contains('visible')) return false;
  if (teclasAbiertas()) return false;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
    if (a.id === 'entrada' && a.readOnly) return true;
    return false;
  }
  return true;
}

// El mapa es un canvas amb focus. En canviar de mapa es redimensiona i Chrome
// deixa anar el focus de la finestra: el teclat no torna fins que es clica
// fora del navegador i es torna a entrar. El canvas no s'ha d'enfocar mai.
function recuperarTeclado() {
  const cv = document.getElementById('pantalla');
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) {
    const xatejant = a.id === 'entrada' && !a.readOnly;
    if (!xatejant && (a === cv || a.tagName === 'SELECT' || a.tagName === 'BUTTON' || a.tagName === 'IFRAME')) {
      a.blur();
    }
  }
  if (!document.hasFocus()) window.focus();
}

let ultimoPedidoMapa = 0;
let errorPantalla = '';
function avisarMovil() {
  if (!document.body.classList.contains('movil')) return;
  document.body.classList.toggle('enlinia', !!estado.enLinea);
  const avis = document.getElementById('mv-avis');
  if (avis) {
    const t = errorPantalla || (estado.enLinea && !estado.mapa ? 'Carregant el mapa...' : '');
    avis.textContent = t;
    avis.classList.toggle('mostrar', !!t);
  }
  if (estado.enLinea && !estado.mapa && estado.red) {
    const ahora = performance.now();
    if (ahora - ultimoPedidoMapa > 1500) {
      ultimoPedidoMapa = ahora;
      try { estado.red.pedirMapa(false); } catch (e) {
        errorPantalla = e.message;
      }
    }
  }
}
function despertarCanvas() {
  if (document.body.classList.contains('movil')) aplicarZoomMovil();
}

function bucle(ahora) {
  avisarMovil();
  const j = estado.jugador;
  if (!estado.mapa) {
    requestAnimationFrame(bucle);
    return;
  }

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
    for (const [code, d] of Object.entries(movTeclas)) {
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
    if (esSolido(tipoEn(estado.mapa, x, y)) || puertaTancada(x, y)) return true;
    for (const n of estado.npcs.values()) if (n.x === x && n.y === y) return true;
    return false;
  });

  try {
    estado.render.dibujar(estado.mapa, actores, j.px, j.py,
                          { suelo: estado.suelo.values(), efectos: estado.efectos });
    errorPantalla = '';
  } catch (e) {
    errorPantalla = (e && e.message) || String(e);
    console.error(e);
  }

  // contador de fotogramas
  fps.n++;
  if (ahora - fps.t >= 500) {
    $('#fps').textContent = Math.round(fps.n * 1000 / (ahora - fps.t));
    fps.n = 0; fps.t = ahora;
  }
  $('#pos').textContent = `${j.x},${j.y}`;
  document.body.classList.toggle('jugando', enJuego());
  if (document.body.classList.contains('movil')) pintarHudMovil();
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
    filas.push(num ? (i + 1) + '. ' + estado.ui.nombreHechizo(num) : (i + 1) + '. <vacio>');
  }
  estado.ui.pintaLista($('#lista-magias'), filas, estado.hechizoElegido - 1);
}

function pintarOnline(nombres) {
  estado.ui.pintaLista($('#lista-online'), nombres, -1);
}

function lanzarMagia() {
  if (!estado.enLinea) return;
  // No se toca la posicion: si se cancela el paso a medias, el dibujo se queda
  // una o dos casillas por detras del servidor y hay que darle a Refrescar.
  if (estado.jugador.moviendo) {
    const ahora = performance.now();
    if (ahora - (lanzarMagia.aviso || 0) > 800) {
      lanzarMagia.aviso = ahora;
      estado.ui.chat('No puedes lanzar la magia al caminar!', '#e07a6a');
    }
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
function resolverMagia(token) {
  const q = String(token || '').trim().toLowerCase();
  if (!q || !estado.hechizos) return 0;
  if (/^\d+$/.test(q)) {
    const n = parseInt(q, 10);
    return (n >= 1 && n <= 20 && estado.hechizos[n - 1]) ? n : 0;
  }
  let parcial = 0;
  for (let i = 0; i < 20; i++) {
    const num = estado.hechizos[i] || 0;
    if (!num) continue;
    const nom = estado.ui.nombreHechizo(num).toLowerCase();
    if (nom === q) return i + 1;
    if (nom.includes(q)) parcial = parcial ? -1 : i + 1;
  }
  return parcial > 0 ? parcial : 0;
}
function asignarMagia(linea) {
  const m = String(linea || '').match(/^\.asignar\s+(\S+)\s+(.+)$/i);
  if (!m) return false;
  const tecla = m[1].toLowerCase();
  const slot = resolverMagia(m[2]);
  if (!slot) {
    estado.ui.chat('No tienes esa magia. Usa el numero de la lista o su nombre.', '#e07a6a');
    return true;
  }
  BINDS[tecla] = slot;
  guardarBinds();
  const nom = estado.ui.nombreHechizo(estado.hechizos[slot - 1]);
  estado.ui.chat('Tecla ' + tecla + ' lanza ' + slot + '. ' + nom, '#8cff7a');
  return true;
}
function mandarChat(t) {
  if (asignarMagia(t)) return;
  const red = estado.red;
  if (/^\.clan\b/i.test(t)) {
    const rest = t.replace(/^\.clan\s*/i, '').trim();
    const fundar = rest.match(/^(?:fundar|crear)\s+(\S+)/i);
    if (fundar) {
      red.enviar('makeguild', fundar[1]);
      estado.ui.chat('Fundando el clan ' + fundar[1] + '. Hacen falta nivel 20 y 3000 dorados.', '#e8c86a');
      return;
    }
    if (!rest) {
      const v = document.querySelector('#v-clanes');
      if (v) v.classList.add('visible');
      estado.ui.chat('Clan: nivel 20 y 3000 dorados. .clan fundar Nombre  ·  .c texto es el chat.', '#e8c86a');
    }
  }
  if (t[0] === '!') {                       // !nombre mensaje
    const hueco = t.indexOf(' ');
    if (hueco < 2) { estado.ui.chat('Usar: !Nombre del jugador mensaje', '#e07a6a'); return; }
    red.privado(t.slice(1, hueco), t.slice(hueco + 1));
    return;
  }
  if (t[0] === '%') { red.alClan(t.slice(1)); return; }
  if (t[0] === '/') { comando(t); return; }
  if (t[0] === "'") {
    const g = t.slice(1).trim();
    if (g) red.enviar('broadcastmsg', g);
    return;
  }
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
function pedirCantidad(texto, sugerido) {
  return new Promise((listo) => {
    const dlg = $('#dialogo'), campo = $('#dlg-cant');
    if (dlg.classList.contains('visible')) { listo(null); return; }
    $('#dlg-texto').textContent = texto;
    campo.value = sugerido ? String(sugerido) : '';
    dlg.classList.add('visible');
    campo.focus();
    if (sugerido) campo.select();
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

async function elegirCantidadMoneda(num, tiene, accion) {
  tiene = tiene || 0;
  if (!esMoneda(num) || tiene <= 1) return tiene > 0 ? tiene : 1;
  const nombre = (estado.ui.nombreDe(num) || 'OBJETOS').toUpperCase();
  const cofre = !!estado.bolsaEsCofre;
  const dest = cofre
    ? (accion === 'añadir' ? 'al cofre' : 'del cofre')
    : (accion === 'añadir' ? 'a la mochila' : 'de la mochila');
  const n = await pedirCantidad(
    `Selecciona la cantidad de ${nombre} que quieras ${accion} ${dest}`, tiene);
  if (n === null || isNaN(n)) return null;
  if (n <= 0) { estado.ui.chat('Cantidad no permitida!', '#e07a6a'); return null; }
  if (n > tiene) { estado.ui.chat('No tienes esa cantidad!', '#e07a6a'); return null; }
  return n;
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
  ws.onopen = () => {
    // La sonda no ha d'ocupar una plaça de jugador. El servidor, si ja té
    // el pedaç, veu aquest paquet i no gasta un slot.
    const sonda = new Uint8Array(6);
    sonda[0] = 112; sonda[1] = 105; sonda[2] = 110; sonda[3] = 103; sonda[4] = 0; sonda[5] = 237;
    try { ws.send(sonda); } catch (e) {}
    setTimeout(() => {
      clearTimeout(fallo);
      poner(ws.readyState === WebSocket.OPEN);
    }, 800);
  };
  ws.onerror = () => { clearTimeout(fallo); poner(false); };
  ws.onclose = () => { clearTimeout(fallo); poner(false); };
}

// Donde escucha wsbridge.py. Si lo arrancas con otro puerto (--escucha), este
// es el UNICO sitio del cliente que hay que cambiar.
// Se usa el host de la pagina, no 127.0.0.1: asi entrar desde otro equipo por
// la red o la VPN funciona sin tocar nada.
const PUERTO_PUENTE = 4002;

function urlPuente() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:${PUERTO_PUENTE}`;
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

  red.addEventListener('MAPKEY', (e) => {
    const m = estado.mapa;
    if (!m) return;
    const x = parseInt(e.detail[1], 10);
    const y = parseInt(e.detail[2], 10);
    if (!m.abiertas) m.abiertas = new Set();
    const k = x + ',' + y;
    if (parseInt(e.detail[3], 10)) m.abiertas.add(k);
    else m.abiertas.delete(k);
    if (estado.render) estado.render.cache.delete(m.id);
  });

  red.addEventListener('MAPDONE', () => { finDeSalto(); recuperarTeclado(); });

  red.addEventListener('MAPDATA', (e) => {
    const m = mapaDeCampos(e.detail);
    if (m) aplicarMapaRecibido(m);
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
    cerrarTienda();
    const destino = parseInt(e.detail[1], 10);
    const rev = parseInt(e.detail[2], 10) || 0;
    const tengo = estado.mapas.get(destino);
    const fresco = !!(tengo && tengo.delServidor && tengo.revision === rev);
    if (fresco) {
      red.pedirMapa(true);
      esperandoMapa = 0;
    } else {
      red.pedirMapa(false);
      esperandoMapa = destino;
    }
    red.enviar('spells');
    pausaDeSalto();
    anotarSalto('aviso CHECKFORMAP', { a: destino, estoyEn: estado.mapa ? estado.mapa.id : null });
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
    const acceso = parseInt(f[8], 10) || 0;
    const pk = parseInt(f[9], 10) || 0;
    const clan = (f[10] || '').trim();
    const clanRango = Math.max(0, Math.min(4, parseInt(f[11], 10) || 0));
    const RANGO = ['', 'Postulante', 'Miembro', 'Oficial', 'Lider'];

    if (indice === estado.miIndice) {
      estado.miClase = parseInt(f[12], 10) || 0;
      if (estado.clases.length) estado.ui.setRaza(estado.clases[estado.miClase] || '');
      const primeraVez = !estado.enLinea;
      estado.enLinea = true;
      if (primeraVez) {
        cerrarMenu();
        document.body.classList.add('enlinia');
        if (document.body.classList.contains('movil')) aplicarZoomMovil();
        else abrirTutorial();
      }
      const j = estado.jugador;
      j.sprite = sprite; j.nombre = nombre; j.acceso = acceso; j.pk = pk;
      j.clan = clan; j.clanRango = clan ? clanRango : 0;
      const nomClan = document.getElementById('cl-clan');
      const nomRango = document.getElementById('cl-rango');
      if (nomClan) nomClan.textContent = clan || '—';
      if (nomRango) nomRango.textContent = clan ? (clanRango + ' · ' + (RANGO[clanRango] || '')) : '0';

      // Solo se acepta la posicion del servidor al entrar, al cambiar de mapa
      // o si nos hemos desincronizado de verdad (mas de una casilla). Si no,
      // manda la prediccion local: reposicionar en cada paquete haria que el
      // personaje volviera atras constantemente.
      const cambioMapa = !estado.mapa || estado.mapa.id !== mapa;
      const lejos = Math.abs(j.x - x) > 1 || Math.abs(j.y - y) > 1;
      const ajustar = performance.now() < ajusteHasta;
      if (esperandoMapa === mapa) {
        mapaPendiente = { id: mapa, x, y, dir };
      } else if (cambioMapa) {
        entrarAMapa(mapa, x, y, 'PLAYERDATA (el servidor manda)');
        j.dir = dir;
        forzarPos = false;
        ajusteHasta = 0;
        finDeSalto();
      } else if (primeraVez || forzarPos || ajustar || (lejos && !j.moviendo)) {
        anotarSalto('PLAYERDATA recoloca', { a: mapa, en: `${x},${y}`, estabaEn: `${j.x},${j.y}` });
        fijarMiPos(x, y);
        j.dir = dir;
        forzarPos = false;
        ajusteHasta = 0;
        finDeSalto();
      }
      return;
    }
    // otro jugador
    let a = estado.otros.get(indice);
    if (!a) { a = new Actor(estado.hojaSprites, sprite, x, y); estado.otros.set(indice, a); }
    a.sprite = sprite; a.nombre = nombre; a.dir = dir; a.acceso = acceso; a.pk = pk;
    a.clan = clan; a.clanRango = clan ? clanRango : 0;
    a.colocar(x, y);
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
    for (const ranura of [...estado.npcs.keys()]) {
      if (ranura <= 15) estado.npcs.delete(ranura);
    }
    for (const ranura of [...nombresMascota.keys()]) {
      if (ranura <= 15) nombresMascota.delete(ranura);
    }
    const nRanuras = Math.max(15, Math.floor((f.length - 1) / 4));
    for (let ranura = 1; ranura <= nRanuras; ranura++) {
      const b = 1 + (ranura - 1) * 4;
      const num = parseInt(f[b], 10);
      if (!num) continue;
      const x = parseInt(f[b+1], 10), y = parseInt(f[b+2], 10), dir = parseInt(f[b+3], 10) || 0;
      const def = estado.npcDefs.get(num) || { nombre: '', sprite: 0, grande: false };
      const a = new Actor(estado.hojaSprites, def.sprite, x, y);
      a.dir = dir;
      a.nombre = def.nombre;
      a.apodo = nombresMascota.get(ranura) || '';
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
             parseInt(f[5], 10) === 2 ? 135 : 270);   // 2 = corriendo
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
             parseInt(f[5], 10) === 2 ? 147 : 233);
  });

  red.addEventListener('PLAYERDIR', (e) => {
    const a = estado.otros.get(parseInt(e.detail[1], 10));
    if (a) a.dir = parseInt(e.detail[2], 10) || 0;
  });

  // playerxy: recolocacion seca, sin interpolar (teletransportes)
  red.addEventListener('PLAYERXY', (e) => {
    const f = e.detail;
    const a = parseInt(f[1], 10);
    const b = parseInt(f[2], 10);
    const c = parseInt(f[3], 10);
    // Teleport propi: el servidor manda x,y. Si porta index i es el meu, tambe.
    if (f[3] === undefined || a === estado.miIndice) {
      const x = f[3] === undefined ? a : b;
      const y = f[3] === undefined ? b : c;
      const j = estado.jugador;
      const tx = j.destino ? j.destino.x : j.x;
      const ty = j.destino ? j.destino.y : j.y;
      const igual = tx === x && ty === y && j.x === x && j.y === y;
      if (!igual) {
        vetoTile = { x: tx, y: ty };
        fijarMiPos(x, y);
        saltoHasta = performance.now() + 200;
        return;
      }
      fijarMiPos(x, y);
      finDeSalto();
      return;
    }
    const otro = estado.otros.get(a);
    if (!otro) return;
    otro.colocar(b, c);
  });

  const nombresMascota = new Map();
  const ponerNombreMascota = (slot, nombre) => {
    nombre = (nombre || '').trim();
    if (!nombre) return;
    nombresMascota.set(slot, nombre);
    const a = estado.npcs.get(slot);
    if (a) a.apodo = nombre;
  };
  red.addEventListener('PETNAME', (e) => ponerNombreMascota(parseInt(e.detail[1], 10), e.detail[2]));
  red.addEventListener('SPAWNNPC', (e) => {
    const f = e.detail;
    const ranura = parseInt(f[1], 10);
    const num = parseInt(f[2], 10);
    const def = estado.npcDefs.get(num) || { nombre: '', sprite: 0, grande: false };
    const a = new Actor(estado.hojaSprites, def.sprite, parseInt(f[3], 10), parseInt(f[4], 10));
    a.dir = parseInt(f[5], 10) || 0;
    a.nombre = def.nombre;
    a.apodo = nombresMascota.get(ranura) || '';
    a.esNpc = true;
    a.grande = def.grande; a.hojaGrande = estado.hojaGrandes;
    estado.npcs.set(ranura, a);
    $('#npcs').textContent = estado.npcs.size;
  });

  // Si el hechizo mata al monstruo, NPCDEAD llega antes que el dibujo y el
  // monstruo ya no esta. Se guarda la ultima casilla para pintar el hechizo ahi,
  // nunca encima del jugador.
  const posNpc = new Map();
  const recordarNpc = (slot, a) => {
    if (a && Number.isFinite(a.x)) posNpc.set(slot, { x: a.x, y: a.y });
  };

  red.addEventListener('NPCDEAD', (e) => {
    const slot = parseInt(e.detail[1], 10);
    recordarNpc(slot, estado.npcs.get(slot));
    estado.npcs.delete(slot);
    nombresMascota.delete(slot);
    $('#npcs').textContent = estado.npcs.size;
  });

  red.addEventListener('ATTACK', (e) => {
    const i = parseInt(e.detail[1], 10);
    const a = i === estado.miIndice ? estado.jugador : estado.otros.get(i);
    if (a) a.atacar();
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
  red.addEventListener('DAMAGEDISPLAY', (e) => {
    const texto = (e.detail[2] || '').trim();
    if (!texto) return;
    const lado = parseInt(e.detail[1], 10) === 1 ? 1 : 0;
    estado.efectos.combate(texto, color(e.detail[3]), lado);
    const so = soDe(texto);
    if (so) estado.audio.efecto(so);
  });

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
    const f = e.detail;
    const idx = parseInt(f[1], 10);
    const idFlecha = parseInt(f[2], 10);
    // dir del paquet: 0 dalt, 1 baix, 2 esquerra, 3 dreta. La columna del sheet es el mateix.
    const dir = Math.max(0, Math.min(3, parseInt(f[3], 10) || 0));
    const col = [1, 0, 3, 2][dir];
    const def = estado.flechas.get(idFlecha) || { pic: 0, alcance: 6 };
    const quien = idx === estado.miIndice ? estado.jugador : estado.otros.get(idx);
    const x = quien ? quien.x : estado.jugador.x;
    const y = quien ? quien.y : estado.jugador.y;
    estado.efectos.flecha(def.pic, x, y, dir, def.alcance, (tx, ty) => {
      if (idx !== estado.miIndice) return;
      const sobre = [...estado.npcs.values()].some(n => n.x === tx && n.y === ty);
      estado.red.flechaCayo(sobre ? 1 : 0, idFlecha, tx, ty);
    }, col);
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
    const anim = parseInt(f[2], 10) || 0;
    const ms = parseInt(f[3], 10) || 100;
    const tipo = parseInt(f[6], 10) || 0;
    const id = parseInt(f[7], 10);
    const npc = estado.npcs.get(id);
    const jug = id === estado.miIndice ? estado.jugador : estado.otros.get(id);
    let x, y;
    if (tipo !== 0) {
      const mem = posNpc.get(id);
      if (npc) { x = npc.x; y = npc.y; }
      else if (mem) { x = mem.x; y = mem.y; }
      else return;
    } else if (jug) {
      x = jug.x; y = jug.y;
    } else if (npc) {
      x = npc.x; y = npc.y;
    } else {
      const mem = posNpc.get(id);
      if (!mem) return;
      x = mem.x; y = mem.y;
    }
    estado.efectos.magia(anim, x, y, ms);
  });

  estado.mochila = [];
  function huecoNegro(num) {
    if (!num) return false;
    const d = estado.ui && estado.ui.items.get(num);
    return !d || String(d.nombre || '').toUpperCase() === 'NO DISPONIBLE';
  }
  function marcarBolsa() {
    // La motxilla té 10-20 forats; la resta arriba com a "NO DISPONIBLE".
    // El cofre té 50 forats disponibles.
    const lista = estado.mochila || [];
    const cerrados = lista.filter(r => r && huecoNegro(r.num)).length;
    estado.bolsaEsCofre = (lista.length - cerrados) > 20;
  }
  function pintarMochila(abrir) {
    marcarBolsa();
    let box = document.getElementById('mochila');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mochila';
      box.style.cssText = 'position:absolute;left:220px;top:70px;z-index:11;background:#1b140e;border:2px solid #e0c27a;color:#f0e2c0;padding:8px;width:360px';
      document.getElementById('juego').appendChild(box);
    }
    const cells = (estado.mochila || []).map((r, i) => {
      if (!r || !r.num) return '<div data-i="' + i + '" style="width:32px;height:32px;background:#111;border:1px solid #333"></div>';
      if (huecoNegro(r.num)) return '<div style="width:32px;height:32px;background:#000;border:1px solid #222"></div>';
      const d = estado.ui.items.get(r.num);
      const pic = d ? d.pic : 0;
      const col = pic % 6, fila = (pic / 6) | 0;
      return '<div data-i="' + i + '" title="' + (d ? d.nombre : r.num) + '" style="width:32px;height:32px;border:1px solid #5a2a2a;background:#1b0b0d url(assets/items.webp) ' + (-col * 32) + 'px ' + (-fila * 32) + 'px;color:#ffd;font:9px Verdana;text-align:right">' + (r.cant > 1 ? r.cant : '') + '</div>';
    }).join('');
    const titulo = estado.bolsaEsCofre ? 'Cofre' : 'Mochila';
    const ayuda = estado.bolsaEsCofre
      ? "Clic a l'inventari per guardar al cofre. Clic aqui per treure."
      : "Clic a l'inventari per guardar. Clic aqui per treure.";
    box.innerHTML = '<b>' + titulo + '</b> <button id="mochila-x" type="button" style="float:right">Cerrar</button>'
      + '<div style="font-size:12px;color:#c8b48a;margin:4px 0 6px">' + ayuda + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;width:340px">' + cells + '</div>';
    if (abrir) box.dataset.abierta = '1';
    box.style.display = box.dataset.abierta === '1' ? 'block' : 'none';
    box.querySelector('#mochila-x').onclick = () => {
      box.style.display = 'none';
      box.dataset.abierta = '';
      estado.bolsaAbierta = false;
    };
    box.querySelectorAll('[data-i]').forEach(el => {
      el.onclick = async () => {
        const i = parseInt(el.dataset.i, 10);
        const r = estado.mochila[i];
        if (!r || !r.num || huecoNegro(r.num)) return;
        const cant = await elegirCantidadMoneda(r.num, r.cant || 1, 'sacar');
        if (cant === null) return;
        estado.red.enviar('bankwithdraw', i + 1, cant);
      };
    });
  }
  function leerBanco(campos, base) {
    const out = [];
    for (let i = 0; i < 50; i++) {
      const o = base + i * 3;
      out.push({
        num: parseInt(campos[o], 10) || 0,
        cant: parseInt(campos[o + 1], 10) || 0,
        dur: parseInt(campos[o + 2], 10) || 0,
      });
    }
    return out;
  }
  red.addEventListener('PLAYERBANK', (e) => {
    estado.mochila = leerBanco(e.detail, 1);
    pintarMochila(false);
  });
  red.addEventListener('OPENBANK', () => {
    estado.bolsaAbierta = true;
    pintarMochila(true);
  });
  red.addEventListener('PLAYERBANKUPDATE', (e) => {
    const f = e.detail;
    const slot = (parseInt(f[1], 10) || 1) - 1;
    if (!estado.mochila.length) estado.mochila = leerBanco([], 99);
    estado.mochila[slot] = {
      num: parseInt(f[2], 10) || 0,
      cant: parseInt(f[3], 10) || 0,
      dur: parseInt(f[4], 10) || 0,
    };
    pintarMochila(false);
  });
  red.addEventListener('BANKMSG', (e) => {
    const t = (e.detail[1] || '').trim();
    if (t && estado.ui) estado.ui.chat(t, '#e07a6a');
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
    block: 'miss.wav', shield: 'miss.wav',
    key: 'key.wav', warp: 'warp.wav', pain: 'pain.wav', thunder: 'thunder.wav',
  };
  const soDe = (texto) => {
    const s = (texto || '').toLowerCase();
    if (/critica|gran fuerza/.test(s)) return 'critical.wav';
    if (/bloque/.test(s)) return 'miss.wav';
    if (/fallado|no te hace|no hace da|no le hace/.test(s)) return 'miss.wav';
    return '';
  };
  const esCombate = (texto) => /golpeas|puntos de vida|puntos de experiencia|critica|gran fuerza|bloque|no te hace|no hace da|ha fallado|invulnerable|has matado|te quita|le sacas/.test((texto || '').toLowerCase());
  red.addEventListener('SOUND', (e) => {
    const n = (e.detail[1] || '').trim();
    if (!n) return;
    const f = SONIDOS[n] || (n.endsWith('.wav') ? n : n + '.wav');
    estado.audio.efecto(f);
  });
  red.addEventListener('LEVELUP', () => {
    estado.audio.efecto('level.wav');
    estado.efectos.combate('¡Nivel!', '#00ff00');
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
      reqMag: parseInt(f[10], 10) || 0,
      adds: [13,14,15,16,17,18,19,20].map(i => parseInt(f[i], 10) || 0),
      desc: (f[21] || '').trim(),
    });
  });
  red.addEventListener('TRADE', (e) => {
    const f = e.detail;
    const paginas = [];
    let k = 3;
    for (let p = 0; p < 6; p++) {
      const slots = [];
      for (let i = 0; i < 66; i++) {
        slots.push({
          slot: i + 1,
          give: parseInt(f[k], 10) || 0,
          gval: parseInt(f[k + 1], 10) || 0,
          get: parseInt(f[k + 2], 10) || 0,
          getv: parseInt(f[k + 3], 10) || 0,
        });
        k += 4;
      }
      paginas.push(slots);
    }
    estado.tienda = { shop: parseInt(f[1], 10) || 0, paginas, pagina: 0, sel: null };
    pintarTienda();
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

  // ITEMWORN porta l'id real de l'objecte. PLAYERWORNEQ porta el numero de
  // casella (1..24). Al canviar de mapa el segon arriba l'ultim: si es llegeix
  // com un id, la casella 1 (els dorados) es pinta al cap i una altra casella
  // es pinta com un arc que no tens. El dibuix el mana nomes ITEMWORN.
  const EQUIPA = new Set([1, 2, 3, 4, 14, 15, 16]);
  const idEquipable = (num) => {
    if (!num) return 0;
    const d = estado.ui.items.get(num);
    if (!d) return num;
    const nom = (d.nombre || '').toLowerCase();
    if (d.tipo === 11 || d.tipo === 12) return 0;
    if (/dorad|moneda|\boro\b|guita|\bgold\b|coin|currency|\bllave\b|\bkey\b/.test(nom)) return 0;
    if (d.tipo && !EQUIPA.has(d.tipo)) return 0;
    return num;
  };
  const pintarEquip = (quien, nums) => {
    const nets = nums.map(idEquipable);
    // El servidor, si general.alas_encima esta actiu, intercanvia armadura i
    // botes al paquet: el client de PC pinta el primer camp sota el segon.
    // Aqui les ranures son reals (0 armadura, 4 botes) i les botes es pinten
    // despres, o sigui per sobre de l'armadura.
    if (nets.length >= 5) {
      const tmp = nets[0]; nets[0] = nets[4]; nets[4] = tmp;
    }
    const pics = nets.map((num) => {
      const d = num && estado.ui.items.get(num);
      return d ? d.pic : 0;
    });
    if (!isNaN(quien)) {
      estado.equipoDe.set(quien, pics);
      const otro = estado.otros.get(quien);
      if (otro) { otro.hojaItems = estado.hojaItems; otro.puesto = pics; }
    }
    if (quien !== estado.miIndice) return;
    estado.ui.equipo = nets;
    estado.ui.repinta();
    estado.jugador.puesto = pics;
    estado.jugador.hojaItems = estado.hojaItems;
  };
  red.addEventListener('ITEMWORN', (e) => {
    const f = e.detail;
    pintarEquip(parseInt(f[1], 10), [2, 3, 4, 5, 6, 7, 8].map(i => parseInt(f[i], 10) || 0));
  });
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
  for (const p of ['GLOBALMSG', 'BROADCASTMSG', 'MAPMSG', 'ADMINMSG',
                   'ALERTMSG', 'PLAINMSG', 'SAYMSG', 'GUILDMSG', 'EMOTEMSG']) {
    red.addEventListener(p, (e) => estado.ui.chat(e.detail[1], color(e.detail[2])));
  }
  red.addEventListener('PLAYERMSG', (e) => {
    const t = e.detail[1] || '';
    if (/apariencia te costar/i.test(t)) costeApariencia = t;
    if (/raza no puede|no puedes? pasar|no es de tu (raza|clase)/i.test(t)) {
      const j = estado.jugador;
      const d = [[0, -1], [0, 1], [-1, 0], [1, 0]][j.dir] || [0, 0];
      const tx = j.destino ? j.destino.x : j.x + d[0];
      const ty = j.destino ? j.destino.y : j.y + d[1];
      tornarEnrere({ x: tx, y: ty });
    }
    if (esCombate(t)) {
      const s = t.toLowerCase();
      const lado = /no te hace|te quita|te ataca|bloqueas|te ha golpeado|te saca/.test(s) ? 1 : 0;
      estado.efectos.combate(t, color(e.detail[2]), lado);
      const so = soDe(t);
      if (so) estado.audio.efecto(so);
      return;
    }
    estado.ui.chat(t, color(e.detail[2]));
  });

  red.addEventListener('SPRITECHANGE', () => abrirApariencia());

  red.addEventListener('ONLINELIST', (e) => {
    pintarOnline(e.detail.slice(2).filter(s => s));
  });

  red.addEventListener('GLOBALMSG', (e) => { $('#cartel').textContent = e.detail[1] || ''; });

  red.conectar()
    .then(() => { estadoRed('Conectando con el servidor...'); red.login(cuenta, clave); })
    .catch(() => estadoRed('El server esta apagado, volve a intentarlo mas tarde', 'mal'));
}

function abrirF1() {
  let box = document.getElementById('f1');
  if (!box) {
    box = document.createElement('div');
    box.id = 'f1';
    box.style.cssText = 'position:absolute;left:230px;top:50px;z-index:13;width:460px;background:#ece9d8;color:#111;border:2px solid #808080;padding:8px;font:12px Tahoma,sans-serif';
    box.innerHTML = '<b>Panel de administracion</b> <button id="f1x" type="button" style="float:right">x</button>'
      + '<fieldset><legend>Comandos del jugador</legend>'
      + '<button type="button" data-c="/ban">Banear</button> '
      + '<button type="button" data-c="/warpmeto">Ir hacia el jugador</button> '
      + '<button type="button" data-c="/kick">Clikear</button> '
      + '<button type="button" data-c="/setaccess">Dar Acceso</button><br>'
      + 'Nivel de acceso: <input id="f1acc" size="4"> '
      + 'Nombre del jugador: <input id="f1name" size="14"></fieldset>'
      + '<fieldset><legend>comandos de sprite</legend>'
      + '<button type="button" data-c="/setsprite">Cambiar mi Sprite</button> '
      + '<button type="button" data-c="/setplayersprite">Cambiar el Sprite del Pj</button><br>'
      + 'Numero sprite: <input id="f1spr" size="6"></fieldset>'
      + '<fieldset><legend>Comandos de Trabajo</legend>'
      + '<button type="button" data-c="/mapeditor">Editor de mapas</button> '
      + '<button type="button" data-c="/editspell">Editor de magias</button> '
      + '<button type="button" data-c="/edititem">Editor de items</button> '
      + '<button type="button" data-c="/editshop">Editor de comercios</button> '
      + '<button type="button" data-c="/editnpc">Editor de NPCs</button> '
      + '<button type="button" data-c="/editarrow">Editar Flechas</button> '
      + '<button type="button" data-c="/editemoticon">Editar Emoticons</button></fieldset>'
      + '<fieldset><legend>Comando de los mapas</legend>'
      + '<button type="button" data-c="/loc">Localizacion</button> '
      + '<button type="button" data-c="/respawn">Refrescar el mapa</button> '
      + '<button type="button" data-c="/warpto">Moverse al mapa</button><br>'
      + 'Numero de mapa: <input id="f1map" size="6"></fieldset>'
      + '<button id="f1cerrar" type="button">Cerrar</button>';
    document.getElementById('juego').appendChild(box);
    box.addEventListener('click', (ev) => {
      if (ev.target.id === 'f1x' || ev.target.id === 'f1cerrar') { box.style.display = 'none'; return; }
      const c = ev.target.dataset.c;
      if (!c) return;
      const name = box.querySelector('#f1name').value.trim();
      const acc = box.querySelector('#f1acc').value.trim();
      const spr = box.querySelector('#f1spr').value.trim();
      const map = box.querySelector('#f1map').value.trim();
      let line = c;
      if (c === '/ban' || c === '/kick' || c === '/warpmeto') line = c + ' ' + name;
      if (c === '/setaccess') line = '/setaccess ' + name + ' ' + acc;
      if (c === '/setsprite') line = '/setsprite ' + spr;
      if (c === '/setplayersprite') line = '/setplayersprite ' + name + ' ' + spr;
      if (c === '/warpto') line = '/warpto ' + map;
      estado.red.enviar('saymsg', line.trim());
    });
  } else box.style.display = box.style.display === 'none' ? 'block' : 'none';
}

function abrirTutorial() {
  if (localStorage.getItem('dbo_tutorial_v2') === '1') return;
  const box = document.getElementById('tutorial');
  if (box) box.classList.add('visible');
}
function cerrarTutorial() {
  const box = document.getElementById('tutorial');
  const no = document.getElementById('tutorial-no');
  if (no && no.checked) localStorage.setItem('dbo_tutorial_v2', '1');
  else localStorage.removeItem('dbo_tutorial_v2');
  if (box) box.classList.remove('visible');
  const menu = document.getElementById('menu');
  if (menu) menu.style.display = 'none';
  const carga = document.getElementById('carga');
  if (carga) carga.style.display = 'none';
  despertarCanvas();
  ultimoPedidoMapa = 0;
  if (document.body.classList.contains('movil')) aplicarZoomMovil();
}

function atacar() {
  const j = estado.jugador;
  const ahora = performance.now();
  if (ahora < (j.proximoGolpe || 0)) return;
  j.proximoGolpe = ahora + 1000;
  estado.audio.efecto('sword.wav');
  if (estado.enLinea) estado.red.atacar();
}

function esMonedaOLlave(def) {
  if (!def) return false;
  const n = (def.nombre || '').toLowerCase();
  return /dorad|moneda|\boro\b|guita|\bgold\b|coin|currency|llave|llavero|\bkey\b|\bkeys\b/.test(n);
}

async function usarRanura(i) {
  if (!estado.enLinea) { estado.ui.chat('No estas conectado al servidor.', '#e07a6a'); return; }
  const r = estado.ui.inv[i];
  if (!r || !r.num) return;
  if (estado.bolsaAbierta) {
    const cant = await elegirCantidadMoneda(r.num, r.cant || 1, 'añadir');
    if (cant === null) return;
    estado.red.enviar('BANKDEPOSIT', i + 1, cant);
    return;
  }
  estado.ui.ultimaRanura.set(r.num, i);
  estado.red.enviar('USEITEM', i + 1);
}

async function iniciar() {
  const cv = $('#pantalla');
  const barra = $('#progreso');
  const recursos = await cargarTodo((hechas, total) => {
    barra.style.width = `${Math.round(100 * hechas / total)}%`;
  });

  estado.mapas = new Map();
  estado.audio = new Audio2('assets/sfx');
  estado.musica = new Musica('assets/music', 'assets');
  estado.render = new Render(cv, recursos.tiles);
  estado.render.hojaSprites = recursos.sprites;
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

  $('#carga').style.display = 'none';
  abrirMenu();
  $('#stats').textContent =
    `mapas del servidor · cargado en ${(recursos.ms / 1000).toFixed(2)} s`;

  function blocarSortida() {
    if (!estado.enLinea || document.fullscreenElement) {
      if (document.fullscreenElement && navigator.keyboard && navigator.keyboard.lock) {
        navigator.keyboard.lock(['KeyW', 'KeyR', 'KeyQ', 'KeyT', 'KeyN']).catch(() => {});
      }
      return;
    }
    const juego = document.getElementById('juego');
    if (!juego || !juego.requestFullscreen) return;
    juego.requestFullscreen().then(() => {
      if (navigator.keyboard && navigator.keyboard.lock) {
        return navigator.keyboard.lock(['KeyW', 'KeyR', 'KeyQ', 'KeyT', 'KeyN']);
      }
    }).catch(() => {});
  }

  addEventListener('keydown', (e) => {
    if (estado.enLinea && (e.ctrlKey || e.metaKey) && (e.code === 'KeyW' || e.code === 'KeyR' || e.code === 'KeyQ' || e.code === 'KeyT' || e.code === 'KeyN')) {
      e.preventDefault();
      e.stopPropagation();
      blocarSortida();
    }
    if (!enJuego()) return;
    if (e.code === 'F1') { e.preventDefault(); abrirF1(); return; }
    if (e.code in movTeclas) {
      teclas.add(e.code);
      pendiente = movTeclas[e.code];
      e.preventDefault();
      return;
    }
    if (esTecla('correr', e.code)) { teclas.add(e.code); e.preventDefault(); return; }
    if (esTecla('golpe', e.code)) { atacar(); e.preventDefault(); return; }
    if (esTecla('chat', e.code)) {
      e.preventDefault();
      const i = $('#entrada');
      i.readOnly = false;
      i.focus();
      return;
    }
    if (esTecla('refrescar', e.code)) { if (!e.repeat) refrescarPosicion(); e.preventDefault(); return; }
    if (esTecla('vida', e.code)) { usarPocion(5, 'vida'); e.preventDefault(); return; }
    if (esTecla('mana', e.code)) { usarPocion(6, 'mana'); e.preventDefault(); return; }
    if (esTecla('energia', e.code)) { usarPocion(7, 'SP'); e.preventDefault(); return; }
    if (esTecla('girar', e.code)) { girar(); e.preventDefault(); return; }
    if (esTecla('recoger', e.code)) { if (estado.enLinea) estado.red.recoger(); e.preventDefault(); return; }
    if (esTecla('lanzar', e.code)) { lanzarMagia(); e.preventDefault(); return; }
    const k = (e.code.startsWith('Key') && e.code.length === 4) ? e.code[3].toLowerCase()
      : (e.code.startsWith('Digit') ? e.code.slice(5) : '');
    if (k && BINDS[k]) {
      e.preventDefault();
      estado.hechizoElegido = BINDS[k];
      if (estado.jugador.moviendo) {
        lanzarMagia();
        return;
      }
      if (e.repeat) {
        estado.red.lanzar(BINDS[k]);
        return;
      }
      estado.red.lanzar(BINDS[k]);
      return;
    }
  });
  addEventListener('beforeunload', (e) => {
    if (!estado.enLinea || document.fullscreenElement) return;
    e.preventDefault();
    e.returnValue = '';
  });

  addEventListener('keyup', (e) => {
    teclas.delete(e.code);
    let sigue = false;
    for (const c of teclas) if (c in movTeclas) sigue = true;
    if (vetoTile && !sigue) vetoTile = null;
  });

  addEventListener('keydown', (e) => {
    if (!teclasAbiertas()) return;
    e.preventDefault();
    e.stopPropagation();
    if (!esperandoTecla) {
      if (e.code === 'Escape') cerrarTeclas();
      return;
    }
    if (e.code === 'Escape') { esperandoTecla = null; pintarTeclas(); return; }
    for (const id of Object.keys(TECLAS_CFG)) {
      if (id !== esperandoTecla && mismaTecla(TECLAS_CFG[id], e.code)) TECLAS_CFG[id] = '';
    }
    TECLAS_CFG[esperandoTecla] = e.code;
    esperandoTecla = null;
    guardarTeclas();
    aplicarTeclas();
    pintarTeclas();
  }, true);

  // Si la ventana pierde el foco con una tecla pulsada, el keyup nunca llega y
  // el personaje caminaria solo para siempre. Se sueltan todas.
  addEventListener('blur', () => { teclas.clear(); pendiente = null; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { teclas.clear(); pendiente = null; }
  });

  // Doble clic sobre el mapa: seleccionar blanco, igual que el original
  // ("haces 2 click sobre el blanco ya sea oponente o criatura").
  cv.addEventListener('mousedown', () => { if (document.activeElement === cv) cv.blur(); });
  const marcar = (ev) => {
    if (!estado.enLinea) return;
    const r = cv.getBoundingClientRect();
    const ancho = estado.render.vw || cv.width;
    const alto = estado.render.vh || cv.height;
    const escalaX = ancho / r.width, escalaY = alto / r.height;
    const { cx, cy } = estado.render.camara(estado.jugador.px, estado.jugador.py);
    const x = (((ev.clientX - r.left) * escalaX) / estado.render.escala + cx) / TS | 0;
    const y = (((ev.clientY - r.top) * escalaY) / estado.render.escala + cy) / TS | 0;
    estado.red.buscar(x, y);
  };
  cv.addEventListener('click', marcar);
  cv.addEventListener('dblclick', marcar);

  $('#irA').addEventListener('change', (e) => {
    const id = parseInt(e.target.value, 10);
    if (!estado.mapas.has(id)) return;
    // Estando conectado el salto lo tiene que hacer el SERVIDOR, o el juego
    // seguiria creyendote en el mapa anterior. Sin conexion es solo mirar.
    if (estado.enLinea) estado.red.enviar('WARPTO', id);
    else entrarAMapa(id, 15, 15);
  });

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
  const nombreClan = () => ((document.getElementById('cl-nombre') || {}).value || '').trim();
  const pideNombre = () => {
    const n = nombreClan();
    if (!n) estado.ui.chat('Escribe un nombre.', '#e07a6a');
    return n;
  };
  const botonClan = (id, fn) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', fn);
  };
  botonClan('cl-fundar', () => {
    const n = pideNombre();
    if (!n || !estado.enLinea) return;
    estado.red.enviar('makeguild', n);
    estado.ui.chat('Fundando el clan ' + n + '. Hacen falta nivel 20 y 3000 dorados.', '#e8c86a');
  });
  botonClan('cl-postulante', () => {
    const n = pideNombre();
    if (n && estado.enLinea) estado.red.enviar('guildtrainee', n);
  });
  botonClan('cl-miembro', () => {
    const n = pideNombre();
    if (n && estado.enLinea) estado.red.enviar('guildmember', n);
  });
  botonClan('cl-sacar', () => {
    const n = pideNombre();
    if (n && estado.enLinea) estado.red.enviar('guilddisown', n);
  });
  botonClan('cl-acceso', () => {
    const n = pideNombre();
    if (!n || !estado.enLinea) return;
    const acc = ((document.getElementById('cl-acceso') || {}).value || '').trim();
    estado.red.enviar('guildchangeaccess', n, acc || '0');
  });
  botonClan('cl-salir', () => { if (estado.enLinea) estado.red.enviar('guildleave'); });

  // flechas del inventario
  const desplazar = (d) => {
    const max = 24 - COLS_INV * FILAS_INV;
    estado.ui.desplazamiento = Math.max(0, Math.min(max, estado.ui.desplazamiento + d * COLS_INV));
    estado.ui.pintaInventario();
  };
  $('#btn-sube').addEventListener('click', () => desplazar(-1));
  $('#btn-baja').addEventListener('click', () => desplazar(1));
  $('#btn-lanzar').addEventListener('click', lanzarMagia);
  const btnTutorial = document.getElementById('tutorial-cerrar');
  if (btnTutorial) btnTutorial.addEventListener('click', cerrarTutorial);
  const btnTeclas = document.getElementById('teclas-cerrar');
  if (btnTeclas) btnTeclas.addEventListener('click', cerrarTeclas);
  const btnReset = document.getElementById('teclas-reset');
  if (btnReset) btnReset.addEventListener('click', () => {
    TECLAS_CFG = Object.assign({}, DEF_TECLAS);
    esperandoTecla = null;
    guardarTeclas();
    aplicarTeclas();
    pintarTeclas();
  });
  const listaTeclas = document.getElementById('teclas-lista');
  if (listaTeclas) listaTeclas.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-acc]');
    if (!b) return;
    esperandoTecla = b.dataset.acc;
    pintarTeclas();
  });

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
  $('#b-refrescar').addEventListener('click', () => refrescarPosicion());
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
    let box = document.getElementById('menu-cuenta');
    if (!box) {
      box = document.createElement('div');
      box.id = 'menu-cuenta';
      box.style.cssText = 'position:absolute;left:180px;top:40px;z-index:12;width:560px;height:520px;background:#1b140e;border:2px solid #e0c27a;color:#f0e2c0;padding:6px';
      box.innerHTML = '<b>Dream Blue Online</b> <button id="mc-x" type="button" style="float:right">Cerrar</button>'
        + '<iframe id="mc-frame" style="width:100%;height:480px;margin-top:6px;border:0;background:#17121a"></iframe>';
      document.getElementById('juego').appendChild(box);
      box.querySelector('#mc-x').onclick = () => { box.style.display = 'none'; };
    }
    box.style.display = 'block';
    const marco = box.querySelector('#mc-frame');
    marco.src = 'about:blank';
    fetch('/sesion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: estado.cuenta || '',
        password: estado.clave || '',
        char: (estado.jugador && estado.jugador.nombre) || '',
      }),
    }).then(r => r.json()).then(r => {
      if (!r.ok) {
        estado.ui.chat(r.msg || 'No he podido abrir la cuenta', '#e07a6a');
        return;
      }
      marco.src = '/panel';
    }).catch(() => estado.ui.chat('El ? solo entra solo en el puerto 8084.', '#e07a6a'));
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
    if (estado.bolsaAbierta) usarRanura(i);
  });
  // Un clic elige (borde rojo); DOBLE clic usa el objeto, que segun el tipo
  // lo equipa, lo consume o lo aprende. Igual que en el cliente.
  cvInv.addEventListener('dblclick', (ev) => {
    if (ev.button !== 0) return;
    if (estado.bolsaAbierta) return;
    const i = ranuraEn(ev);
    if (i === null) return;
    ocultarGlobo();
    estado.ui.seleccion = i;
    usarRanura(i);
  });
  cvInv.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const i = ranuraEn(ev);
    if (i === null) return;
    ocultarGlobo();
    estado.ui.seleccion = i;
    estado.ui.pintaInventario();
    arrojar();
  });
  $('#btn-usar').addEventListener('click', () => {
    if (estado.ui.seleccion !== null) usarRanura(estado.ui.seleccion);
  });
  $('#btn-tirar').addEventListener('click', arrojar);

  // El panell va Fuerza, Defensa, Inteligencia, Magia (data-stat 1..4).
  // El servidor espera 0 fuerza, 1 defensa, 2 magia, 3 inteligencia.
  const PUNT_AL_SERVIDOR = { '1': 0, '2': 1, '3': 3, '4': 2 };
  document.querySelectorAll('.subir').forEach(b => {
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!estado.enLinea || !estado.ui || estado.ui.stats.puntos <= 0) return;
      const idx = PUNT_AL_SERVIDOR[b.dataset.stat];
      if (idx === undefined) return;
      estado.red.enviar('usestatpoint', idx);
    });
  });

  // chat y comandos
  $('#entrada').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const t = ev.target.value.trim();
    ev.target.value = '';
    ev.target.readOnly = true;
    ev.target.blur();
    if (!t || !estado.enLinea) return;
    if (t.toLowerCase() === '.f1') { abrirF1(); return; }
    if (t.toLowerCase() === '.teclado' || t.toLowerCase() === '.teclas') { abrirTeclas(); return; }
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

  function abrirCrearCuenta() {
    let box = document.getElementById('crear-web');
    if (!box) {
      box = document.createElement('div');
      box.id = 'crear-web';
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:40;width:740px;height:560px;background:#1b140e;border:2px solid #e0c27a;color:#f0e2c0;padding:6px;box-shadow:0 8px 40px #000';
      box.innerHTML = '<b>Crear cuenta</b> <button id="crear-web-x" type="button" style="float:right">Cerrar</button>'
        + '<iframe id="crear-web-frame" style="width:100%;height:520px;margin-top:6px;border:0;background:#17121a"></iframe>';
      document.body.appendChild(box);
      box.querySelector('#crear-web-x').onclick = () => { box.style.display = 'none'; };
    }
    box.style.display = 'block';
    box.querySelector('#crear-web-frame').src = 'http://' + location.hostname + ':8080/crear';
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
  $('#z-nueva').addEventListener('click',   () => { estadoRed(''); abrirCrearCuenta(); });
  $('#z-borrar').addEventListener('click',  () => { estadoRed(''); pantallaMenu('borrarcta'); });
  $('#z-crearc').addEventListener('click',  () => abrirCrearCuenta());
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
    if (document.body.classList.contains('movil')) {
      $('#escala').style.transform = 'none';
      aplicarZoomMovil();
      return;
    }
    const k = Math.min(innerWidth / 950, innerHeight / ALTO_TOTAL, 1);
    $('#escala').style.transform = `scale(${k})`;
  };
  addEventListener('resize', ajustar);
  ajustar();
  montarMovil();

  // expuesto para inspeccionar desde la consola del navegador
  window.__dbo = { estado, DIAG };

  fps.t = performance.now();
  requestAnimationFrame(bucle);
}

let zoomMovil = 1;
try { zoomMovil = Math.min(2.6, Math.max(0.55, parseFloat(localStorage.getItem('dbo_zoom')) || 1)); } catch (e) {}

function aplicarZoomMovil() {
  if (!estado.render) return;
  // La mateixa vista que al PC (642x470). Al mobil nomes s'estira el llenç
  // amb CSS: canviar els pixels interns el deixava negre a l'iPhone.
  estado.render.vw = 642;
  estado.render.vh = 470;
  const c = document.getElementById('pantalla');
  const w = window.innerWidth, h = window.innerHeight;
  const s = Math.max(w / 642, h / 470) * zoomMovil;
  const cw = Math.round(642 * s), ch = Math.round(470 * s);
  c.style.position = 'fixed';
  c.style.width = cw + 'px';
  c.style.height = ch + 'px';
  c.style.left = Math.round((w - cw) / 2) + 'px';
  c.style.top = Math.round((h - ch) / 2) + 'px';
  c.style.transform = 'none';
}

function pintarHudMovil() {
  const ui = estado.ui;
  if (!ui) return;
  const v = ui.vitales, s = ui.stats;
  const posa = (barra, act, max) => {
    const el = document.getElementById(barra);
    if (!el) return;
    const m = Math.max(1, max || 1);
    el.style.width = Math.max(0, Math.min(100, 100 * (act || 0) / m)) + '%';
  };
  posa('mv-hp', v.hp, v.hpMax);
  posa('mv-mp', v.mp, v.mpMax);
  posa('mv-sp', v.sp, v.spMax);
  posa('mv-xp', s.exp, s.expSig);
  const nv = document.getElementById('mv-nv');
  const hp = document.getElementById('mv-hp-n');
  const mp = document.getElementById('mv-mp-n');
  const sp = document.getElementById('mv-sp-n');
  const st = document.getElementById('mv-st');
  if (nv) nv.textContent = 'Nv' + (s.nivel || 0);
  if (hp) hp.textContent = (v.hp || 0);
  if (mp) mp.textContent = (v.mp || 0);
  if (sp) sp.textContent = (v.sp || 0);
  if (st) st.textContent = 'F' + (s.str || 0) + ' D' + (s.def || 0) + ' I' + (s.speed || 0) + ' M' + (s.magi || 0);
  const log = document.getElementById('mv-log');
  const src = document.getElementById('chatlog');
  if (log && src) {
    const t = [...src.children].slice(-3).map(n => n.textContent).join('\n');
    if (log.textContent !== t) log.textContent = t;
  }
}

function montarMovil() {
  if (!document.body.classList.contains('movil')) return;
  const zoomA = (d) => {
    zoomMovil = Math.min(2.6, Math.max(0.55, Math.round((zoomMovil + d) * 100) / 100));
    localStorage.setItem('dbo_zoom', String(zoomMovil));
    aplicarZoomMovil();
  };
  document.getElementById('mv-mas').addEventListener('pointerup', (e) => { e.preventDefault(); zoomA(0.15); });
  document.getElementById('mv-menos').addEventListener('pointerup', (e) => { e.preventDefault(); zoomA(-0.15); });
  const foraDeFinestra = (el) => !el.closest(
    '#tutorial, #dialogo, #tienda, #teclas-win, #f1, #mv-menu, #mv-hoja, #mv-elegir, #mv-teclado, #mv-jugar, button, input, label, select, textarea'
  );
  const algunaOberta = () => {
    const oberta = (id, classe) => {
      const el = document.getElementById(id);
      return !!(el && el.classList.contains(classe));
    };
    const td = document.getElementById('tienda');
    const f1 = document.getElementById('f1');
    const kb = document.getElementById('mv-teclado');
    return oberta('tutorial', 'visible') || oberta('dialogo', 'visible') || oberta('teclas-win', 'visible')
      || oberta('mv-menu', 'on') || oberta('mv-hoja', 'on') || oberta('mv-elegir', 'on')
      || (td && td.style.display === 'block')
      || (f1 && f1.style.display !== 'none')
      || (kb && !kb.hidden);
  };
  let tancarClick = false;
  document.addEventListener('pointerdown', (e) => {
    if (!foraDeFinestra(e.target) || !algunaOberta()) return;
    tancarClick = true;
    e.preventDefault();
    e.stopPropagation();
    cerrarTutorial();
    cerrarTeclas();
    cerrarTienda();
    const dlg = document.getElementById('dialogo');
    if (dlg) dlg.classList.remove('visible');
    const f1 = document.getElementById('f1');
    if (f1) f1.style.display = 'none';
    document.getElementById('mv-menu').classList.remove('on');
    document.getElementById('mv-hoja').classList.remove('on');
    document.getElementById('mv-elegir').classList.remove('on');
    const kb = document.getElementById('mv-teclado');
    if (kb) kb.hidden = true;
  }, true);
  document.addEventListener('click', (e) => {
    if (!tancarClick) return;
    tancarClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  const base = document.getElementById('mv-base');
  const knob = document.getElementById('mv-knob');
  if (!base) return;
  const codigoDir = {
    [DIR.ARRIBA]: () => codigoDe('arriba') || 'KeyW',
    [DIR.ABAJO]: () => codigoDe('abajo') || 'KeyS',
    [DIR.IZQ]: () => codigoDe('izq') || 'KeyA',
    [DIR.DER]: () => codigoDe('der') || 'KeyD',
  };
  let stick = null;
  const soltarStick = () => {
    if (!stick) return;
    teclas.delete(stick.code);
    stick = null;
    knob.style.left = '40px';
    knob.style.top = '40px';
  };
  const dirDe = (dx, dy) => {
    if (Math.hypot(dx, dy) < 16) return null;
    const a = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
    const q = Math.round(a / (Math.PI / 2)) % 4;
    return [DIR.DER, DIR.ABAJO, DIR.IZQ, DIR.ARRIBA][q];
  };
  const moverStick = (e) => {
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const max = 40;
    const k = Math.min(max, dist) / dist;
    knob.style.left = (40 + dx * k) + 'px';
    knob.style.top = (40 + dy * k) + 'px';
    const dir = dirDe(dx, dy);
    const code = dir === null ? '' : codigoDir[dir]();
    if (stick && stick.code !== code) teclas.delete(stick.code);
    if (code) {
      teclas.add(code);
      pendiente = dir;
    }
    stick = { id: e.pointerId, code };
  };
  base.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#mv-correr')) return;
    e.preventDefault();
    base.setPointerCapture(e.pointerId);
    moverStick(e);
  });
  base.addEventListener('pointermove', (e) => {
    if (!stick || e.pointerId !== stick.id) return;
    e.preventDefault();
    moverStick(e);
  });
  base.addEventListener('pointerup', soltarStick);
  base.addEventListener('pointercancel', soltarStick);
  addEventListener('blur', soltarStick);

  const correr = document.getElementById('mv-correr');
  correr.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    movilCorre = !movilCorre;
    correr.classList.toggle('on', movilCorre);
    correr.textContent = movilCorre ? 'CORRER' : 'ANDAR';
  });

  const pulsar = (id, fn) => {
    const b = document.getElementById(id);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); });
    b.addEventListener('pointerup', (e) => { e.preventDefault(); fn(); });
  };
  pulsar('mv-atacar', () => { if (enJuego()) atacar(); });
  pulsar('mv-recoger', () => { if (estado.enLinea) estado.red.recoger(); });

  let huecos = [0, 0, 0];
  try { huecos = JSON.parse(localStorage.getItem('dbo_movil_magia') || '[0,0,0]'); } catch (e) {}
  if (!Array.isArray(huecos) || huecos.length !== 3) huecos = [0, 0, 0];
  const guardarHuecos = () => localStorage.setItem('dbo_movil_magia', JSON.stringify(huecos));
  const nomHueco = (slot) => {
    if (!slot || !estado.hechizos || !estado.ui) return '—';
    const num = estado.hechizos[slot - 1];
    if (!num) return '—';
    const n = estado.ui.nombreHechizo(num);
    return n.length > 9 ? n.slice(0, 8) + '…' : n;
  };
  const botonesH = [...document.querySelectorAll('#mv-magias button')];
  const pintarHuecos = () => botonesH.forEach((b, i) => { b.textContent = nomHueco(huecos[i]); });
  pintarHuecos();
  setInterval(pintarHuecos, 1000);

  const elegir = document.getElementById('mv-elegir');
  const listaMag = document.getElementById('mv-lista-magia');
  let asignando = -1;
  const cerrarElegir = () => { elegir.classList.remove('on'); asignando = -1; };
  document.getElementById('mv-elegir-x').addEventListener('click', cerrarElegir);
  const abrirElegir = (i) => {
    asignando = i;
    listaMag.innerHTML = '';
    let alguna = false;
    for (let s = 0; s < 20; s++) {
      const num = estado.hechizos && estado.hechizos[s];
      if (!num) continue;
      alguna = true;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = (s + 1) + '. ' + estado.ui.nombreHechizo(num);
      b.addEventListener('click', () => {
        huecos[i] = s + 1;
        guardarHuecos();
        pintarHuecos();
        cerrarElegir();
      });
      listaMag.appendChild(b);
    }
    if (!alguna) {
      const p = document.createElement('p');
      p.style.color = '#e07a6a';
      p.textContent = 'Todavia no tienes magias aprendidas.';
      listaMag.appendChild(p);
    }
    elegir.classList.add('on');
  };
  botonesH.forEach((b) => {
    let timer = 0;
    let largo = false;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      largo = false;
      timer = setTimeout(() => { largo = true; abrirElegir(+b.dataset.h); }, 450);
    });
    b.addEventListener('pointerup', (e) => {
      e.preventDefault();
      clearTimeout(timer);
      if (largo) return;
      const slot = huecos[+b.dataset.h];
      if (!slot) { abrirElegir(+b.dataset.h); return; }
      if (!enJuego()) return;
      estado.hechizoElegido = slot;
      lanzarMagia();
    });
    b.addEventListener('pointerleave', () => clearTimeout(timer));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  const menu = document.getElementById('mv-menu');
  const hoja = document.getElementById('mv-hoja');
  const cuerpo = document.getElementById('mv-hoja-cuerpo');
  const prestados = [];
  const devolver = () => {
    while (prestados.length) {
      const el = prestados.pop();
      el.style.transform = '';
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.maxHeight = '';
      el.style.overflow = '';
      const sitio = el._movil;
      if (sitio && sitio.padre) {
        if (sitio.next && sitio.next.parentNode === sitio.padre) sitio.padre.insertBefore(el, sitio.next);
        else sitio.padre.appendChild(el);
      }
      if (el.classList.contains('ventana')) el.classList.remove('visible');
      if (el.id === 'f1' || el.id === 'menu-cuenta') el.style.display = 'none';
    }
    cuerpo.innerHTML = '';
    hoja.style.paddingBottom = '';
  };
  const tomar = (el) => {
    if (!el) return;
    if (!el._movil) el._movil = { padre: el.parentNode, next: el.nextSibling };
    prestados.push(el);
    cuerpo.appendChild(el);
  };
  const cerrarHoja = () => { hoja.classList.remove('on'); devolver(); };
  document.getElementById('mv-hoja-x').addEventListener('click', cerrarHoja);
  const abrirPanel = (tit, fn) => {
    menu.classList.remove('on');
    devolver();
    fn();
    document.getElementById('mv-hoja-tit').textContent = tit;
    hoja.classList.add('on');
    const caja = document.getElementById('caja');
    if (caja && caja.parentNode === cuerpo) {
      const k = Math.min((innerWidth - 24) / 190, 2.3);
      caja.style.position = 'relative';
      caja.style.left = 'auto';
      caja.style.top = 'auto';
      caja.style.transform = 'scale(' + k + ')';
      caja.style.transformOrigin = 'top center';
      cuerpo.parentElement.style.paddingBottom = Math.round(183 * (k - 1) + 24) + 'px';
    }
  };
  const grupos = [
    ['Personatge', [
      ['Inventari', () => abrirPanel('Inventari', () => { estado.ui.mostrarPestana('inventario'); tomar(document.getElementById('caja')); })],
      ['Equip', () => abrirPanel('Equip', () => { estado.ui.mostrarPestana('equipo'); tomar(document.getElementById('caja')); })],
      ['Màgies', () => abrirPanel('Màgies', () => { estado.ui.mostrarPestana('magias'); tomar(document.getElementById('caja')); })],
      ['Vida', () => { menu.classList.remove('on'); usarPocion(5); }],
      ['Mana', () => { menu.classList.remove('on'); usarPocion(6); }],
      ['Energia', () => { menu.classList.remove('on'); usarPocion(7); }],
    ]],
    ['Mon', [
      ['Qui hi ha', () => abrirPanel('En linia', () => { estado.ui.mostrarPestana('online'); tomar(document.getElementById('caja')); })],
      ['Clans', () => abrirPanel('Clans', () => {
        const v = document.getElementById('v-clanes');
        v.classList.add('visible');
        v.style.position = 'relative'; v.style.left = 'auto'; v.style.top = 'auto'; v.style.width = '100%';
        tomar(v);
      })],
      ['Opcions', () => abrirPanel('Opcions', () => {
        const v = document.getElementById('v-opciones');
        v.classList.add('visible');
        v.style.position = 'relative'; v.style.left = 'auto'; v.style.top = 'auto'; v.style.width = '100%';
        tomar(v);
      })],
      ['Ajuda', () => abrirPanel('Ajuda', () => {
        document.getElementById('b-ayuda').click();
        const box = document.getElementById('menu-cuenta');
        if (!box) return;
        box.style.display = 'block';
        box.style.position = 'relative';
        box.style.left = 'auto';
        box.style.top = 'auto';
        box.style.width = '100%';
        box.style.height = '70vh';
        tomar(box);
      })],
      ['Refrescar', () => { menu.classList.remove('on'); refrescarPosicion(); }],
      ['Consola', () => abrirPanel('Consola', () => {
        abrirF1();
        const f = document.getElementById('f1');
        if (!f) return;
        f.style.display = 'block';
        f.style.position = 'relative'; f.style.left = 'auto'; f.style.top = 'auto'; f.style.width = '100%';
        tomar(f);
      })],
    ]],
  ];
  const lista = document.getElementById('mv-menu-lista');
  for (const [titol, entrades] of grupos) {
    const h = document.createElement('div');
    h.className = 'mv-grup';
    h.textContent = titol;
    lista.appendChild(h);
    for (const [nom, fn] of entrades) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = nom;
      b.addEventListener('click', fn);
      lista.appendChild(b);
    }
  }
  document.getElementById('mv-tornar').addEventListener('click', () => menu.classList.remove('on'));
  document.getElementById('mv-menu').querySelector('#mv-x').addEventListener('click', () => menu.classList.remove('on'));
  pulsar('mv-menu', () => { cerrarHoja(); menu.classList.add('on'); });

  const teclado = document.getElementById('mv-teclado');
  const msg = document.getElementById('mv-msg');
  const enviar = () => {
    const t = msg.value.trim();
    msg.value = '';
    msg.blur();
    teclado.hidden = true;
    if (t && estado.enLinea) mandarChat(t);
  };
  document.getElementById('mv-chat').addEventListener('pointerup', (e) => {
    e.preventDefault();
    teclado.hidden = false;
    msg.focus();
  });
  document.getElementById('mv-enviar').addEventListener('click', enviar);
  msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); enviar(); }
  });
}

iniciar().catch(e => {
  document.querySelector('#carga').innerHTML =
    `<p style="color:#f66">Error al iniciar: ${e.message}</p>`;
  console.error(e);
});
