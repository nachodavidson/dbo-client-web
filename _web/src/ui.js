// Interfaz de juego: barras, estadisticas, inventario, equipo y pestanas.
// Reproduce la disposicion del cliente original (paneles a la izquierda,
// pestanas abajo) usando su propio arte extraido del ejecutable.

const TS = 32;
// La tira de inventario del cliente es ancha y baja: 12 columnas por 2 filas.
// El cuadro del cliente muestra 4x4 = 16 ranuras de las 24 que manda el
// servidor; las flechas desplazan la vista.
// Medido sobre las capturas del cliente: celdas de 38 px con 2 de separacion.
export const COLS_INV = 4, FILAS_INV = 4, CELDA_INV = 40, LADO_INV = 38;

// Huecos medidos sobre equipo.png: siete cajas de 35x35 cuyo borde gris se ve
// en la imagen. El icono es de 32, asi que va centrado con +2.
// Orden del servidor: Armadura, Arma, Casco, Escudo, Botas, Amuleto, Hada.
export const SITIOS_EQUIPO = [
  [75, 49],    // armadura  (torso)
  [11, 27],    // arma      (mano izquierda)
  [75, 9],     // casco     (cabeza)
  [139, 27],   // escudo    (mano derecha)
  [75, 136],   // botas     (pies)
  [11, 136],   // amuleto   (estrella)
  [140, 136],  // hada      (luna)
];
const $ = (s) => document.querySelector(s);

// El cliente llama "Inteligencia" a lo que el servidor manda como SPEED.
export const NOMBRE_STAT = { str: 'Fuerza', def: 'Defensa', speed: 'Intelige.', magi: 'Magia' };

export class Interfaz {
  constructor(hojaItems) {
    this.hojaItems = hojaItems;
    this.items = new Map();          // definiciones num -> {nombre, pic, tipo, ...}
    this.inv = [];                   // 24 ranuras {num, cant, dur}
    this.equipo = [0, 0, 0, 0, 0, 0, 0];
    this.vitales = { hp: 0, hpMax: 1, mp: 0, mpMax: 1, sp: 0, spMax: 1 };
    this.stats = { nivel: 0, puntos: 0, str: 0, def: 0, speed: 0, magi: 0, exp: 0, expSig: 1 };
    this.hechizos = new Map();       // definiciones num -> nombre
    this.raza = '';
    this.seleccion = null;
    this.desplazamiento = 0;
    this.ultimaRanura = new Map();   // objeto -> ranura desde la que se uso
    this.pestana = 'dragon';   // el recuadro muestra el dragon hasta que se elige otra cosa
  }

  // --- datos que llegan del servidor ---
  definirItem(num, datos) { this.items.set(num, datos); this.repinta(); }

  setInventario(campos) {
    this.inv = [];
    for (let i = 0; i < 24; i++) {
      const b = 2 + i * 3;
      this.inv.push({ num: +campos[b] || 0, cant: +campos[b+1] || 0, dur: +campos[b+2] || 0 });
    }
    this.repinta();
  }

  // El servidor no reenvia el inventario entero cada vez: cuando cambia UNA
  // ranura manda `PLAYERINVUPDATE`. Sin atender esto, tiras 100 monedas y
  // siguen apareciendo las 500 hasta volver a entrar.
  actualizaRanura(ranura, datos) {
    if (ranura < 0 || ranura >= this.inv.length) return;
    this.inv[ranura] = datos;
    this.repinta();
  }

  setEquipo(campos) {
    // orden del servidor: Armadura, Arma, Casco, Escudo, Botas, Amuleto, Hada
    this.equipo = [1,2,3,4,5,6,7].map(i => +campos[i + 1] || 0);
    // El borde amarillo del inventario sale de esta lista: si no se repinta
    // tambien el inventario, al quitarse algo el marco amarillo se queda
    // pegado hasta cambiar de pestana.
    this.repinta();
  }

  repinta() {
    if (this.pestana === 'equipo') this.pintaEquipo();
    if (this.pestana === 'inventario') this.pintaInventario();
  }

  setVital(cual, actual, maximo) {
    // Al ponerse o quitarse algo que da mucha vida, el servidor manda primero
    // el maximo nuevo con el actual viejo: llega "1200 / 137" y la barra parece
    // rota. Es un estado transitorio suyo, se corrige al siguiente paquete.
    // Aqui no se muestra un numero imposible: el actual nunca pasa del maximo.
    const max = Math.max(1, maximo);
    this.vitales[cual] = Math.max(0, Math.min(actual, max));
    this.vitales[cual + 'Max'] = max;
    this.pintaBarras();
  }

  setStats(campos) {
    const s = this.stats;
    s.str = +campos[1]; s.def = +campos[2]; s.speed = +campos[3]; s.magi = +campos[4];
    s.expSig = +campos[5]; s.exp = +campos[6]; s.nivel = +campos[7];
    this.pintaStats();
  }

  setPuntos(n) { this.stats.puntos = +n; this.pintaStats(); }
  setRaza(r) { this.raza = r; this.pintaStats(); }

  // --- pintado ---
  pintaBarras() {
    const v = this.vitales;
    // Cada barra es el hueco real de la imagen del cliente: dentro va el
    // relleno (<i>) y encima el texto (<b>).
    // En el cliente el numero va ENCIMA de la barra, en la fila de la
    // etiqueta, y el relleno es de color macizo.
    const barra = (id, act, max, texto) => {
      const caja = $(`#b-${id}`), cifra = $(`#n-${id}`);
      if (!caja) return;
      caja.querySelector('i').style.width =
        `${Math.max(0, Math.min(100, 100 * act / max))}%`;
      if (cifra) cifra.textContent = texto !== undefined ? texto : `${act} / ${max}`;
    };
    barra('hp', v.hp, v.hpMax);
    barra('mp', v.mp, v.mpMax);
    barra('sp', v.sp, v.spMax);
    const s = this.stats;
    barra('lv', s.exp, s.expSig, `${s.exp} / ${s.expSig}`);
  }

  pintaStats() {
    const s = this.stats;
    const poner = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    poner('#st-nivel', s.nivel);
    poner('#st-puntos', s.puntos);
    poner('#st-str', s.str);
    poner('#st-def', s.def);
    poner('#st-speed', s.speed);
    poner('#st-magi', s.magi);
    poner('#st-raza', this.raza || '—');
    // los botones de subir stat solo si hay puntos
    document.querySelectorAll('.subir').forEach(b => { b.style.display = s.puntos > 0 ? 'block' : 'none'; });
    this.pintaBarras();
  }

  // Ojo: el icono del inventario y el dibujo que se lleva puesto NO se indexan
  // igual, aunque los dos salgan del mismo `Pic`.
  //   inventario -> catalogo compacto: 6 iconos por fila, mitad izquierda
  //   personaje  -> la fila numero `Pic` entera, sus 12 fotogramas
  // Las dos reglas estan comprobadas por separado: los iconos coinciden con las
  // capturas del inventario del juego, y la fila 176 son las alas negras en sus
  // 12 poses. Intentar unificarlas rompe una de las dos.
  dibujaIcono(ctx, pic, dx, dy) {
    const col = pic % 6, fila = (pic / 6) | 0;
    const sy = fila * TS;
    if (sy + TS > this.hojaItems.height) return;
    ctx.drawImage(this.hojaItems, col * TS, sy, TS, TS, dx, dy, TS, TS);
  }

  // El servidor dice QUE objeto llevas puesto, no de que ranura salio. Si
  // tienes varias copias del mismo, marcar todas es enganoso: parece que se
  // equiparon todas. Se marca solo la primera de cada objeto.
  ranurasPuestas() {
    const marcadas = new Set();
    for (const num of this.equipo) {
      if (!num) continue;
      // Si el jugador uso una ranura concreta para ponerselo, se marca esa;
      // si no, la primera que tenga ese objeto.
      const preferida = this.ultimaRanura.get(num);
      if (preferida !== undefined && !marcadas.has(preferida) &&
          this.inv[preferida] && this.inv[preferida].num === num) {
        marcadas.add(preferida);
        continue;
      }
      const i = this.inv.findIndex((r, k) => r && r.num === num && !marcadas.has(k));
      if (i >= 0) marcadas.add(i);
    }
    return marcadas;
  }

  pintaInventario() {
    const cv = $('#cv-inv');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const puestas = this.ranurasPuestas();
    for (let k = 0; k < COLS_INV * FILAS_INV; k++) {
      const i = k + this.desplazamiento;
      const x = (k % COLS_INV) * CELDA_INV, y = ((k / COLS_INV) | 0) * CELDA_INV;
      const r = this.inv[i];
      const num = r ? r.num : 0;

      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, LADO_INV, LADO_INV);

      // Los dos estados son independientes y pueden darse a la vez, asi que se
      // dibujan los dos: el AMARILLO en el borde de la casilla dice "lo llevas
      // puesto" y el ROJO, un pixel mas adentro, dice "es el elegido".
      ctx.lineWidth = 1;
      const puesto = puestas.has(i);
      ctx.strokeStyle = puesto ? '#f0d000' : '#4a0d0d';
      ctx.strokeRect(x + 0.5, y + 0.5, LADO_INV - 1, LADO_INV - 1);
      if (this.seleccion === i) {
        ctx.strokeStyle = '#e02020';
        ctx.strokeRect(x + 1.5, y + 1.5, LADO_INV - 3, LADO_INV - 3);
      }

      if (!num) continue;
      const def = this.items.get(num);
      if (def) this.dibujaIcono(ctx, def.pic, x + 3, y + 3);
      if (r.cant > 1) {
        ctx.font = '9px Verdana, sans-serif';
        ctx.fillStyle = '#000'; ctx.fillText(r.cant, x + 4, y + LADO_INV - 2);
        ctx.fillStyle = '#ffd'; ctx.fillText(r.cant, x + 3, y + LADO_INV - 3);
      }
    }
  }

  pintaEquipo() {
    const cv = $('#cv-equipo');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const sitios = SITIOS_EQUIPO;

    this.equipo.forEach((num, i) => {
      if (!num) return;
      const def = this.items.get(num);
      if (def) this.dibujaIcono(ctx, def.pic, sitios[i][0], sitios[i][1]);
    });
  }

  definirHechizo(num, nombre) { this.hechizos.set(num, nombre); }
  // Las listas del cliente son cuadros de VB6: siempre muestran las ranuras
  // vacias como <vacio>, no un texto de "no tienes nada".
  pintaLista(el, filas, sel) {
    if (!el) return;
    el.innerHTML = '';
    filas.forEach((t, i) => {
      const d = document.createElement('div');
      d.textContent = t;
      if (i === sel) d.className = 'sel';
      d.dataset.i = i;
      el.appendChild(d);
    });
  }
  nombreHechizo(num) { return this.hechizos.get(num) || `magia #${num}`; }

  nombreDe(num) {
    const d = this.items.get(num);
    return d ? d.nombre : `#${num}`;
  }

  // El globo que sale al pasar el dedo por encima. Mismo texto y mismo orden
  // que el del cliente: nombre (Equipado), Requerimientos, Anade.
  globoDe(num) {
    const d = this.items.get(num);
    if (!d) return null;
    const puesto = this.equipo.includes(num) ? ' (Equipado)' : '';
    const [hp, mp, sp, str, def, magi, speed] = d.adds;
    return [
      { t: `${d.nombre}${puesto}`, c: 'tit' },
      { t: 'Requerimientos', c: 'cab' },
      { t: `${d.reqStr || 0} Fuerza` },
      { t: `${d.reqDef || 0} Defensa` },
      { t: `${d.reqSpeed || 0} Inteligencia` },
      { t: 'Añade', c: 'cab' },
      { t: `HP: ${hp} MP: ${mp} SP: ${sp}` },
      { t: `Fuerza: ${str} Defensa: ${def}` },
      { t: `Magia: ${magi} Inteligencia: ${speed}` },
    ];
  }

  detalleRanura(i) {
    const r = this.inv[i];
    if (!r || !r.num) return '';
    const d = this.items.get(r.num);
    if (!d) return `item #${r.num}`;
    const extras = [];
    const et = ['HP','MP','SP','Fuerza','Defensa','Magia','Intelig.','EXP'];
    d.adds.forEach((v, k) => { if (v) extras.push(`${et[k]} +${v}`); });
    return `${d.nombre}${r.cant > 1 ? ` (${r.cant})` : ''}` +
           (extras.length ? ` — ${extras.join(', ')}` : '') +
           (d.desc ? ` · ${d.desc}` : '');
  }

  mostrarPestana(cual) {
    this.pestana = cual;
    document.querySelectorAll('.panel').forEach(p => {
      p.classList.toggle('visible', p.dataset.panel === cual);
    });
    document.querySelectorAll('.tab').forEach(b => {
      b.classList.toggle('activa', b.dataset.tab === cual);
    });
    if (cual === 'inventario') this.pintaInventario();
    if (cual === 'equipo') this.pintaEquipo();
  }

  chat(texto, color) {
    const log = $('#chatlog');
    if (!log || !texto) return;
    const l = document.createElement('div');
    l.textContent = texto;
    if (color) l.style.color = color;
    log.appendChild(l);
    while (log.childElementCount > 200) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
}
