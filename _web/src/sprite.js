// Dibujo y animacion de personajes.
//
// Layout de sprites.webp: cada personaje ocupa UNA fila de 32 px con 12 frames,
// que son 4 direcciones x 3. Y el TERCERO de cada trio es el ATAQUE, no un paso
// de caminata (se ve el destello del arma). Meterlo en el ciclo de andar hacia
// que el personaje pareciera atacar al caminar.
//
//   direccion:   arriba  abajo  izquierda  derecha
//   frames:      0 1 2   3 4 5    6 7 8      9 10 11
//                    ^ataque  ^ataque  ^ataque   ^ataque
//
// Hay 266 personajes en la hoja.

import { TS } from './maps.js';

export const DIR = { ARRIBA: 0, ABAJO: 1, IZQ: 2, DER: 3 };
// Dentro de cada trio de una direccion:
//   +0 = REPOSO
//   +1 = el paso
//   +2 = el golpe
// MEDIDO, no deducido: se captura la ventana del cliente Windows mientras
// dibuja a nuestro propio personaje y se busca que combinacion reproduce esos
// pixeles (_servicios/deduce_capas.py). Con reposo en +0 y los objetos en el
// MISMO fotograma que el cuerpo la composicion sale identica: 0 de 552 pixeles
// distintos. Con lo que habia antes (reposo en +1 y los objetos con el trio
// invertido) fallaba el 29%: de ahi que el gorro pareciera mas alto y las alas
// taparan al personaje de frente, que era otra pose del ala.
const ATAQUE = 2;
const MS_ATAQUE = 200;
// Reposo medido contra el cliente Windows: [arriba 1, abajo 0, izquierda 1, derecha 0].
const REPOSO_POR_DIR = [1, 0, 1, 0];

// Colores sacados del propio binario del cliente (modulo base 0x401000 del
// volcado de memoria), no a ojo:
//   - el cliente dibuja los textos con SetTextColor/TextOut de GDI, que estan
//     en su tabla de importaciones
//   - el magenta puro 0xFF00FF aparece 9 veces en sus datos: es un color suyo,
//     y coincide con lo que se ve sobre los jugadores en las capturas
//   - hay una rutina que elige entre VERDE (0x00FF00) y ROJO (0x0000FF) segun
//     una condicion: es el par clasico "amistoso / agresivo" de este motor
// Ojo: VB guarda el color como &H00BBGGRR, asi que 0x0000FF es ROJO.
// El color del nombre de un jugador depende de su NIVEL DE ACCESO (campo 8 de
// PLAYERDATA). Los rangos son los que lista el propio cliente:
//   0 Anyone · 1 Moniters · 2 Mappers · 3 Developers · 4 Admins
// El 4 es magenta: comprobado en las capturas del juego (los dos personajes
// que salen son administradores) y el magenta existe en los datos del binario.
// Los otros cuatro salen de la paleta QBColor que el cliente lleva dentro.
export const COLOR_ACCESO = [
  '#ffffff',  // 0  jugador normal
  '#00ffff',  // 1  moderador
  '#00ff00',  // 2  mapeador
  '#ffff00',  // 3  desarrollador
  '#ff00ff',  // 4  administrador   <- este es el confirmado
];
export const COLOR_NPC = '#ffffff';

// Orden de ranuras: Armadura, Arma, Casco, Escudo, Botas, Amuleto, Hada.
//
// Solo se pintan las tres que se ven en las capturas del juego (armadura/alas,
// escudo y arma). Poniendo tambien el casco o las botas el icono tapa medio
// cuerpo y no se parece en nada al cliente, asi que hasta confirmar que esas
// ranuras se dibujan, se dejan fuera.
// Lo que se le ve puesto al personaje es el dibujo de `Data2` del objeto, no su
// icono: son dos casillas distintas de la misma hoja. Comprobado con las "alas
// negras", cuyo icono (pic 176) es negro y cuyo Data2 (pic 1) son las alas
// blancas que salen en el video del juego.
// Orden en que se viste al personaje. TODO va por ENCIMA del cuerpo, incluida
// la armadura: el propio dibujo de cada objeto ya deja transparente la parte
// por donde tiene que verse el muneco (las alas, por ejemplo, solo pintan los
// bordes cuando miras de frente).
// Antes la armadura iba debajo salvo mirando hacia arriba, y el cuerpo la
// tapaba entera: en el cliente Windows se ve el peto verde de frente y de lado,
// y en la web solo aparecia de espaldas. Comprobado componiendo las hojas a
// mano: con las alas los dos ordenes dan la misma imagen, asi que la excepcion
// no aportaba nada y escondia el resto de armaduras.
const ORDEN_EQUIPO = [0, 4, 2, 5, 6, 3, 1];  // armadura, botas, casco, amuleto, hada, escudo, arma
// De espaldas, lo que se lleva en las MANOS pasa por DETRAS del cuerpo: el
// personaje nos da la espalda, asi que el arma y el escudo quedan al otro lado.
// Medido contra el cliente Windows (escudo pic 20, sprite 9, mirando arriba):
// con el escudo al frente fallan 122 de 475 pixeles -- se ve una plancha azul
// enorme tapando medio cuerpo, que es el DORSO del escudo (columnas 0-2 de su
// fila); poniendolo detras salen 0 de 475. El arma ya iba detras por lo mismo:
// el mastil del baston lo tapan las alas.
const ORDEN_DE_ESPALDAS = [1, 3, 0, 4, 2, 5, 6];
// ...y ademas esas dos ranuras se pintan ANTES que el cuerpo, no solo antes que
// el resto del equipo: es el patron clasico de este motor (si miras al norte,
// arma y escudo van al otro lado del muneco).
const DETRAS_DE_ESPALDAS = [1, 3];

export class Actor {
  constructor(hoja, sprite, x, y) {
    this.hoja = hoja;
    this.sprite = sprite;
    this.x = x; this.y = y;              // casilla
    this.px = x * TS; this.py = y * TS;  // pixeles (interpolados)
    this.dir = DIR.ABAJO;
    this.paso = 0;
    this.nombre = '';
    this.moviendo = false;
    this.cola = [];
    this.atkT0 = 0;
    this.proximoGolpe = 0;
    this.hojaGrande = null;              // BIGSPRITES, para los NPCs grandes
    this.grande = false;
    // Lo que lleva puesto, para pintarlo sobre el personaje: iconos de 32 px
    // de la hoja de objetos, en el orden de ranuras del servidor.
    this.hojaItems = null;
    this.puesto = null;                  // array de `pic` (0 = ranura vacia)
  }

  atacar() {
    const ahora = performance.now();
    // El gest dura 200 ms, pero no se puede repetir hasta que pasa el golpe
    // (1 s). Si no, mantener la tecla de una magia lo dispara a toda velocidad.
    if (this.atkT0 && ahora - this.atkT0 < 1000) return;
    this.atkT0 = ahora;
  }

  frame() {
    const base = this.dir * 3;
    if (this.atkT0) {
      const t = performance.now() - this.atkT0;
      if (t < MS_ATAQUE) {
        // El cop es el fotograma +2 de la fila d'aquesta raça, quiet al lloc.
        // 100 ms el gest, 100 ms el repos. No es desplaça ni un píxel.
        if (t < 100) return base + ATAQUE;
        return base + (REPOSO_POR_DIR[this.dir] ?? 0);
      }
    }
    const reposo = REPOSO_POR_DIR[this.dir] || 0;
    if (!this.moviendo) return base + reposo;
    return base + (this.paso & 1 ? 1 - reposo : reposo);
  }

  // Los demás no se teletransportan a cada paquete: se encola el paso y se
  // recorre a velocidad constante. Si el siguiente aviso llega a medias, antes
  // se reiniciaba el tramo y el personaje iba a trompicones.
  moverA(x, y, dir, ms = 200) {
    if (!this.cola) this.cola = [];
    const ultimo = this.cola.length ? this.cola[this.cola.length - 1] : null;
    const ax = ultimo ? ultimo.x : this.x;
    const ay = ultimo ? ultimo.y : this.y;
    if (ax === x && ay === y) {
      if (dir !== undefined && dir !== null && !this.moviendo && !this.cola.length) this.dir = dir;
      return;
    }
    const lejos = Math.abs(x - ax) + Math.abs(y - ay) > 2;
    if (lejos) {
      this.colocar(x, y);
      if (dir !== undefined && dir !== null) this.dir = dir;
      return;
    }
    this.cola.push({ x, y, dir, ms });
    if (!this.moviendo) this._siguiente(performance.now());
  }

  colocar(x, y) {
    this.cola = [];
    this.x = x; this.y = y;
    this.px = x * TS; this.py = y * TS;
    this.moviendo = false;
    this.hasta = null;
    this.desde = null;
  }

  _siguiente(ahora) {
    const paso = this.cola.shift();
    if (!paso) { this.moviendo = false; this.hasta = null; return; }
    if (paso.dir !== undefined && paso.dir !== null) this.dir = paso.dir;
    let ms = paso.ms;
    if (this.cola.length >= 3) ms = Math.max(80, ms * 0.5);
    else if (this.cola.length >= 1) ms = Math.max(100, ms * 0.75);
    this.desde = { px: this.px, py: this.py };
    this.hasta = { px: paso.x * TS, py: paso.y * TS };
    this.x = paso.x; this.y = paso.y;
    this.t0 = ahora;
    this.ms = ms;
    this.moviendo = true;
  }

  actualizar(ahora) {
    if (!this.moviendo || !this.hasta) {
      if (this.cola && this.cola.length) this._siguiente(ahora);
      return;
    }
    const p = Math.min(1, (ahora - this.t0) / this.ms);
    this.px = this.desde.px + (this.hasta.px - this.desde.px) * p;
    this.py = this.desde.py + (this.hasta.py - this.desde.py) * p;
    if (p >= 1) {
      this.px = this.hasta.px;
      this.py = this.hasta.py;
      this.paso = (this.paso + 1) & 3;
      if (this.cola && this.cola.length) this._siguiente(ahora);
      else { this.moviendo = false; this.hasta = null; }
    }
  }

  // Lo que lleva puesto se dibuja encima del personaje, un icono por ranura.
  // Es lo que hace el cliente: por eso al ponerse las alas o un baculo se le
  // ven al muneco en el mapa.
  // Cada objeto es una FILA entera de la hoja: 12 fotogramas = 4 direcciones x
  // 3 pasos, igual que el cuerpo. El `Pic` del objeto ES el numero de fila.
  // Comprobado: fila 176 = las alas negras en sus 12 poses (las columnas 6-11
  // son el ala de perfil), fila 24 = una espada azul vertical de frente y
  // diagonal de lado.
  //
  // Hay fotogramas vacios a proposito: mirando a la derecha el escudo queda del
  // lado oculto del cuerpo y su casilla esta en blanco. Por eso "desaparece".
  //
  // El objeto va SIEMPRE en el mismo fotograma que el cuerpo. Antes se invertia
  // el trio, y era falso: midiendo contra el cliente Windows, cuerpo y objeto
  // coinciden en el indice, y solo asi la imagen sale pixel a pixel igual.
  frameEquipo() { return this.frame(); }

  _equipo(ctx, dx, dy, ranuras, pasa = () => true) {
    if (!this.hojaItems || !this.puesto) return;
    const f = this.frameEquipo();
    for (const r of ranuras) {
      if (!pasa(r)) continue;
      const pic = this.puesto[r];
      // Una ranura vacia vale 0, y la fila 0 de la hoja son unas alas blancas:
      // por eso salian pegadas al personaje sin pertenecer a ningun objeto, y
      // tapaban lo que si llevaba puesto.
      if (!pic) continue;
      const sy = pic * TS;                  // el Pic del objeto ES la fila
      if (sy + TS > this.hojaItems.height) continue;
      ctx.drawImage(this.hojaItems, f * TS, sy, TS, TS, dx, dy, TS, TS);
    }
  }

  dibujar(ctx, cx, cy) {
    const f = this.frame();
    const dx = Math.round(this.px - cx), dy = Math.round(this.py - cy);

    if (this.grande && this.hojaGrande) {
      // BIGSPRITES: bloques de 64x64, 12 columnas por fila de personaje.
      const G = 64;
      const sx = (f % 12) * G, sy = this.sprite * G;
      if (sy + G <= this.hojaGrande.height) {
        // se ancla por los pies para que pise la misma casilla
        ctx.drawImage(this.hojaGrande, sx, sy, G, G, dx - (G - TS) / 2, dy - (G - TS), G, G);
      }
    } else {
      const sy = this.sprite * TS;
      if (sy + TS > this.hoja.height) return;
      const deEspaldas = this.dir === DIR.ARRIBA;
      const orden = deEspaldas ? ORDEN_DE_ESPALDAS : ORDEN_EQUIPO;
      const debajo = (r) => deEspaldas && DETRAS_DE_ESPALDAS.includes(r);
      // De espaldas, arma y escudo van DEBAJO del cuerpo.
      this._equipo(ctx, dx, dy, orden, debajo);
      ctx.drawImage(this.hoja, f * TS, sy, TS, TS, dx, dy, TS, TS);
      this._equipo(ctx, dx, dy, orden, (r) => !debajo(r));
    }

  }

  // El nombre va aparte porque tiene que pintarse DESPUES de los fringes. Si se
  // dibuja aqui dentro, cualquier arbol o tejado que el mapa pinte por delante
  // del personaje le tapa el nombre: en un bosque los jugadores aparecian
  // anonimos y solo se les veia la barra de vida (que ya se pintaba despues).
  dibujarNombre(ctx, cx, cy) {
    if (!this.nombre || this.verNombre === false) return;
    const dx = Math.round(this.px - cx), dy = Math.round(this.py - cy);
    // Una criatura grande se dibuja 32 px mas arriba (ocupa 64), asi que su
    // nombre tiene que subir lo mismo o queda escrito sobre el cuerpo.
    const arriba = dy - 4 - (this.grande ? 32 : 0);
    ctx.font = '600 13px Tahoma, Verdana, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.fillText(this.nombre, dx + TS / 2 + 1, arriba + 1);
    // Colores del cliente: los jugadores en magenta (comprobado en una
    // captura del juego real, incluido el propio personaje).
    ctx.fillStyle = this.pk
      ? '#ff0000'
      : this.esNpc
        ? COLOR_NPC
        : (COLOR_ACCESO[this.acceso] || COLOR_ACCESO[0]);
    ctx.fillText(this.nombre, dx + TS / 2, arriba);
    // El nom propi de la mascota, a sobre del de l'especie (Perro, Caballo...).
    if (this.apodo) {
      const y = arriba - 14;
      ctx.fillStyle = '#000';
      ctx.fillText(this.apodo, dx + TS / 2 + 1, y + 1);
      ctx.fillStyle = '#3d8bff';
      ctx.fillText(this.apodo, dx + TS / 2, y);
    }
    ctx.textAlign = 'left';
  }
}
