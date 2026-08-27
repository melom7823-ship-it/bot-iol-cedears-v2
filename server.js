import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;

const distPath = path.join(__dirname, 'dist');
const indexPath = path.join(__dirname, 'dist', 'index.html');
console.log(`[INIT] dist/index.html exists = ${fs.existsSync(indexPath)}`);
console.log(`[INIT] dist exists = ${fs.existsSync(distPath)}`);

// ============================================================
// BOT IOL CEDEARs v2 — VARIABLES GLOBALES
// ============================================================
let iolBot = null;
let iolBotTimer = null;
let iolBearerToken = null;
let iolTokenExpiry = 0;
const cedearHistory = {}; // historial de valores USD implícitos por ticker

// ============================================================
// CONFIGURACIÓN v2 — ESTRATEGIA MEJORADA
// Aprendizajes del bot de Binance:
//   - TP y SL tienen que tener relación 2:1 a favor
//   - Las comisiones (IOL ~0.6% por lado = 1.2% round-trip) se deben cubrir con creces
//   - Historial corto da señales falsas → usar 20 puntos mínimo
//   - Ciclos muy lentos pierden oportunidades → cada 5 minutos
// ============================================================
const CFG = {
  CICLO_MS:        5 * 60 * 1000,  // Cada 5 minutos
  HISTORIAL_MIN:   20,              // Mínimo de puntos para señal confiable
  HISTORIAL_MAX:   48,              // Máximo de puntos guardados (~4 horas de datos)
  SEÑAL_COMPRA:    2.0,             // Descuento mínimo real para comprar (%)
  TAKE_PROFIT:     3.5,             // Take Profit: +3.5% sobre precio de compra
  STOP_LOSS:       1.5,             // Stop Loss:   -1.5% sobre precio de compra
  COMISION_IOL:    0.6,             // Comisión IOL por operación (%)
  MAX_TIEMPO_POS:  3 * 60 * 60000, // Tiempo máximo en posición: 3 horas
};

// ============================================================
// CEDEARs MONITOREADOS (8 activos — el doble que antes)
// QQQ SIEMPRE EXCLUIDO — protección de inversión personal
// ============================================================
const CEDEARS = [
  { ticker: 'AAPL',  nombre: 'Apple',     emoji: '🍎' },
  { ticker: 'MSFT',  nombre: 'Microsoft', emoji: '🪟' },
  { ticker: 'AMZN',  nombre: 'Amazon',    emoji: '📦' },
  { ticker: 'NVDA',  nombre: 'NVIDIA',    emoji: '🎮' },
  { ticker: 'GOOGL', nombre: 'Google',    emoji: '🔍' },
  { ticker: 'META',  nombre: 'Meta',      emoji: '👤' },
  { ticker: 'TSLA',  nombre: 'Tesla',     emoji: '⚡' },
  { ticker: 'JPM',   nombre: 'JPMorgan',  emoji: '🏦' },
];

// ============================================================
// HELPERS — HTTP/HTTPS
// ============================================================
function httpsGet(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ============================================================
// IOL — AUTENTICACIÓN (TOKEN BEARER)
// Aprendizaje: reusar token si sigue vigente para no saturar la API
// ============================================================
function getIolToken(username, password) {
  if (iolBearerToken && Date.now() < iolTokenExpiry) {
    return Promise.resolve(iolBearerToken);
  }
  return new Promise((resolve) => {
    const body = new URLSearchParams({ grant_type: 'password', username, password }).toString();
    const options = {
      hostname: 'api.invertironline.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            iolBearerToken = parsed.access_token;
            iolTokenExpiry = Date.now() + ((parsed.expires_in || 3600) * 1000 * 0.9);
            console.log(`[IOL TOKEN ✅] Autenticado. Válido ~${Math.floor((parsed.expires_in || 3600) * 0.9 / 60)} min.`);
            resolve(iolBearerToken);
          } else {
            console.log(`[IOL TOKEN ❌] ${data}`);
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.log(`[IOL TOKEN ❌] ${e.message}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// IOL — COTIZACIÓN DE UN CEDEAR
// ============================================================
function getIolCotizacion(token, ticker) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.invertironline.com',
      path: `/api/v2/bCBA/Titulos/${ticker}/Cotizacion`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ============================================================
// IOL — DÓLAR MEP (con 2 fuentes de fallback)
// ============================================================
async function getMepRate() {
  const d1 = await httpsGet('https://dolarapi.com/v1/dolares/bolsa');
  if (d1 && d1.venta) return parseFloat(d1.venta);
  const d2 = await httpsGet('https://api.bluelytics.com.ar/v2/latest');
  if (d2 && d2.blue) return parseFloat(d2.blue.value_sell);
  return null;
}

// ============================================================
// IOL — HORARIO BYMA: Lunes a Viernes 11:00 a 17:00 hs (Buenos Aires = UTC-3)
// Nota: Pusimos 10:30 porque el pre-market arranca ahí, pero IOL suele dar cotizaciones reales a las 11:00
function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 810 && mins < 1200; // 13:30-20:00 UTC = 10:30-17:00 BA
}

// ============================================================
// IOL — ENVIAR ORDEN (COMPRA O VENTA)
// Precio límite 0.5% arriba en compra / abajo en venta para
// asegurar ejecución inmediata sin pagar de más
// ============================================================
function sendIolOrder(token, ticker, cantidad, precio, tipo) {
  return new Promise((resolve) => {
    const precioLimite = tipo === 'comprar'
      ? parseFloat((precio * 1.005).toFixed(2))
      : parseFloat((precio * 0.995).toFixed(2));

    const payload = JSON.stringify({
      mercado: 'bCBA',
      simbolo: ticker.toUpperCase(),
      cantidad: Number(cantidad),
      precio: precioLimite,
      plazo: 't0',
      validez: new Date(Date.now() + 86400000).toISOString()
    });

    const endpoint = tipo === 'comprar' ? 'Comprar' : 'Vender';
    const options = {
      hostname: 'api.invertironline.com',
      path: `/api/v2/operar/${endpoint}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve({ success: true, orderId: p.numeroOperacion || p.id || 'OK' });
          } else {
            resolve({ success: false, error: p.mensaje || p.message || `HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
        }
      });
    });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

// ============================================================
// MOTOR IOL v2 — ESTRATEGIA MEJORADA
//
// DIFERENCIAS VS v1:
//   v1: ciclo 30min | historial 4pts | TP +2% | SL -2% | 4 CEDEARs
//   v2: ciclo  5min | historial 20pts | TP +3.5% | SL -1.5% | 8 CEDEARs
//
// LÓGICA:
//   1. Cada 5 min durante horario BYMA: obtener precio de 8 CEDEARs
//   2. Calcular valor USD implícito (precio ARS / MEP)
//   3. Comparar vs promedio de los últimos 20 valores
//   4. Si descuento ≥ 2.0% → COMPRAR el más barato
//   5. Monitorear: vender al +3.5% (TP) o -1.5% (SL)
//   6. Si lleva más de 3 horas, vender igual para no quedar trabado
// ============================================================
function startIolBotV2(username, password, capitalArs) {
  if (iolBotTimer) { clearInterval(iolBotTimer); iolBotTimer = null; }

  // Ganancia neta real por trade:
  //   WIN:  +3.5% - 1.2% comisiones = +2.3% neto
  //   LOSS: -1.5% - 1.2% comisiones = -2.7% neto
  // Con 60% win rate: 6×(+2.3%) + 4×(-2.7%) = +13.8% - 10.8% = +3.0% por ronda
  const gananciaEstimadaDia = capitalArs * 0.012; // ~1.2% diario conservador
  const gananciaEstimadaMes = gananciaEstimadaDia * 22; // ~22 días hábiles

  iolBot = {
    username: username.trim(),
    password: password.trim(),
    capitalArs: Number(capitalArs) || 200000,
    estado: 'DISPONIBLE',  // DISPONIBLE | INVERTIDO
    ticker: null,
    qty: 0,
    buyPriceArs: null,
    buyTimestamp: null,
    tpPct: 3.5, // Por defecto +3.5% (se ajusta dinámicamente con ATR)
    slPct: 1.5, // Por defecto -1.5% (se ajusta dinámicamente con ATR)
    atrPct: 1.5,
    totalGananciasArs: 0,
    wins: 0,
    losses: 0,
    cycles: 0,
    logs: []
  };

  const log = (msg) => {
    const ts = new Date().toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false });
    const entry = `[${ts}] ${msg}`;
    console.log(`[IOL v2] ${entry}`);
    iolBot.logs.unshift(entry);
    if (iolBot.logs.length > 30) iolBot.logs.pop();
  };

  log(`🚀 BOT IOL CEDEARS v2 INICIADO`);
  log(`💰 Capital: $${iolBot.capitalArs.toLocaleString('es-AR')} ARS`);
  log(`📈 Estrategia: TP +3.5% | SL -1.5% | Señal mínima: -2.0% | Ciclo: 5 min`);
  log(`🔍 Monitoreando: ${CEDEARS.map(c => c.ticker).join(', ')} (QQQ: 🔒 BLOQUEADO)`);
  log(`📊 Proyección estimada: $${Math.round(gananciaEstimadaDia).toLocaleString('es-AR')} ARS/día | $${Math.round(gananciaEstimadaMes).toLocaleString('es-AR')} ARS/mes`);

  const ciclo = async () => {
    if (!iolBot) return;
    iolBot.cycles++;

    if (!isMarketOpen()) {
      log(`⏰ Mercado BYMA cerrado. Opera Lun-Vie 10:30-17:00 hs. Ciclo #${iolBot.cycles}.`);
      return;
    }

    const token = await getIolToken(iolBot.username, iolBot.password);
    if (!token) {
      log(`❌ Error de autenticación con IOL. Verificá usuario y contraseña.`);
      return;
    }

    const mep = await getMepRate();
    if (!mep) {
      log(`❌ No se pudo obtener el dólar MEP. Reintentando próximo ciclo.`);
      return;
    }
    log(`💱 Dólar MEP: $${mep.toFixed(2)} ARS | Ciclo #${iolBot.cycles}`);

    // ── FASE DE VENTA (si estamos invertidos) ──────────────
    if (iolBot.estado === 'INVERTIDO') {
      const cotiz = await getIolCotizacion(token, iolBot.ticker);
      if (!cotiz || !cotiz.ultimoPrecio) {
        log(`⚠️ No se pudo obtener cotización de ${iolBot.ticker}.`);
        return;
      }
      const precioActual = parseFloat(cotiz.ultimoPrecio);
      const varPct = ((precioActual - iolBot.buyPriceArs) / iolBot.buyPriceArs) * 100;
      const tiempoEnPos = Date.now() - iolBot.buyTimestamp;
      const timeout = tiempoEnPos >= CFG.MAX_TIEMPO_POS;
      const takeProfit = varPct >= iolBot.tpPct;
      const stopLoss = varPct <= -iolBot.slPct;

      const horasPos = (tiempoEnPos / 3600000).toFixed(1);
      log(`📊 ${iolBot.ticker}: Comprado $${iolBot.buyPriceArs.toFixed(2)} → Actual $${precioActual.toFixed(2)} | Var: ${varPct >= 0 ? '+' : ''}${varPct.toFixed(2)}% | TP Adaptativo: +${iolBot.tpPct.toFixed(2)}% | SL Adaptativo: -${iolBot.slPct.toFixed(2)}% | En posición: ${horasPos}h`);

      let razon = null;
      if (takeProfit) razon = `✅ TAKE PROFIT +${iolBot.tpPct.toFixed(2)}%`;
      else if (stopLoss) razon = `🔴 STOP LOSS -${iolBot.slPct.toFixed(2)}%`;
      else if (timeout) razon = '⏱️ TIMEOUT 3 HORAS — Venta preventiva';

      if (razon) {
        log(`${razon} — Vendiendo ${iolBot.qty} CEDEARs de ${iolBot.ticker}...`);
        const resultado = await sendIolOrder(token, iolBot.ticker, iolBot.qty, precioActual, 'vender');
        if (resultado.success) {
          const gananciaBruta = (precioActual - iolBot.buyPriceArs) * iolBot.qty;
          const comisiones = (precioActual * iolBot.qty * CFG.COMISION_IOL / 100) + (iolBot.buyPriceArs * iolBot.qty * CFG.COMISION_IOL / 100);
          const gananciaNeta = gananciaBruta - comisiones;
          iolBot.totalGananciasArs += gananciaNeta;
          if (takeProfit) iolBot.wins++;
          else iolBot.losses++;
          log(`💵 Orden #${resultado.orderId} | Ganancia neta: ${gananciaNeta >= 0 ? '+' : ''}$${Math.round(gananciaNeta).toLocaleString('es-AR')} ARS`);
          log(`📈 TOTAL ACUMULADO: $${Math.round(iolBot.totalGananciasArs).toLocaleString('es-AR')} ARS | Wins: ${iolBot.wins} | Losses: ${iolBot.losses}`);
          iolBot.estado = 'DISPONIBLE';
          iolBot.ticker = null;
          iolBot.qty = 0;
          iolBot.buyPriceArs = null;
          iolBot.buyTimestamp = null;
        } else {
          log(`❌ VENTA FALLIDA: ${resultado.error}`);
        }
      }
      return;
    }

    // ── FASE DE BÚSQUEDA Y COMPRA ───────────────────────────
    let mejorOportunidad = null;
    let mayorDescuento = 0;

    for (const c of CEDEARS) {
      const cotiz = await getIolCotizacion(token, c.ticker);
      if (!cotiz || !cotiz.ultimoPrecio) {
        log(`⚠️ ${c.ticker}: Sin cotización.`);
        continue;
      }
      const precioArs = parseFloat(cotiz.ultimoPrecio);
      const valorUsd = precioArs / mep;

      if (!cedearHistory[c.ticker]) cedearHistory[c.ticker] = [];
      cedearHistory[c.ticker].push({ valorUsd, ts: Date.now() });
      if (cedearHistory[c.ticker].length > CFG.HISTORIAL_MAX) cedearHistory[c.ticker].shift();

      const pts = cedearHistory[c.ticker].length;
      if (pts < CFG.HISTORIAL_MIN) {
        log(`${c.emoji} ${c.ticker}: $${precioArs.toFixed(2)} ARS | Acumulando datos (${pts}/${CFG.HISTORIAL_MIN})...`);
        continue;
      }

      const promedioUsd = cedearHistory[c.ticker].reduce((a, b) => a + b.valorUsd, 0) / pts;
      const descuentoPct = ((promedioUsd - valorUsd) / promedioUsd) * 100;

      const max = parseFloat(cotiz.maximo || cotiz.ultimoPrecio);
      const min = parseFloat(cotiz.minimo || cotiz.ultimoPrecio);
      const prevClose = parseFloat(cotiz.cierreAnterior || cotiz.ultimoPrecio);
      const tr = Math.max(max - min, Math.abs(max - prevClose), Math.abs(min - prevClose));
      const atrPct = (tr / precioArs) * 100 || 1.5;

      const dynamicTpPct = Math.min(Math.max(atrPct * 1.8, 2.0), 5.0);
      const dynamicSlPct = Math.min(Math.max(atrPct * 0.9, 1.0), 2.5);

      const icon = descuentoPct >= CFG.SEÑAL_COMPRA ? '🟢' : (descuentoPct >= 1.0 ? '🟡' : '⚪');
      log(`${icon} ${c.ticker}: $${precioArs.toFixed(2)} ARS | USD: $${valorUsd.toFixed(4)} | Prom: $${promedioUsd.toFixed(4)} | ATR: ${atrPct.toFixed(2)}% | Descuento: ${descuentoPct >= 0 ? '+' : ''}${descuentoPct.toFixed(2)}%`);

      if (descuentoPct >= CFG.SEÑAL_COMPRA && descuentoPct > mayorDescuento) {
        mayorDescuento = descuentoPct;
        mejorOportunidad = { ...c, precioArs, valorUsd, promedioUsd, descuentoPct, atrPct, dynamicTpPct, dynamicSlPct };
      }
    }

    if (!mejorOportunidad) {
      log(`⏳ Sin oportunidad (mínimo ${CFG.SEÑAL_COMPRA}% descuento). Esperando próximo ciclo en 5 min.`);
      return;
    }

    const cantidad = Math.floor(iolBot.capitalArs / mejorOportunidad.precioArs);
    if (cantidad < 1) {
      log(`⚠️ Capital insuficiente para ${mejorOportunidad.ticker} ($${mejorOportunidad.precioArs.toFixed(2)} ARS/unidad).`);
      return;
    }

    log(`🟢 OPORTUNIDAD: ${mejorOportunidad.emoji} ${mejorOportunidad.ticker} con ${mejorOportunidad.descuentoPct.toFixed(2)}% de descuento real | ATR: ${mejorOportunidad.atrPct.toFixed(2)}%`);
    log(`🛒 Comprando ${cantidad} CEDEARs de ${mejorOportunidad.ticker} a $${mejorOportunidad.precioArs.toFixed(2)} ARS | Total: $${(cantidad * mejorOportunidad.precioArs).toLocaleString('es-AR')} ARS`);

    const resultado = await sendIolOrder(token, mejorOportunidad.ticker, cantidad, mejorOportunidad.precioArs, 'comprar');

    if (resultado.success) {
      iolBot.estado = 'INVERTIDO';
      iolBot.ticker = mejorOportunidad.ticker;
      iolBot.qty = cantidad;
      iolBot.buyPriceArs = mejorOportunidad.precioArs;
      iolBot.buyTimestamp = Date.now();
      iolBot.tpPct = mejorOportunidad.dynamicTpPct;
      iolBot.slPct = mejorOportunidad.dynamicSlPct;
      iolBot.atrPct = mejorOportunidad.atrPct;
      log(`✅ COMPRA CONFIRMADA | Orden #${resultado.orderId} | ${cantidad}× ${mejorOportunidad.ticker}`);
      log(`🎯 Objetivos Dinámicos ATR: TP $${(mejorOportunidad.precioArs * (1 + mejorOportunidad.dynamicTpPct / 100)).toFixed(2)} (+${mejorOportunidad.dynamicTpPct.toFixed(2)}%) | SL $${(mejorOportunidad.precioArs * (1 - mejorOportunidad.dynamicSlPct / 100)).toFixed(2)} (-${mejorOportunidad.dynamicSlPct.toFixed(2)}%) | Timeout: 3hs`);
    } else {
      log(`❌ COMPRA FALLIDA: ${resultado.error}`);
    }
  };

  // Primer ciclo inmediato
  ciclo();

  // Ciclo cada 5 minutos
  iolBotTimer = setInterval(ciclo, CFG.CICLO_MS);
}

// ============================================================
// TIPOS MIME
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// ============================================================
// SERVIDOR HTTP
// ============================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── UPTIME ROBOT: ping endpoint (aprendido del bot de Binance)
  // Registrar en https://dashboard.uptimerobot.com con este endpoint
  // para que Render no duerma el servidor por inactividad
  if (pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'alive',
      bot: iolBot ? iolBot.estado : 'APAGADO',
      ticker: iolBot?.ticker || null,
      wins: iolBot?.wins || 0,
      losses: iolBot?.losses || 0,
      gananciasArs: iolBot?.totalGananciasArs || 0,
      uptime: process.uptime(),
      ts: new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
    }));
    return;
  }

  // ── ACTIVAR BOT IOL v2
  if (pathname === '/api/iol/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { username, password, capitalArs } = JSON.parse(body || '{}');
        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Usuario y contraseña requeridos.' }));
          return;
        }
        startIolBotV2(username, password, capitalArs || 200000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '✅ Bot IOL CEDEARs v2 iniciado.' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── DETENER BOT IOL v2
  if (pathname === '/api/iol/stop' && req.method === 'POST') {
    if (iolBotTimer) { clearInterval(iolBotTimer); iolBotTimer = null; }
    iolBot = null;
    iolBearerToken = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Bot IOL detenido.' }));
    return;
  }

  // ── STATUS: logs y estado actual
  if (pathname === '/api/iol/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activo: !!iolBot,
      estado: iolBot?.estado || 'APAGADO',
      ticker: iolBot?.ticker || null,
      qty: iolBot?.qty || 0,
      buyPriceArs: iolBot?.buyPriceArs || null,
      capitalArs: iolBot?.capitalArs || 0,
      wins: iolBot?.wins || 0,
      losses: iolBot?.losses || 0,
      cycles: iolBot?.cycles || 0,
      totalGananciasArs: iolBot?.totalGananciasArs || 0,
      logs: iolBot?.logs || []
    }));
    return;
  }

  // ── SERVIR ARCHIVOS ESTÁTICOS (dist/)
  let filePath = pathname === '/' ? indexPath : path.join(distPath, pathname);
  if (!fs.existsSync(filePath)) filePath = indexPath; // SPA fallback
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`[SERVER ✅] Bot IOL CEDEARs v2 activo en puerto ${PORT}.`);
  console.log(`[SERVER 📡] Endpoint UptimeRobot: GET /ping`);
  console.log(`[SERVER 📋] Registrar en UptimeRobot: https://tu-app.onrender.com/ping`);
});
