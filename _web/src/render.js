// Renderizador. La idea clave para que no haya pantallas de carga:
// cada mapa se compone UNA vez en dos lienzos fuera de pantalla (lo que va
// debajo del jugador y lo que va encima) y se guardan en cache. Despues cada
// fotograma son dos recortes y los sprites: practicamente gratis.

import { ANCHO, ALTO, TS, STRIDE, idx } from './maps.js';

const CACHE_MAX = 12;           // mapas compuestos que se mantienen en memoria
const DEBAJO = [0, 1, 2, 3, 4]; // suelo, mascaras y sus animaciones
const ENCIMA = [5, 6, 7, 8];    // fringes: se dibujan por delante del jugador

export class Render {
  constructor(lienzo, hojas) {
    this.cv = lienzo;
    this.ctx = lienzo.getContext('2d', { alpha: false });
    this.hojas = hojas;              // tiles0..6
    this.cache = new Map();
    this.escala = 1;   // el aumento visual lo hace el CSS
    this.hojaItems = null;           // para los objetos tirados en el suelo
    this.noche = false;
    this.nombreMapa = '';            // el cliente lo escribe arriba del visor
    this.opciones = { nombreJugador: true, barraJugador: true,
                      nombreNpc: true, barraNpc: true };
    this.clima = 0;                  // 0 nada, 1 lluvia, 2 nieve, 3 tormenta
    this.gotas = [];
  }

  // Pixel art: jamas interpolar, o se ve borroso y pierde el caracter original.
  _sinSuavizado(ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
  }

  componer(m) {
    const enCache = this.cache.get(m.id);
    if (enCache) return enCache;

    const w = ANCHO * TS, h = ALTO * TS;
    const capa = (slots, fondo) => {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      this._sinSuavizado(g);
      if (fondo) { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); }
      for (let y = 0; y < ALTO; y++) {
        for (let x = 0; x < ANCHO; x++) {
          const i = idx(x, y);
          for (const s of slots) {
            const v = m.capas[i * 9 + s];
            if (v === 0) continue;
            const hoja = this.hojas[m.hojas[i * 9 + s]];
            if (!hoja) continue;
            const col = v % STRIDE, fila = (v / STRIDE) | 0;
            const sx = col * TS, sy = fila * TS;
            // Las columnas 7..13 no existen en la hoja: el motor original
            // tambien las salta.
            if (sx + TS > hoja.width || sy + TS > hoja.height) continue;
            g.drawImage(hoja, sx, sy, TS, TS, x * TS, y * TS, TS, TS);
          }
        }
      }
      return c;
    };

    const compuesto = { debajo: capa(DEBAJO, true), encima: capa(ENCIMA, false) };
    this.cache.set(m.id, compuesto);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    return compuesto;
  }

  // Devuelve la esquina superior izquierda de la camara, centrada en el jugador
  // y sin salirse del mapa (igual que el original).
  camara(px, py) {
    const vw = this.cv.width / this.escala, vh = this.cv.height / this.escala;
    const mw = ANCHO * TS, mh = ALTO * TS;
    let cx = px + TS / 2 - vw / 2, cy = py + TS / 2 - vh / 2;
    cx = mw <= vw ? (mw - vw) / 2 : Math.max(0, Math.min(cx, mw - vw));
    cy = mh <= vh ? (mh - vh) / 2 : Math.max(0, Math.min(cy, mh - vh));
    return { cx: Math.round(cx), cy: Math.round(cy) };
  }

  dibujar(m, actores, px, py, mundo) {
    const { ctx } = this;
    const comp = this.componer(m);
    const { cx, cy } = this.camara(px, py);
    const vw = this.cv.width / this.escala, vh = this.cv.height / this.escala;

    this._sinSuavizado(ctx);
    ctx.save();
    ctx.scale(this.escala, this.escala);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);

    ctx.drawImage(comp.debajo, cx, cy, vw, vh, 0, 0, vw, vh);

    // Los actores se ordenan por Y para que quien esta mas abajo tape a quien
    // esta mas arriba, como en el juego original.
    // Los objetos tirados van por debajo de todo el mundo: se pisan.
    if (mundo && mundo.suelo && this.hojaItems) this._suelo(ctx, mundo.suelo, cx, cy);

    for (const a of [...actores].sort((p, q) => p.y - q.y)) a.dibujar(ctx, cx, cy);

    if (mundo && mundo.efectos) mundo.efectos.dibujar(ctx, cx, cy);

    ctx.drawImage(comp.encima, cx, cy, vw, vh, 0, 0, vw, vh);

    // Nombres y barras de vida: por encima del fringe, como el original, para
    // que no los tape un arbol. El nombre estaba dentro de Actor.dibujar, o sea
    // por debajo, y en los mapas con arboles los jugadores salian anonimos.
    for (const a of actores) {
      if (a.esNpc ? this.opciones.nombreNpc : this.opciones.nombreJugador) {
        a.dibujarNombre(ctx, cx, cy);
      }
      if (a.hp === undefined) continue;
      if (a.esNpc ? this.opciones.barraNpc : this.opciones.barraJugador) this._vida(ctx, a, cx, cy);
    }

    this._ambiente(ctx, vw, vh);
    this._titulo(ctx, vw);
    ctx.restore();
    return { cx, cy };
  }

  // El nombre del mapa, centrado arriba del visor, como en el cliente.
  _titulo(ctx, vw) {
    if (!this.nombreMapa) return;
    ctx.font = 'bold 13px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.fillText(this.nombreMapa, vw / 2 + 1, 19);
    ctx.fillStyle = '#f0e8c8';
    ctx.fillText(this.nombreMapa, vw / 2, 18);
    ctx.textAlign = 'left';
  }

  _suelo(ctx, suelo, cx, cy) {
    for (const it of suelo) {
      const col = it.pic % 6, fila = (it.pic / 6) | 0;
      if ((fila + 1) * TS > this.hojaItems.height) continue;
      ctx.drawImage(this.hojaItems, col * TS, fila * TS, TS, TS,
                    Math.round(it.x * TS - cx), Math.round(it.y * TS - cy), TS, TS);
    }
  }

  // La barra va pegada a los PIES. Ojo: aunque una criatura grande mida 64 px,
  // sus pies siguen estando en su casilla, asi que la barra NO baja mas.
  _vida(ctx, a, cx, cy) {
    if (!a.hpMax) return;
    const w = TS - 4;
    const x = Math.round(a.px - cx) + 2, y = Math.round(a.py - cy) + TS + 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - 1, y - 1, w + 2, 5);
    ctx.fillStyle = '#3a0c0c';
    ctx.fillRect(x, y, w, 3);
    ctx.fillStyle = '#48d048';
    ctx.fillRect(x, y, Math.max(1, Math.round(w * a.hp / a.hpMax)), 3);
  }

  // Noche y clima. El original oscurece la pantalla entera y pinta gotas o
  // copos por encima; aqui se hace igual, en el mismo lienzo.
  _ambiente(ctx, vw, vh) {
    if (this.noche) {
      ctx.fillStyle = 'rgba(10, 16, 48, 0.42)';
      ctx.fillRect(0, 0, vw, vh);
    }
    if (!this.clima) { this.gotas.length = 0; return; }
    const nieve = this.clima === 2;
    if (this.gotas.length === 0) {
      for (let i = 0; i < (nieve ? 90 : 160); i++) {
        this.gotas.push({ x: Math.random() * vw, y: Math.random() * vh,
                          v: nieve ? 0.6 + Math.random() : 4 + Math.random() * 3 });
      }
    }
    ctx.strokeStyle = 'rgba(190, 210, 255, 0.55)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    for (const g of this.gotas) {
      g.y += g.v;
      if (nieve) g.x += Math.sin(g.y / 18) * 0.5;
      if (g.y > vh) { g.y = -4; g.x = Math.random() * vw; }
      if (nieve) ctx.fillRect(g.x, g.y, 2, 2);
      else { ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(g.x - 1, g.y + 6); ctx.stroke(); }
    }
    if (this.clima === 3 && Math.random() < 0.006) {   // relampago
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillRect(0, 0, vw, vh);
    }
  }
}
