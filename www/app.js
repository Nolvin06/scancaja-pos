/* ==========================================================================
   SCANCAJA POS — LÓGICA PRINCIPAL (100% LOCAL INDEXEDDB + ESCÁNER + FINANZAS)
   ========================================================================== */

const IDB_NAME = 'ScanCajaPOSLocalDB';
const IDB_VERSION = 1;

const CATEGORIAS_INICIALES = [
  { id: 'cat-abarrotes', nombre: 'Abarrotes' },
  { id: 'cat-bebidas', nombre: 'Bebidas' },
  { id: 'cat-lacteos', nombre: 'Lácteos' },
  { id: 'cat-snacks', nombre: 'Snacks' },
  { id: 'cat-limpieza', nombre: 'Limpieza' }
];

/* ---------------- ESTADO GLOBAL ---------------- */
const state = {
  categorias: [],
  productos: [],
  ventas: [],
  movimientos: [],
  ajustes: {
    clave: 'config_general',
    nombre_negocio: 'ScanCaja POS',
    moneda: 'C$'
  },
  carrito: [], // [{ producto_id, codigo, nombre, categoria_id, precio_unitario, costo_unitario, cantidad }]
  categoriaPos: 'todas',
  categoriaCatalogo: 'todas',
  busquedaPos: '',
  busquedaCatalogo: '',
  periodoActivo: 'hoy',
  categoriaResumen: 'todas',
  ultimoCodigoNoEncontrado: '',
  editandoCantidadId: null,
  ventaDetalleId: null,
  // Estado del escáner
  scanner: {
    instancia: null,
    activo: false,
    modo: 'venta', // 'venta' | 'registro' | 'campo-codigo'
    camaraTrasera: true,
    linternaActiva: false,
    ultimoCodigoLeido: '',
    ultimaLecturaTs: 0
  }
};

/* ---------------- UTILIDADES ---------------- */
const $ = (id) => document.getElementById(id);

function money(val) {
  const sim = state.ajustes.moneda || 'C$';
  return `${sim} ${Number(val || 0).toLocaleString('es-NI', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function fmtNum(val) {
  const n = Number(val || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generarId(prefijo = 'id') {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return `${prefijo}-${crypto.randomUUID()}`;
  }
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generarCodigoInterno() {
  const base = String(Date.now()).slice(-9);
  const rand = String(Math.floor(100 + Math.random() * 900));
  return `20${base}${rand}`;
}

function horaCorta(iso) {
  return new Date(iso).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit' });
}

function fechaHoraCorta(iso) {
  return new Date(iso).toLocaleString('es-NI', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function showToast(msg, tipo = 'info') {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${tipo !== 'info' ? `toast-${tipo}` : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), tipo === 'error' ? 4500 : 2900);
}

/* ---------------- SONIDO BEEP TIPO SUPERMERCADO ---------------- */
let audioCtx = null;

function tocarBeep(tipo = 'ok') {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = tipo === 'ok' ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(tipo === 'ok' ? 1480 : 340, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.14, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (tipo === 'ok' ? 0.11 : 0.22));

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + (tipo === 'ok' ? 0.12 : 0.23));

    if (navigator.vibrate) {
      navigator.vibrate(tipo === 'ok' ? 45 : [70, 40, 70]);
    }
  } catch {
    // Silenciar si el dispositivo bloquea audio sin gesto previo
  }
}

/* ---------------- INDEXEDDB (BASE DE DATOS LOCAL) ---------------- */
let idbInstance = null;

function abrirIDB() {
  if (idbInstance) return Promise.resolve(idbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('categorias')) {
        db.createObjectStore('categorias', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('productos')) {
        db.createObjectStore('productos', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('ventas')) {
        db.createObjectStore('ventas', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('movimientos')) {
        db.createObjectStore('movimientos', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('ajustes')) {
        db.createObjectStore('ajustes', { keyPath: 'clave' });
      }
    };
    req.onsuccess = () => {
      idbInstance = req.result;
      resolve(idbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const db = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear(storeName) {
  const db = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAll(storeName) {
  const db = await abrirIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function cargarBaseLocal() {
  let [cats, prods, ventas, movs, ajustesLista] = await Promise.all([
    idbGetAll('categorias'),
    idbGetAll('productos'),
    idbGetAll('ventas'),
    idbGetAll('movimientos'),
    idbGetAll('ajustes')
  ]);

  if (!cats.length) {
    for (const c of CATEGORIAS_INICIALES) {
      await idbPut('categorias', c);
    }
    cats = [...CATEGORIAS_INICIALES];
  }

  state.categorias = cats.sort((a, b) => a.nombre.localeCompare(b.nombre));
  state.productos = prods
    .filter((p) => p.activo !== false)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  state.ventas = ventas.sort((a, b) => new Date(b.creada_en) - new Date(a.creada_en));
  state.movimientos = movs.sort((a, b) => new Date(b.creada_en) - new Date(a.creada_en));

  const cfg = ajustesLista.find((x) => x.clave === 'config_general');
  if (cfg) {
    state.ajustes = { ...state.ajustes, ...cfg };
  }

  aplicarAjustesUI();
  renderTodo();
}

/* ---------------- AJUSTES Y NAVEGACIÓN ---------------- */
function aplicarAjustesUI() {
  $('titulo-negocio-header').textContent = state.ajustes.nombre_negocio || 'ScanCaja POS';
  $('input-nombre-negocio').value = state.ajustes.nombre_negocio || 'ScanCaja POS';
  $('select-moneda').value = state.ajustes.moneda || 'C$';
}

function cambiarVista(vistaId) {
  document.querySelectorAll('.vista').forEach((v) => v.classList.remove('activa'));
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('activa'));

  const target = $(vistaId);
  if (target) target.classList.add('activa');

  const btn = document.querySelector(`.nav-item[data-vista="${vistaId}"]`);
  if (btn) btn.classList.add('activa');

  actualizarBarraCarrito();
}

function nombreCategoria(catId) {
  const c = state.categorias.find((x) => x.id === catId);
  return c ? c.nombre : 'General';
}

function nombreProducto(prodId) {
  const p = state.productos.find((x) => x.id === prodId);
  return p ? p.nombre : 'Producto';
}

function buscarProductoPorCodigo(codigo) {
  const limpio = String(codigo || '').trim();
  if (!limpio) return null;
  return state.productos.find((p) => String(p.codigo || '').trim() === limpio) || null;
}

/* ---------------- RENDERIZADO GENERAL ---------------- */
function renderTodo() {
  renderChipsTodasLasVistas();
  renderGridPOS();
  renderCatalogo();
  renderResumen();
  renderGestion();
  actualizarBarraCarrito();
}

function renderChipsTodasLasVistas() {
  const construirChips = (activa, attr) =>
    [
      `<button type="button" class="chip ${activa === 'todas' ? 'activa' : ''}" data-${attr}="todas">Todos</button>`,
      ...state.categorias.map(
        (c) =>
          `<button type="button" class="chip ${activa === c.id ? 'activa' : ''}" data-${attr}="${esc(c.id)}">${esc(c.nombre)}</button>`
      )
    ].join('');

  $('chips-categorias-pos').innerHTML = construirChips(state.categoriaPos, 'cat-pos');
  $('chips-categorias-catalogo').innerHTML = construirChips(state.categoriaCatalogo, 'cat-catalogo');

  $('chips-categorias-resumen').innerHTML = [
    `<button type="button" class="chip ${state.categoriaResumen === 'todas' ? 'activa' : ''}" data-cat-resumen="todas">Todas las categorías</button>`,
    ...state.categorias.map(
      (c) =>
        `<button type="button" class="chip ${state.categoriaResumen === c.id ? 'activa' : ''}" data-cat-resumen="${esc(c.id)}">${esc(c.nombre)}</button>`
    )
  ].join('');
}

/* ---------------- VISTA 1: POS Y VISOR ESCÁNER ---------------- */
function mostrarEnVisorEscaneo(producto, codigoIngresado = '') {
  const visor = $('visor-ultimo-escaneo');
  const btnNuevo = $('btn-registrar-codigo-nuevo');

  visor.classList.remove('oculto');

  if (producto) {
    state.ultimoCodigoNoEncontrado = '';
    visor.classList.remove('no-encontrado');
    $('ultimo-codigo').textContent = producto.codigo ? `Código: ${producto.codigo}` : 'Sin código';
    $('ultimo-nombre').textContent = producto.nombre;
    $('ultimo-precio').textContent = money(producto.precio_venta);
    btnNuevo.classList.add('oculto');
  } else {
    state.ultimoCodigoNoEncontrado = codigoIngresado;
    visor.classList.add('no-encontrado');
    $('ultimo-codigo').textContent = `Código: ${codigoIngresado}`;
    $('ultimo-nombre').textContent = 'Producto no registrado';
    $('ultimo-precio').textContent = 'Sin precio';
    btnNuevo.classList.remove('oculto');
  }
}

function procesarCodigoEnVenta(codigoRaw, desdeModal = false) {
  const codigo = String(codigoRaw || '').trim();
  if (!codigo) return;

  const prod = buscarProductoPorCodigo(codigo);
  if (prod) {
    tocarBeep('ok');
    agregarAlCarrito(prod.id);
    mostrarEnVisorEscaneo(prod);

    if (desdeModal) {
      mostrarFeedbackModal(
        `Agregado: ${prod.nombre} — ${money(prod.precio_venta)}`,
        'ok'
      );
    } else {
      showToast(`${prod.nombre} (${money(prod.precio_venta)})`, 'success');
    }
  } else {
    tocarBeep('warn');
    mostrarEnVisorEscaneo(null, codigo);

    if (desdeModal) {
      mostrarFeedbackModal(
        `Código ${codigo} sin precio. Abriendo registro...`,
        'warn'
      );
      setTimeout(async () => {
        await cerrarEscaner();
        abrirModalProducto(null, codigo);
      }, 650);
    } else {
      showToast(`Código ${codigo} no registrado. Toca "+ Poner precio"`, 'warning');
    }
  }
}

function renderGridPOS() {
  const grid = $('grid-productos-pos');
  const q = state.busquedaPos.trim().toLowerCase();

  const filtrados = state.productos.filter((p) => {
    const matchCat = state.categoriaPos === 'todas' || p.categoria_id === state.categoriaPos;
    const matchQ =
      !q ||
      p.nombre.toLowerCase().includes(q) ||
      String(p.codigo || '').toLowerCase().includes(q);
    return matchCat && matchQ;
  });

  if (!filtrados.length) {
    grid.innerHTML = state.productos.length
      ? `<div class="empty-state">No hay productos que coincidan con tu búsqueda.</div>`
      : `<div class="empty-state">Todavía no tienes productos. Escanea un producto en "Productos" o aquí arriba para ponerle precio.</div>`;
    return;
  }

  const disponibles = filtrados.filter((p) => Number(p.stock_actual || 0) > 0);
  const agotados = filtrados.filter((p) => Number(p.stock_actual || 0) <= 0);

  const renderCard = (p) => {
    const enCarrito = state.carrito.find((i) => i.producto_id === p.id);
    const stock = Number(p.stock_actual || 0);
    const min = Number(p.stock_minimo || 5);

    let badgeClase = '';
    let badgeTexto = `Stock ${fmtNum(stock)}`;
    if (stock <= 0) {
      badgeClase = 'agotado';
      badgeTexto = 'Agotado';
    } else if (stock <= min) {
      badgeClase = 'bajo';
    }

    return `
      <button type="button" class="prod-card ${enCarrito ? 'en-carrito' : ''} ${stock <= 0 ? 'sin-stock' : ''}" data-prod-id="${esc(p.id)}">
        <div class="prod-card-top">
          <span class="prod-cat-tag">${esc(nombreCategoria(p.categoria_id))}</span>
          <span class="prod-stock-badge ${badgeClase}">${badgeTexto}</span>
        </div>
        <div>
          <div class="prod-name">${esc(p.nombre)}</div>
          <div class="prod-barcode-mini">${p.codigo ? esc(p.codigo) : 'Sin código'}</div>
        </div>
        <div class="prod-card-bottom">
          <span class="prod-price">${money(p.precio_venta)}</span>
          ${enCarrito ? `<span class="prod-qty-pill">${fmtNum(enCarrito.cantidad)}</span>` : ''}
        </div>
      </button>
    `;
  };

  let html = disponibles.map(renderCard).join('');
  if (agotados.length) {
    html += `<div class="grid-divider">Agotados (${agotados.length})</div>`;
    html += agotados.map(renderCard).join('');
  }

  grid.innerHTML = html;
}

/* ---------------- VISTA 2: CATÁLOGO DE PRODUCTOS ---------------- */
function renderCatalogo() {
  const cont = $('lista-productos-catalogo');
  const q = state.busquedaCatalogo.trim().toLowerCase();

  const filtrados = state.productos.filter((p) => {
    const matchCat = state.categoriaCatalogo === 'todas' || p.categoria_id === state.categoriaCatalogo;
    const matchQ =
      !q ||
      p.nombre.toLowerCase().includes(q) ||
      String(p.codigo || '').toLowerCase().includes(q);
    return matchCat && matchQ;
  });

  if (!filtrados.length) {
    cont.innerHTML = `<div class="empty-state">No hay productos registrados. Toca "Escanear" o "+ Nuevo" para crear uno.</div>`;
    return;
  }

  cont.innerHTML = filtrados
    .map((p) => {
      const bajo = Number(p.stock_actual) <= Number(p.stock_minimo);
      const gananciaUnit = Number(p.precio_venta || 0) - Number(p.precio_costo || 0);
      const refSuper =
        Number(p.precio_super || 0) > 0 ? `<span>•</span><span>Súper: ${money(p.precio_super)}</span>` : '';

      return `
        <div class="item-row clickable" data-edit-prod="${esc(p.id)}">
          <div class="item-main">
            <div class="item-title">${esc(p.nombre)}</div>
            <div class="item-meta">
              <span>${p.codigo ? esc(p.codigo) : 'Sin código'}</span>
              <span>•</span>
              <span>Costo: ${money(p.precio_costo)}</span>
              <span>•</span>
              <span class="text-profit">Gana: ${money(gananciaUnit)}</span>
              ${refSuper}
            </div>
          </div>
          <div class="item-right">
            <span class="item-amount">${money(p.precio_venta)}</span>
            <span class="badge-status ${bajo ? 'badge-low' : 'badge-ok'}">Quedan ${fmtNum(p.stock_actual)}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

/* ---------------- VISTA 3: RESUMEN FINANCIERO (VENTAS, INVERSIÓN Y GANANCIA) ---------------- */
function obtenerVentasFiltradas() {
  const ahora = new Date();
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const inicioAyer = new Date(inicioHoy);
  inicioAyer.setDate(inicioAyer.getDate() - 1);

  const inicioSemana = new Date(inicioHoy);
  const dia = inicioSemana.getDay();
  const diffLunes = dia === 0 ? 6 : dia - 1;
  inicioSemana.setDate(inicioSemana.getDate() - diffLunes);

  const inicioMes = new Date(inicioHoy);
  inicioMes.setDate(inicioMes.getDate() - 30);

  const porFecha = state.ventas.filter((v) => {
    const f = new Date(v.creada_en);
    if (state.periodoActivo === 'hoy') return f >= inicioHoy;
    if (state.periodoActivo === 'ayer') return f >= inicioAyer && f < inicioHoy;
    if (state.periodoActivo === 'semana') return f >= inicioSemana;
    if (state.periodoActivo === 'mes') return f >= inicioMes;
    return true;
  });

  if (state.categoriaResumen === 'todas') return porFecha;

  return porFecha
    .map((v) => {
      const itemsCat = (v.items || []).filter((it) => {
        const prod = state.productos.find((p) => p.id === it.producto_id);
        const catItem = it.categoria_id || prod?.categoria_id;
        return catItem === state.categoriaResumen;
      });
      if (!itemsCat.length) return null;

      const totalCat = itemsCat.reduce((s, d) => s + Number(d.subtotal || 0), 0);
      const costoCat = itemsCat.reduce((s, d) => s + Number(d.costo_total || 0), 0);
      return {
        ...v,
        total: totalCat,
        costo_total: costoCat,
        ganancia_total: totalCat - costoCat,
        items: itemsCat
      };
    })
    .filter(Boolean);
}

function etiquetaPeriodo() {
  const mapa = {
    hoy: 'hoy',
    ayer: 'ayer',
    semana: 'esta semana',
    mes: 'último mes',
    todos: 'histórico total'
  };
  return mapa[state.periodoActivo] || 'hoy';
}

function calcularResumenProductos(ventasFiltradas) {
  const mapa = new Map();
  let totalUnidades = 0;

  ventasFiltradas.forEach((v) => {
    (v.items || []).forEach((it) => {
      const clave = it.producto_id || it.nombre;
      const actual = mapa.get(clave) || {
        producto_id: it.producto_id,
        nombre: it.nombre,
        vendido: 0,
        dinero: 0,
        invertido: 0,
        ganancia: 0
      };
      const sub = Number(it.subtotal || 0);
      const costo = Number(it.costo_total ?? Number(it.cantidad || 0) * Number(it.costo_unitario || 0));
      actual.vendido += Number(it.cantidad || 0);
      actual.dinero += sub;
      actual.invertido += costo;
      actual.ganancia += sub - costo;
      totalUnidades += Number(it.cantidad || 0);
      mapa.set(clave, actual);
    });
  });

  const lista = Array.from(mapa.values()).map((item) => {
    const prod = state.productos.find((p) => p.id === item.producto_id);
    return {
      ...item,
      stock_restante: prod ? Number(prod.stock_actual) : null,
      stock_minimo: prod ? Number(prod.stock_minimo) : 5
    };
  });

  lista.sort((a, b) => b.dinero - a.dinero);
  return { lista, totalUnidades };
}

function renderResumen() {
  document.querySelectorAll('#chips-periodo-resumen .chip').forEach((btn) => {
    btn.classList.toggle('activa', btn.dataset.periodo === state.periodoActivo);
  });

  const ventasFiltradas = obtenerVentasFiltradas();
  const totalVentas = ventasFiltradas.reduce((s, v) => s + Number(v.total || 0), 0);
  const totalInvertido = ventasFiltradas.reduce((s, v) => s + Number(v.costo_total || 0), 0);
  const totalGanancia = totalVentas - totalInvertido;
  const margen = totalVentas > 0 ? (totalGanancia / totalVentas) * 100 : 0;

  const { lista: resumenProds, totalUnidades } = calcularResumenProductos(ventasFiltradas);

  const bajos = state.productos
    .filter((p) => Number(p.stock_actual) <= Number(p.stock_minimo))
    .filter((p) => state.categoriaResumen === 'todas' || p.categoria_id === state.categoriaResumen)
    .sort((a, b) => Number(a.stock_actual) - Number(b.stock_actual) || a.nombre.localeCompare(b.nombre));

  const sufijoCat =
    state.categoriaResumen === 'todas' ? '' : ` • ${nombreCategoria(state.categoriaResumen)}`;

  $('label-total-periodo').textContent = `Total vendido (${etiquetaPeriodo()}${sufijoCat})`;
  $('titulo-resumen-productos').textContent = `Vendido (${etiquetaPeriodo()}) y ganancia por producto`;
  $('titulo-facturas-periodo').textContent =
    state.periodoActivo === 'todos'
      ? 'Historial de facturas por mes'
      : `Facturas (${etiquetaPeriodo()})`;

  $('kpi-total-ventas').textContent = money(totalVentas);
  $('kpi-num-ventas').textContent = String(ventasFiltradas.length);
  $('kpi-unidades-vendidas').textContent = fmtNum(totalUnidades);
  $('kpi-total-invertido').textContent = money(totalInvertido);
  $('kpi-total-ganancia').textContent = money(totalGanancia);
  $('kpi-margen-ganancia').textContent = `Margen: ${margen.toFixed(1)}%`;
  $('kpi-total-productos').textContent = String(state.productos.length);
  $('kpi-stock-bajo').textContent = String(bajos.length);

  // Alertas de stock bajo
  const bloqueAlertas = $('bloque-alertas-stock');
  const contBajos = $('lista-stock-bajo');
  if (!bajos.length) {
    bloqueAlertas.classList.add('oculto');
  } else {
    bloqueAlertas.classList.remove('oculto');
    contBajos.innerHTML = bajos
      .map(
        (p) => `
        <div class="item-row clickable" data-edit-prod="${esc(p.id)}">
          <div class="item-main">
            <div class="item-title">${esc(p.nombre)}</div>
            <div class="item-meta">Mínimo configurado: ${fmtNum(p.stock_minimo)}</div>
          </div>
          <div class="item-right">
            <span class="badge-status badge-low">Quedan ${fmtNum(p.stock_actual)}</span>
          </div>
        </div>
      `
      )
      .join('');
  }

  // Resumen por producto
  const contResumen = $('lista-resumen-productos');
  if (!resumenProds.length) {
    contResumen.innerHTML = `<div class="empty-state-sm">No hay ventas registradas en este filtro.</div>`;
  } else {
    contResumen.innerHTML = resumenProds
      .map((r) => {
        const quedaTexto =
          r.stock_restante === null ? 'Sin dato' : `Quedan ${fmtNum(r.stock_restante)}`;
        const badgeClase =
          r.stock_restante !== null && r.stock_restante <= r.stock_minimo ? 'badge-low' : 'badge-ok';

        return `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">${esc(r.nombre)}</div>
              <div class="item-meta">
                <span>Vendió: <strong>${fmtNum(r.vendido)}</strong></span>
                <span>•</span>
                <span>Inv: ${money(r.invertido)}</span>
                <span>•</span>
                <span class="text-profit">Gana: ${money(r.ganancia)}</span>
              </div>
            </div>
            <div class="item-right">
              <span class="item-amount">${money(r.dinero)}</span>
              <span class="badge-status ${badgeClase}">${quedaTexto}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // Facturas
  const contFacturas = $('lista-facturas');
  if (!ventasFiltradas.length) {
    contFacturas.innerHTML = `<div class="empty-state-sm">Sin ventas registradas en este período.</div>`;
    return;
  }

  const renderFilaFactura = (v, mostrarFecha) => {
    const numItems = (v.items || []).reduce((s, d) => s + Number(d.cantidad || 0), 0);
    const etiquetaHora = mostrarFecha ? fechaHoraCorta(v.creada_en) : horaCorta(v.creada_en);
    const ganancia = Number(v.ganancia_total ?? Number(v.total || 0) - Number(v.costo_total || 0));

    return `
      <div class="item-row clickable" data-venta-id="${esc(v.id)}">
        <div class="item-main">
          <div class="item-title">Factura • ${etiquetaHora}</div>
          <div class="item-meta">
            <span>${fmtNum(numItems)} unidad(es)</span>
            <span>•</span>
            <span class="text-profit">Ganancia: ${money(ganancia)}</span>
          </div>
        </div>
        <div class="item-right">
          <span class="item-amount">${money(v.total)}</span>
          <span class="badge-status badge-synced">Ver →</span>
        </div>
      </div>
    `;
  };

  if (state.periodoActivo === 'todos') {
    const grupos = new Map();
    ventasFiltradas.forEach((v) => {
      const f = new Date(v.creada_en);
      const claveMes = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}`;
      const tituloMes = f.toLocaleDateString('es-NI', { month: 'long', year: 'numeric' });
      if (!grupos.has(claveMes)) grupos.set(claveMes, { titulo: tituloMes, ventas: [] });
      grupos.get(claveMes).ventas.push(v);
    });

    let html = '';
    grupos.forEach((grupo) => {
      const totalMes = grupo.ventas.reduce((s, x) => s + Number(x.total || 0), 0);
      const ganMes = grupo.ventas.reduce(
        (s, x) => s + Number(x.ganancia_total ?? Number(x.total || 0) - Number(x.costo_total || 0)),
        0
      );
      html += `<div class="month-group-title">${esc(grupo.titulo)} — Ventas: ${money(totalMes)} | Ganancia: ${money(ganMes)}</div>`;
      html += grupo.ventas.map((v) => renderFilaFactura(v, true)).join('');
    });
    contFacturas.innerHTML = html;
  } else {
    const mostrarFecha = state.periodoActivo !== 'hoy';
    contFacturas.innerHTML = ventasFiltradas.map((v) => renderFilaFactura(v, mostrarFecha)).join('');
  }
}

/* ---------------- VISTA 4: GESTIÓN, MOVIMIENTOS Y CATEGORÍAS ---------------- */
function renderGestion() {
  const select = $('select-prod-movimiento');
  const actual = select.value;
  select.innerHTML =
    `<option value="">Selecciona un producto...</option>` +
    state.productos
      .map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)} (Stock: ${fmtNum(p.stock_actual)})</option>`)
      .join('');
  if (actual) select.value = actual;

  const contCats = $('lista-categorias-config');
  contCats.innerHTML = state.categorias.length
    ? state.categorias
        .map(
          (c) => `
            <span class="tag-chip">
              <span>${esc(c.nombre)}</span>
              <button type="button" class="tag-chip-del" data-del-cat="${esc(c.id)}" data-cat-nombre="${esc(c.nombre)}" aria-label="Eliminar ${esc(c.nombre)}">✕</button>
            </span>
          `
        )
        .join('')
    : `<span class="modal-subtitle">Sin categorías registradas</span>`;

  const selProdCat = $('prod-categoria');
  const valCat = selProdCat.value;
  selProdCat.innerHTML =
    `<option value="">Selecciona una categoría...</option>` +
    state.categorias.map((c) => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join('') +
    `<option value="__nueva__">+ Agregar nueva categoría...</option>`;
  if (valCat && valCat !== '__nueva__') selProdCat.value = valCat;

  const contMovs = $('lista-movimientos-recientes');
  if (!state.movimientos.length) {
    contMovs.innerHTML = `<div class="empty-state-sm">Sin movimientos registrados todavía.</div>`;
  } else {
    contMovs.innerHTML = state.movimientos
      .slice(0, 60)
      .map((m) => {
        const esEntrada = m.tipo === 'entrada';
        const esVenta = m.tipo === 'venta';
        const signo = Number(m.cantidad) > 0 ? '+' : '';
        const badgeClase = esEntrada ? 'badge-entry' : esVenta ? 'badge-pending' : 'badge-adjust';
        const tipoLabel = esEntrada ? 'Entrada' : esVenta ? 'Venta' : Number(m.cantidad) > 0 ? 'Devolución' : 'Ajuste';

        return `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">${esc(m.nombre_producto || nombreProducto(m.producto_id))}</div>
              <div class="item-meta">
                <span>${fechaHoraCorta(m.creada_en)}</span>
                ${m.nota ? `<span>•</span><span>${esc(m.nota)}</span>` : ''}
              </div>
            </div>
            <div class="item-right">
              <span class="item-amount">${signo}${fmtNum(m.cantidad)}</span>
              <span class="badge-status ${badgeClase}">${tipoLabel}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

/* ---------------- CARRITO Y COBRO ---------------- */
function agregarAlCarrito(productoId) {
  const prod = state.productos.find((p) => p.id === productoId);
  if (!prod) return;

  const existente = state.carrito.find((i) => i.producto_id === productoId);
  const nuevaCant = existente ? Number(existente.cantidad) + 1 : 1;

  if (Number(prod.stock_actual) <= 0) {
    showToast(`Sin stock registrado de ${prod.nombre}`, 'warning');
  } else if (nuevaCant > Number(prod.stock_actual)) {
    showToast(`Solo quedan ${fmtNum(prod.stock_actual)} de ${prod.nombre}`, 'warning');
  }

  if (existente) {
    existente.cantidad = nuevaCant;
  } else {
    state.carrito.push({
      producto_id: prod.id,
      codigo: prod.codigo || '',
      nombre: prod.nombre,
      categoria_id: prod.categoria_id || '',
      precio_unitario: Number(prod.precio_venta || 0),
      costo_unitario: Number(prod.precio_costo || 0),
      cantidad: 1
    });
  }

  renderGridPOS();
  actualizarBarraCarrito();
}

function totalesCarrito() {
  let total = 0;
  let costo = 0;
  let unidades = 0;
  state.carrito.forEach((i) => {
    const q = Number(i.cantidad || 0);
    total += q * Number(i.precio_unitario || 0);
    costo += q * Number(i.costo_unitario || 0);
    unidades += q;
  });
  return { total, costo, ganancia: total - costo, unidades };
}

function actualizarBarraCarrito() {
  const barra = $('barra-carrito');
  const enVistaVender = $('vista-vender').classList.contains('activa');

  if (!state.carrito.length || !enVistaVender) {
    barra.classList.add('oculto');
    return;
  }

  const { total, unidades } = totalesCarrito();
  $('carrito-cantidad-badge').textContent = fmtNum(unidades);
  $('carrito-total-barra').textContent = money(total);
  barra.classList.remove('oculto');
}

function abrirModalCarrito() {
  renderModalCarrito();
  $('input-pago-con').value = '';
  actualizarVuelto();
  $('modal-carrito').classList.remove('oculto');
}

function cerrarModalCarrito() {
  $('modal-carrito').classList.add('oculto');
}

function renderModalCarrito() {
  const cont = $('lista-items-carrito');
  if (!state.carrito.length) {
    cerrarModalCarrito();
    renderGridPOS();
    actualizarBarraCarrito();
    return;
  }

  cont.innerHTML = state.carrito
    .map((item) => {
      const sub = Number(item.cantidad) * Number(item.precio_unitario);
      return `
        <div class="cart-item" data-id="${esc(item.producto_id)}">
          <div class="cart-item-info">
            <div class="cart-item-title">${esc(item.nombre)}</div>
            <div class="cart-item-price-row">
              <span>${money(item.precio_unitario)} c/u</span>
              <span>•</span>
              <strong>${money(sub)}</strong>
            </div>
          </div>

          <div class="qty-control">
            <button type="button" class="qty-btn" data-action="minus" data-id="${esc(item.producto_id)}" aria-label="Restar">−</button>
            <button type="button" class="qty-val" data-action="manual-qty" data-id="${esc(item.producto_id)}" title="Cantidad exacta">${fmtNum(item.cantidad)}</button>
            <button type="button" class="qty-btn" data-action="plus" data-id="${esc(item.producto_id)}" aria-label="Sumar">+</button>
          </div>
        </div>
      `;
    })
    .join('');

  const { total, ganancia } = totalesCarrito();
  $('total-modal-carrito').textContent = money(total);
  $('ganancia-modal-carrito').textContent = money(ganancia);
  actualizarVuelto();
}

function actualizarVuelto() {
  const { total } = totalesCarrito();
  const pagaCon = Number($('input-pago-con').value || 0);
  const el = $('texto-vuelto');

  if (pagaCon <= 0) {
    el.textContent = money(0);
    el.className = '';
    return;
  }
  const diff = pagaCon - total;
  if (diff < 0) {
    el.textContent = `Faltan ${money(Math.abs(diff))}`;
    el.className = 'text-danger';
  } else {
    el.textContent = money(diff);
    el.className = 'text-profit';
  }
}

async function confirmarVenta() {
  if (!state.carrito.length) return;

  const { total, costo, ganancia } = totalesCarrito();
  const ahora = new Date().toISOString();
  const ventaId = generarId('vta');

  const itemsVenta = state.carrito.map((it) => {
    const q = Number(it.cantidad);
    const precio = Number(it.precio_unitario);
    const costUnit = Number(it.costo_unitario || 0);
    const sub = Number((q * precio).toFixed(2));
    const costTot = Number((q * costUnit).toFixed(2));
    return {
      producto_id: it.producto_id,
      codigo: it.codigo || '',
      nombre: it.nombre,
      categoria_id: it.categoria_id || '',
      cantidad: q,
      precio_unitario: precio,
      costo_unitario: costUnit,
      subtotal: sub,
      costo_total: costTot,
      ganancia: Number((sub - costTot).toFixed(2))
    };
  });

  const nuevaVenta = {
    id: ventaId,
    creada_en: ahora,
    total: Number(total.toFixed(2)),
    costo_total: Number(costo.toFixed(2)),
    ganancia_total: Number(ganancia.toFixed(2)),
    items: itemsVenta
  };

  try {
    await idbPut('ventas', nuevaVenta);
    state.ventas.unshift(nuevaVenta);

    for (const it of itemsVenta) {
      const prod = state.productos.find((p) => p.id === it.producto_id);
      if (prod) {
        prod.stock_actual = Math.max(0, Number((Number(prod.stock_actual || 0) - it.cantidad).toFixed(2)));
        prod.actualizado_en = ahora;
        await idbPut('productos', prod);
      }

      const mov = {
        id: generarId('mov'),
        producto_id: it.producto_id,
        nombre_producto: it.nombre,
        tipo: 'venta',
        cantidad: -Math.abs(it.cantidad),
        nota: `Venta ${ventaId.slice(-6)}`,
        creada_en: ahora
      };
      await idbPut('movimientos', mov);
      state.movimientos.unshift(mov);
    }

    tocarBeep('ok');
    state.carrito = [];
    cerrarModalCarrito();
    renderTodo();
    showToast(`Venta cobrada: ${money(nuevaVenta.total)} (Ganancia: ${money(nuevaVenta.ganancia_total)})`, 'success');
  } catch (err) {
    showToast(`Error al guardar venta: ${err.message}`, 'error');
  }
}

/* ---------------- CANTIDAD MANUAL ---------------- */
function abrirModalCantidad(productoId) {
  const item = state.carrito.find((i) => i.producto_id === productoId);
  if (!item) return;

  const prod = state.productos.find((p) => p.id === productoId);
  state.editandoCantidadId = productoId;

  $('titulo-modal-cantidad').textContent = item.nombre;
  $('subtitulo-modal-cantidad').textContent = `Stock disponible: ${fmtNum(prod?.stock_actual || 0)}`;
  $('input-cantidad-manual').value = fmtNum(item.cantidad);

  const opciones = [
    { val: 0.5, txt: '½' },
    { val: 1, txt: '1' },
    { val: 2, txt: '2' },
    { val: 3, txt: '3' },
    { val: 5, txt: '5' },
    { val: 6, txt: '6' },
    { val: 12, txt: '12' },
    { val: 24, txt: '24' }
  ];

  $('grid-presets-cantidad').innerHTML = opciones
    .map(
      (op) => `
        <button type="button" class="preset-btn ${Number(item.cantidad) === op.val ? 'activo' : ''}" data-preset-val="${op.val}">
          ${op.txt}
        </button>
      `
    )
    .join('');

  $('modal-cantidad').classList.remove('oculto');
  $('input-cantidad-manual').focus();
}

function cerrarModalCantidad() {
  $('modal-cantidad').classList.add('oculto');
  state.editandoCantidadId = null;
}

function aplicarCantidadManual(valorDirecto = null) {
  const val = valorDirecto !== null ? Number(valorDirecto) : Number($('input-cantidad-manual').value);
  if (isNaN(val) || val < 0) {
    showToast('Ingresa una cantidad válida', 'error');
    return;
  }

  const id = state.editandoCantidadId;
  if (val === 0) {
    state.carrito = state.carrito.filter((i) => i.producto_id !== id);
  } else {
    const item = state.carrito.find((i) => i.producto_id === id);
    if (item) item.cantidad = val;
  }

  cerrarModalCantidad();
  renderModalCarrito();
  renderGridPOS();
  actualizarBarraCarrito();
}

/* ---------------- MODAL PRODUCTO (REGISTRO / EDICIÓN) ---------------- */
function actualizarPreviewGananciaProducto() {
  const costo = Number($('prod-costo').value || 0);
  const precio = Number($('prod-precio').value || 0);
  const diff = precio - costo;
  const pct = precio > 0 ? (diff / precio) * 100 : 0;

  const box = $('preview-ganancia-prod');
  box.classList.toggle('negativa', diff < 0);
  box.innerHTML = `Ganancia por unidad: <strong>${money(diff)} (${pct.toFixed(1)}%)</strong>`;
}

function abrirModalProducto(productoId = null, codigoPrellenado = '') {
  renderGestion();
  $('form-producto').reset();

  if (productoId) {
    const p = state.productos.find((x) => x.id === productoId);
    if (!p) return;
    $('titulo-modal-producto').textContent = 'Editar producto';
    $('prod-id').value = p.id;
    $('prod-codigo').value = p.codigo || '';
    $('prod-nombre').value = p.nombre;
    $('prod-categoria').value = p.categoria_id || '';
    $('prod-costo').value = p.precio_costo ?? 0;
    $('prod-precio').value = p.precio_venta ?? 0;
    $('prod-stock').value = p.stock_actual ?? 0;
    $('prod-stock-min').value = p.stock_minimo ?? 5;
    $('prod-precio-super').value = p.precio_super || '';
    $('btn-eliminar-producto').classList.remove('oculto');
  } else {
    $('titulo-modal-producto').textContent = 'Registrar producto y precio';
    $('prod-id').value = '';
    $('prod-codigo').value = codigoPrellenado || '';
    $('prod-stock').value = '10';
    $('prod-stock-min').value = '5';
    $('btn-eliminar-producto').classList.add('oculto');
  }

  actualizarPreviewGananciaProducto();
  $('modal-producto').classList.remove('oculto');

  if (codigoPrellenado) {
    $('prod-nombre').focus();
  }
}

function cerrarModalProducto() {
  $('modal-producto').classList.add('oculto');
}

async function guardarProducto(e) {
  e.preventDefault();

  const id = $('prod-id').value;
  const codigo = $('prod-codigo').value.trim();
  const nombre = $('prod-nombre').value.trim();
  const categoria_id = $('prod-categoria').value;
  const precio_costo = Number($('prod-costo').value || 0);
  const precio_venta = Number($('prod-precio').value || 0);
  const stock_actual = Number($('prod-stock').value || 0);
  const stock_minimo = Number($('prod-stock-min').value || 5);
  const precio_super = $('prod-precio-super').value ? Number($('prod-precio-super').value) : 0;

  if (!nombre) {
    showToast('Escribe el nombre del producto', 'warning');
    return;
  }

  // Evitar códigos de barras duplicados
  if (codigo) {
    const duplicado = state.productos.find((p) => p.codigo === codigo && p.id !== id);
    if (duplicado) {
      showToast(`Ese código ya pertenece a "${duplicado.nombre}"`, 'error');
      return;
    }
  }

  const productoObj = {
    id: id || generarId('prod'),
    codigo,
    nombre,
    categoria_id,
    precio_costo,
    precio_venta,
    precio_super,
    stock_actual,
    stock_minimo,
    activo: true,
    actualizado_en: new Date().toISOString()
  };

  try {
    await idbPut('productos', productoObj);
    if (id) {
      state.productos = state.productos.map((p) => (p.id === id ? productoObj : p));
      showToast('Producto actualizado', 'success');
    } else {
      state.productos.push(productoObj);
      showToast(`Guardado: ${nombre} (${money(precio_venta)})`, 'success');
    }
    state.productos.sort((a, b) => a.nombre.localeCompare(b.nombre));

    // Si venía de un código recién escaneado en venta, refrescar visor
    if (codigo && state.ultimoCodigoNoEncontrado === codigo) {
      mostrarEnVisorEscaneo(productoObj);
    }

    cerrarModalProducto();
    renderTodo();
  } catch (err) {
    showToast(`Error al guardar: ${err.message}`, 'error');
  }
}

async function eliminarProducto() {
  const id = $('prod-id').value;
  if (!id) return;
  if (!confirm('¿Eliminar este producto del catálogo?')) return;

  try {
    await idbDelete('productos', id);
    state.productos = state.productos.filter((p) => p.id !== id);
    state.carrito = state.carrito.filter((i) => i.producto_id !== id);
    cerrarModalProducto();
    renderTodo();
    showToast('Producto eliminado', 'success');
  } catch (err) {
    showToast(`Error al eliminar: ${err.message}`, 'error');
  }
}

/* ---------------- DETALLE Y ANULACIÓN DE FACTURA ---------------- */
function abrirDetalleVenta(ventaId) {
  const venta = state.ventas.find((v) => v.id === ventaId);
  if (!venta) return;

  state.ventaDetalleId = ventaId;
  $('fecha-detalle-venta').textContent = fechaHoraCorta(venta.creada_en);
  $('detalle-venta-costo').textContent = money(venta.costo_total || 0);
  $('detalle-venta-ganancia').textContent = money(
    venta.ganancia_total ?? Number(venta.total || 0) - Number(venta.costo_total || 0)
  );
  $('total-detalle-venta').textContent = money(venta.total || 0);

  const items = venta.items || [];
  $('lista-items-detalle-venta').innerHTML = items.length
    ? items
        .map(
          (i) => `
          <div class="item-row">
            <div class="item-main">
              <div class="item-title">${esc(i.nombre)}</div>
              <div class="item-meta">
                <span>${fmtNum(i.cantidad)} × ${money(i.precio_unitario)}</span>
                <span>•</span>
                <span class="text-profit">Gana: ${money(i.ganancia ?? Number(i.subtotal || 0) - Number(i.costo_total || 0))}</span>
              </div>
            </div>
            <div class="item-right">
              <span class="item-amount">${money(i.subtotal)}</span>
            </div>
          </div>
        `
        )
        .join('')
    : `<div class="empty-state-sm">Sin detalle disponible.</div>`;

  $('modal-detalle-venta').classList.remove('oculto');
}

async function anularVentaActual() {
  const venta = state.ventas.find((v) => v.id === state.ventaDetalleId);
  if (!venta) return;
  if (!confirm('¿Anular esta factura y devolver los productos al stock?')) return;

  const ahora = new Date().toISOString();
  try {
    for (const it of venta.items || []) {
      const prod = state.productos.find((p) => p.id === it.producto_id);
      if (prod) {
        prod.stock_actual = Number((Number(prod.stock_actual || 0) + Number(it.cantidad || 0)).toFixed(2));
        prod.actualizado_en = ahora;
        await idbPut('productos', prod);
      }

      const mov = {
        id: generarId('mov'),
        producto_id: it.producto_id,
        nombre_producto: it.nombre,
        tipo: 'ajuste',
        cantidad: Math.abs(Number(it.cantidad || 0)),
        nota: `Anulación factura ${venta.id.slice(-6)}`,
        creada_en: ahora
      };
      await idbPut('movimientos', mov);
      state.movimientos.unshift(mov);
    }

    await idbDelete('ventas', venta.id);
    state.ventas = state.ventas.filter((v) => v.id !== venta.id);
    $('modal-detalle-venta').classList.add('oculto');
    state.ventaDetalleId = null;
    renderTodo();
    showToast('Factura anulada y stock restaurado', 'success');
  } catch (err) {
    showToast(`Error al anular: ${err.message}`, 'error');
  }
}

/* ---------------- MOVIMIENTOS, CATEGORÍAS, AJUSTES Y RESPALDO ---------------- */
async function guardarMovimiento(e) {
  e.preventDefault();

  const productoId = $('select-prod-movimiento').value;
  const tipo = $('select-tipo-movimiento').value;
  const cantidad = Number($('input-cant-movimiento').value);
  const nota = $('input-nota-movimiento').value.trim();

  if (!productoId || isNaN(cantidad) || cantidad === 0) {
    showToast('Selecciona un producto y cantidad válida', 'error');
    return;
  }
  if (tipo === 'entrada' && cantidad < 0) {
    showToast('Una entrada de compra debe ser positiva', 'warning');
    return;
  }

  const prod = state.productos.find((p) => p.id === productoId);
  if (!prod) return;

  const ahora = new Date().toISOString();
  prod.stock_actual = Math.max(0, Number((Number(prod.stock_actual || 0) + cantidad).toFixed(2)));
  prod.actualizado_en = ahora;

  const mov = {
    id: generarId('mov'),
    producto_id: prod.id,
    nombre_producto: prod.nombre,
    tipo,
    cantidad,
    nota: nota || (tipo === 'entrada' ? 'Compra / entrada de stock' : 'Ajuste manual'),
    creada_en: ahora
  };

  try {
    await idbPut('productos', prod);
    await idbPut('movimientos', mov);
    state.movimientos.unshift(mov);
    $('form-movimiento').reset();
    renderTodo();
    showToast(`Stock de ${prod.nombre}: ${fmtNum(prod.stock_actual)}`, 'success');
  } catch (err) {
    showToast(`Error al registrar movimiento: ${err.message}`, 'error');
  }
}

async function agregarCategoria(nombreRaw) {
  const nombre = String(nombreRaw || '').trim();
  if (!nombre) return null;

  const existe = state.categorias.find((c) => c.nombre.toLowerCase() === nombre.toLowerCase());
  if (existe) {
    showToast('Esa categoría ya existe', 'warning');
    return existe;
  }

  const nueva = { id: generarId('cat'), nombre };
  await idbPut('categorias', nueva);
  state.categorias.push(nueva);
  state.categorias.sort((a, b) => a.nombre.localeCompare(b.nombre));
  renderTodo();
  showToast(`Categoría "${nombre}" agregada`, 'success');
  return nueva;
}

async function eliminarCategoria(catId, nombre) {
  if (!confirm(`¿Eliminar la categoría "${nombre}"?`)) return;
  await idbDelete('categorias', catId);
  state.categorias = state.categorias.filter((c) => c.id !== catId);
  if (state.categoriaPos === catId) state.categoriaPos = 'todas';
  if (state.categoriaCatalogo === catId) state.categoriaCatalogo = 'todas';
  if (state.categoriaResumen === catId) state.categoriaResumen = 'todas';
  renderTodo();
  showToast(`Categoría "${nombre}" eliminada`, 'success');
}

async function guardarAjustes() {
  state.ajustes = {
    clave: 'config_general',
    nombre_negocio: $('input-nombre-negocio').value.trim() || 'ScanCaja POS',
    moneda: $('select-moneda').value || 'C$'
  };
  await idbPut('ajustes', state.ajustes);
  aplicarAjustesUI();
  renderTodo();
  showToast('Ajustes guardados', 'success');
}

function exportarRespaldoJSON() {
  const payload = {
    app: 'ScanCajaPOS',
    version: 1,
    exportado_en: new Date().toISOString(),
    ajustes: state.ajustes,
    categorias: state.categorias,
    productos: state.productos,
    ventas: state.ventas,
    movimientos: state.movimientos
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fecha = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `respaldo-scancaja-${fecha}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Copia de seguridad descargada', 'success');
}

async function importarRespaldoJSON(archivo) {
  if (!archivo) return;
  if (!confirm('¿Restaurar esta copia? Se reemplazarán los datos actuales del teléfono.')) return;

  try {
    const texto = await archivo.text();
    const data = JSON.parse(texto);
    if (!Array.isArray(data.productos) || !Array.isArray(data.ventas)) {
      throw new Error('Archivo de respaldo no válido');
    }

    await Promise.all([
      idbClear('categorias'),
      idbClear('productos'),
      idbClear('ventas'),
      idbClear('movimientos'),
      idbClear('ajustes')
    ]);

    for (const c of data.categorias || CATEGORIAS_INICIALES) await idbPut('categorias', c);
    for (const p of data.productos || []) await idbPut('productos', p);
    for (const v of data.ventas || []) await idbPut('ventas', v);
    for (const m of data.movimientos || []) await idbPut('movimientos', m);
    if (data.ajustes) await idbPut('ajustes', { ...data.ajustes, clave: 'config_general' });

    await cargarBaseLocal();
    showToast('Respaldo restaurado correctamente', 'success');
  } catch (err) {
    showToast(`No se pudo restaurar: ${err.message}`, 'error');
  } finally {
    $('input-importar-respaldo').value = '';
  }
}

/* ---------------- COPIAR REPORTE FINANCIERO DEL DÍA ---------------- */
async function copiarReporteDelDia() {
  const ventasFiltradas = obtenerVentasFiltradas();
  if (!ventasFiltradas.length) {
    showToast('No hay ventas en este período para reportar', 'warning');
    return;
  }

  const totalVentas = ventasFiltradas.reduce((s, v) => s + Number(v.total || 0), 0);
  const totalInvertido = ventasFiltradas.reduce((s, v) => s + Number(v.costo_total || 0), 0);
  const totalGanancia = totalVentas - totalInvertido;
  const { lista } = calcularResumenProductos(ventasFiltradas);

  const fecha = new Date().toLocaleDateString('es-NI', {
    weekday: 'long',
    day: '2-digit',
    month: 'long'
  });

  const lineas = [
    `*CIERRE FINANCIERO — ${(state.ajustes.nombre_negocio || 'SCANCAJA POS').toUpperCase()}*`,
    `Fecha: ${fecha} (${etiquetaPeriodo()})`,
    `Total vendido: *${money(totalVentas)}* (${ventasFiltradas.length} ventas)`,
    `Total invertido (costo): ${money(totalInvertido)}`,
    `Ganancia neta: *${money(totalGanancia)}*`,
    ``,
    `*Detalle por producto:*`,
    ...lista.map(
      (r) =>
        `• ${r.nombre}: ${fmtNum(r.vendido)} und | Venta: ${money(r.dinero)} | Gana: ${money(r.ganancia)}`
    )
  ];

  const texto = lineas.join('\n');
  try {
    await navigator.clipboard.writeText(texto);
    showToast('Cierre copiado. Listo para pegar en WhatsApp', 'success');
  } catch {
    prompt('Copia el reporte:', texto);
  }
}

/* ---------------- ESCÁNER DE CÓDIGOS DE BARRAS (CÁMARA) ---------------- */
function mostrarFeedbackModal(texto, tipo = 'ok') {
  const el = $('banner-escaneo-modal');
  el.textContent = texto;
  el.className = `scan-feedback ${tipo === 'warn' ? 'warn' : tipo === 'err' ? 'err' : ''}`;
  el.classList.remove('oculto');
}

async function abrirEscaner(modo = 'venta') {
  state.scanner.modo = modo;
  state.scanner.linternaActiva = false;
  state.scanner.ultimoCodigoLeido = '';
  state.scanner.ultimaLecturaTs = 0;

  $('titulo-modal-escaner').textContent =
    modo === 'venta' ? 'Escanear para vender' : 'Escanear código de barras';
  $('subtitulo-modal-escaner').textContent =
    modo === 'venta'
      ? 'Cada producto escaneado se suma al ticket'
      : 'Escanea el empaque para asignarle precio';

  $('banner-escaneo-modal').classList.add('oculto');
  $('input-escaner-manual').value = '';
  $('estado-escaner').textContent = 'Iniciando cámara...';
  $('modal-escaner').classList.remove('oculto');

  await iniciarCamaraEscaner();
}

async function iniciarCamaraEscaner() {
  if (typeof window.Html5Qrcode === 'undefined') {
    $('estado-escaner').textContent = 'Librería de escáner no cargada. Usa el ingreso manual abajo.';
    mostrarFeedbackModal('Sin librería de cámara disponible (revisa conexión o empaqueta html5-qrcode local).', 'err');
    return;
  }

  await detenerCamaraEscaner();

  try {
    const formats = window.Html5QrcodeSupportedFormats
      ? [
          window.Html5QrcodeSupportedFormats.EAN_13,
          window.Html5QrcodeSupportedFormats.EAN_8,
          window.Html5QrcodeSupportedFormats.UPC_A,
          window.Html5QrcodeSupportedFormats.UPC_E,
          window.Html5QrcodeSupportedFormats.CODE_128,
          window.Html5QrcodeSupportedFormats.CODE_39,
          window.Html5QrcodeSupportedFormats.QR_CODE
        ]
      : undefined;

    const qr = new window.Html5Qrcode('lector-camara', formats ? { formatsToSupport: formats } : undefined);
    state.scanner.instancia = qr;

    const config = {
      fps: 12,
      qrbox: { width: 250, height: 130 },
      aspectRatio: 1.333
    };

    const facingMode = state.scanner.camaraTrasera ? 'environment' : 'user';
    await qr.start({ facingMode }, config, onCodigoDetectado, () => {});

    state.scanner.activo = true;
    $('estado-escaner').textContent = 'Cámara activa • Apunta al código de barras';
  } catch (err) {
    state.scanner.activo = false;
    $('estado-escaner').textContent = 'No se pudo iniciar la cámara';
    mostrarFeedbackModal(
      'Permiso de cámara bloqueado o contexto no seguro. En APK con Capacitor concede el permiso de Cámara, o usa el campo manual abajo.',
      'err'
    );
    console.warn('Error iniciando cámara:', err);
  }
}

async function detenerCamaraEscaner() {
  if (state.scanner.instancia && state.scanner.activo) {
    try {
      await state.scanner.instancia.stop();
      await state.scanner.instancia.clear();
    } catch {
      // Ignorar si ya estaba detenido
    }
  }
  state.scanner.instancia = null;
  state.scanner.activo = false;
  state.scanner.linternaActiva = false;
}

async function cerrarEscaner() {
  await detenerCamaraEscaner();
  $('modal-escaner').classList.add('oculto');
}

function onCodigoDetectado(textoCodigo) {
  const codigo = String(textoCodigo || '').trim();
  const ahora = Date.now();

  // Pausa de 1.4s para evitar doble lectura accidental del mismo código
  if (codigo === state.scanner.ultimoCodigoLeido && ahora - state.scanner.ultimaLecturaTs < 1400) {
    return;
  }

  state.scanner.ultimoCodigoLeido = codigo;
  state.scanner.ultimaLecturaTs = ahora;

  manejarCodigoEscaneado(codigo);
}

async function manejarCodigoEscaneado(codigo) {
  const modo = state.scanner.modo;

  if (modo === 'venta') {
    procesarCodigoEnVenta(codigo, true);
    return;
  }

  tocarBeep('ok');
  await cerrarEscaner();

  if (modo === 'campo-codigo') {
    $('prod-codigo').value = codigo;
    $('prod-nombre').focus();
    showToast(`Código capturado: ${codigo}`, 'success');
    return;
  }

  // modo === 'registro'
  const existente = buscarProductoPorCodigo(codigo);
  if (existente) {
    showToast(`Editando producto existente: ${existente.nombre}`, 'info');
    abrirModalProducto(existente.id);
  } else {
    abrirModalProducto(null, codigo);
  }
}

async function toggleLinterna() {
  if (!state.scanner.instancia || !state.scanner.activo) {
    showToast('La cámara no está activa', 'warning');
    return;
  }
  try {
    const nuevoEstado = !state.scanner.linternaActiva;
    await state.scanner.instancia.applyVideoConstraints({
      advanced: [{ torch: nuevoEstado }]
    });
    state.scanner.linternaActiva = nuevoEstado;
    showToast(nuevoEstado ? 'Linterna encendida' : 'Linterna apagada', 'info');
  } catch {
    showToast('Tu cámara no permite controlar la linterna desde aquí', 'warning');
  }
}

async function cambiarCamara() {
  state.scanner.camaraTrasera = !state.scanner.camaraTrasera;
  await iniciarCamaraEscaner();
}

/* ---------------- EVENTOS E INICIO ---------------- */
function bindEventos() {
  // Navegación inferior
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => cambiarVista(btn.dataset.vista));
  });

  // Accesos a cámara
  $('btn-abrir-escaner-rapido').addEventListener('click', () => abrirEscaner('venta'));
  $('btn-escanear-venta').addEventListener('click', () => abrirEscaner('venta'));
  $('btn-escanear-nuevo-prod').addEventListener('click', () => abrirEscaner('registro'));
  $('btn-escanear-campo-codigo').addEventListener('click', () => abrirEscaner('campo-codigo'));
  $('btn-cerrar-escaner').addEventListener('click', cerrarEscaner);
  $('btn-toggle-linterna').addEventListener('click', toggleLinterna);
  $('btn-cambiar-camara').addEventListener('click', cambiarCamara);

  $('btn-enviar-escaner-manual').addEventListener('click', () => {
    const val = $('input-escaner-manual').value.trim();
    if (!val) return;
    $('input-escaner-manual').value = '';
    manejarCodigoEscaneado(val);
  });

  // Código manual en vista Vender
  const dispararManualVenta = () => {
    const val = $('input-codigo-manual').value.trim();
    if (!val) return;
    $('input-codigo-manual').value = '';
    procesarCodigoEnVenta(val, false);
  };
  $('btn-buscar-codigo-manual').addEventListener('click', dispararManualVenta);
  $('input-codigo-manual').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dispararManualVenta();
    }
  });

  $('btn-registrar-codigo-nuevo').addEventListener('click', () => {
    abrirModalProducto(null, state.ultimoCodigoNoEncontrado);
  });

  // Buscadores y chips
  $('input-buscar-pos').addEventListener('input', (e) => {
    state.busquedaPos = e.target.value;
    renderGridPOS();
  });
  $('input-buscar-catalogo').addEventListener('input', (e) => {
    state.busquedaCatalogo = e.target.value;
    renderCatalogo();
  });

  $('chips-categorias-pos').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat-pos]');
    if (!chip) return;
    state.categoriaPos = chip.dataset.catPos;
    renderChipsTodasLasVistas();
    renderGridPOS();
  });

  $('chips-categorias-catalogo').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat-catalogo]');
    if (!chip) return;
    state.categoriaCatalogo = chip.dataset.catCatalogo;
    renderChipsTodasLasVistas();
    renderCatalogo();
  });

  $('chips-periodo-resumen').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-periodo]');
    if (!chip) return;
    state.periodoActivo = chip.dataset.periodo;
    renderResumen();
  });

  $('chips-categorias-resumen').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat-resumen]');
    if (!chip) return;
    state.categoriaResumen = chip.dataset.catResumen;
    renderChipsTodasLasVistas();
    renderResumen();
  });

  // Cuadrícula POS
  $('grid-productos-pos').addEventListener('click', (e) => {
    const card = e.target.closest('.prod-card');
    if (!card) return;
    const prod = state.productos.find((p) => p.id === card.dataset.prodId);
    if (prod) {
      agregarAlCarrito(prod.id);
      mostrarEnVisorEscaneo(prod);
    }
  });

  // Carrito
  $('btn-abrir-carrito').addEventListener('click', abrirModalCarrito);
  $('btn-cerrar-carrito').addEventListener('click', cerrarModalCarrito);
  $('btn-vaciar-carrito').addEventListener('click', () => {
    state.carrito = [];
    cerrarModalCarrito();
    renderGridPOS();
    actualizarBarraCarrito();
  });
  $('input-pago-con').addEventListener('input', actualizarVuelto);
  $('btn-confirmar-venta').addEventListener('click', confirmarVenta);

  $('lista-items-carrito').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const item = state.carrito.find((i) => i.producto_id === id);
    if (!item) return;

    if (action === 'plus') {
      item.cantidad = Number((Number(item.cantidad) + 1).toFixed(2));
    } else if (action === 'minus') {
      item.cantidad = Number((Number(item.cantidad) - 1).toFixed(2));
      if (item.cantidad <= 0) {
        state.carrito = state.carrito.filter((i) => i.producto_id !== id);
      }
    } else if (action === 'manual-qty') {
      abrirModalCantidad(id);
      return;
    }

    renderModalCarrito();
    renderGridPOS();
    actualizarBarraCarrito();
  });

  // Modal Cantidad
  $('btn-cerrar-modal-cantidad').addEventListener('click', cerrarModalCantidad);
  $('btn-cancelar-cantidad').addEventListener('click', cerrarModalCantidad);
  $('btn-aplicar-cantidad').addEventListener('click', () => aplicarCantidadManual());
  $('grid-presets-cantidad').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset-val]');
    if (!btn) return;
    aplicarCantidadManual(btn.dataset.presetVal);
  });

  // Modal Producto
  $('btn-nuevo-producto').addEventListener('click', () => abrirModalProducto(null));
  $('btn-cerrar-modal-producto').addEventListener('click', cerrarModalProducto);
  $('form-producto').addEventListener('submit', guardarProducto);
  $('btn-eliminar-producto').addEventListener('click', eliminarProducto);
  $('btn-generar-codigo').addEventListener('click', () => {
    $('prod-codigo').value = generarCodigoInterno();
  });
  $('prod-costo').addEventListener('input', actualizarPreviewGananciaProducto);
  $('prod-precio').addEventListener('input', actualizarPreviewGananciaProducto);

  $('prod-categoria').addEventListener('change', async (e) => {
    if (e.target.value !== '__nueva__') return;
    const nombre = prompt('Nombre de la nueva categoría:');
    if (!nombre || !nombre.trim()) {
      e.target.value = '';
      return;
    }
    const creada = await agregarCategoria(nombre);
    if (creada) $('prod-categoria').value = creada.id;
  });

  $('lista-productos-catalogo').addEventListener('click', (e) => {
    const row = e.target.closest('[data-edit-prod]');
    if (row) abrirModalProducto(row.dataset.editProd);
  });
  $('lista-stock-bajo').addEventListener('click', (e) => {
    const row = e.target.closest('[data-edit-prod]');
    if (row) abrirModalProducto(row.dataset.editProd);
  });

  // Detalle factura
  $('lista-facturas').addEventListener('click', (e) => {
    const row = e.target.closest('[data-venta-id]');
    if (row) abrirDetalleVenta(row.dataset.ventaId);
  });
  $('btn-cerrar-detalle-venta').addEventListener('click', () =>
    $('modal-detalle-venta').classList.add('oculto')
  );
  $('btn-anular-venta').addEventListener('click', anularVentaActual);

  // Gestión, categorías, reportes y respaldo
  $('form-movimiento').addEventListener('submit', guardarMovimiento);
  $('form-nueva-categoria').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = $('input-nueva-categoria').value.trim();
    if (!val) return;
    await agregarCategoria(val);
    $('input-nueva-categoria').value = '';
  });
  $('lista-categorias-config').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del-cat]');
    if (!btn) return;
    eliminarCategoria(btn.dataset.delCat, btn.dataset.catNombre);
  });

  $('btn-guardar-ajustes').addEventListener('click', guardarAjustes);
  $('btn-copiar-cierre').addEventListener('click', copiarReporteDelDia);
  $('btn-exportar-respaldo').addEventListener('click', exportarRespaldoJSON);
  $('btn-importar-respaldo').addEventListener('click', () => $('input-importar-respaldo').click());
  $('input-importar-respaldo').addEventListener('change', (e) => {
    importarRespaldoJSON(e.target.files[0]);
  });
}

async function initApp() {
  $('fecha-hoy-header').textContent = new Date().toLocaleDateString('es-NI', {
    weekday: 'short',
    day: '2-digit',
    month: 'short'
  });

  bindEventos();
  await cargarBaseLocal();
}

document.addEventListener('DOMContentLoaded', initApp);