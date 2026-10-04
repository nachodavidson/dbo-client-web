// Lector del paquete maps.bin: los 210 mapas del juego en un solo archivo.
// Se descomprime y se parsea una vez al arrancar; a partir de ahi cambiar de
// mapa es cambiar un indice, sin cargar nada.

export const ANCHO = 31, ALTO = 31, TS = 32;

// El indice de tile usa paso 14 aunque las hojas tienen 7 columnas reales.
// No es un error: es como lo hace el motor original, que numera las casillas de
// 16 en 16 px aunque luego dibuje de 32.
//
// OJO SI VIENES DE OTRO CLIENTE: este numero es el ANCHO DE LA HOJA DE TILES
// DIVIDIDO ENTRE 16. Las hojas de aqui miden 224 px -> 14. Las del cliente de
// Dreaminze miden 256 -> habria que poner 16. Con el valor equivocado los mapas
// se dibujan con las casillas corridas y el mundo sale hecho un rompecabezas.
export const STRIDE = 14;

export const TIPO = {
  NADA: 0, BLOQUEADO: 1, WARP: 2, SUELO: 4,
};

// Nomes el tipus 1 es paret. El 4 es "els NPC no s'hi posen" pero el jugador si
// hi camina: si no, no s'arriba al warp que hi ha just al darrere.
export const esSolido = (t) => t === 1;

export async function cargarMapas(url) {
  const resp = await fetch(url);
  const comprimido = await resp.arrayBuffer();
  const flujo = new Blob([comprimido]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(flujo).arrayBuffer();
  return parsear(buf);
}

function parsear(buf) {
  const d = new DataView(buf), b = new Uint8Array(buf);
  const txt = new TextDecoder('latin1');
  if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'DBOM') throw new Error('maps.bin invalido');
  const n = d.getUint16(5, true);
  let o = 7;
  const mapas = new Map();

  for (let k = 0; k < n; k++) {
    const id = d.getUint16(o, true); o += 2;
    const ln = b[o++]; const nombre = txt.decode(b.subarray(o, o + ln)); o += ln;
    const lm = b[o++]; const musica = txt.decode(b.subarray(o, o + lm)); o += lm;
    const indoors = b[o++], moral = b[o++];
    const npcs = [];
    for (let i = 0; i < 15; i++) { npcs.push(d.getUint16(o, true)); o += 2; }

    // Las casillas se guardan como vistas tipadas sobre el mismo buffer:
    // cero copias, cero basura para el recolector.
    const total = ANCHO * ALTO;
    const capas = new Uint16Array(total * 9);
    const hojas = new Uint8Array(total * 9);
    const tipos = new Uint8Array(total);
    const datos = new Uint16Array(total * 3);
    for (let i = 0; i < total; i++) {
      for (let s = 0; s < 9; s++) { capas[i * 9 + s] = d.getUint16(o, true); o += 2; }
      for (let s = 0; s < 9; s++) hojas[i * 9 + s] = b[o + s];
      o += 9;
      tipos[i] = b[o++];
      for (let s = 0; s < 3; s++) { datos[i * 3 + s] = d.getUint16(o, true); o += 2; }
    }

    const nc = d.getUint16(o, true); o += 2;
    const carteles = new Map();
    for (let i = 0; i < nc; i++) {
      const casilla = d.getUint16(o, true), ranura = b[o + 2], L = d.getUint16(o + 3, true);
      o += 5;
      const texto = txt.decode(b.subarray(o, o + L)); o += L;
      if (!carteles.has(casilla)) carteles.set(casilla, []);
      carteles.get(casilla)[ranura] = texto;
    }

    mapas.set(id, { id, nombre, musica, indoors, moral, npcs, capas, hojas, tipos, datos, carteles });
  }
  return mapas;
}

export const idx = (x, y) => y * ANCHO + x;
export const tipoEn = (m, x, y) =>
  (x < 0 || y < 0 || x >= ANCHO || y >= ALTO) ? TIPO.BLOQUEADO : m.tipos[idx(x, y)];
export const datoEn = (m, x, y, i) => m.datos[idx(x, y) * 3 + i];

// MAPDATA del servidor: el mateix que pinta el client de PC. 31x31 caselles,
// 26 camps cadascuna (9 capes, tipus, 3 dades, 3 textos, llum, 9 fulls).
const CAMPOS_TILE = 26;
export function mapaDeCampos(f) {
  const total = ANCHO * ALTO;
  if (!f || f.length < 14 + total * CAMPOS_TILE) return null;
  const id = parseInt(f[1], 10) || 0;
  if (!id) return null;
  const capas = new Uint16Array(total * 9);
  const hojas = new Uint8Array(total * 9);
  const tipos = new Uint8Array(total);
  const datos = new Uint16Array(total * 3);
  const carteles = new Map();
  let p = 14;
  const u16 = (v) => {
    v = parseInt(v, 10) || 0;
    return v > 0 && v <= 65535 ? v : 0;
  };
  for (let i = 0; i < total; i++) {
    for (let s = 0; s < 9; s++) capas[i * 9 + s] = u16(f[p++]);
    tipos[i] = parseInt(f[p++], 10) || 0;
    for (let s = 0; s < 3; s++) datos[i * 3 + s] = u16(f[p++]);
    for (let s = 0; s < 3; s++) {
      const txt = f[p++] || '';
      if (txt.trim()) {
        if (!carteles.has(i)) carteles.set(i, []);
        carteles.get(i)[s] = txt;
      }
    }
    p++;
    for (let s = 0; s < 9; s++) hojas[i * 9 + s] = parseInt(f[p++], 10) || 0;
  }
  const npcs = [];
  for (let i = 0; i < 15; i++) npcs.push(parseInt(f[p++], 10) || 0);
  return {
    id, nombre: (f[2] || '').trim(), musica: (f[9] || '').trim(),
    indoors: parseInt(f[13], 10) || 0, moral: parseInt(f[4], 10) || 0,
    revision: parseInt(f[3], 10) || 0,
    npcs, capas, hojas, tipos, datos, carteles, delServidor: true,
  };
}
