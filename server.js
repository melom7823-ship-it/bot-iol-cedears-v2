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
// CEDEARs MONITOREADOS (25 ACTIVOS ULTRALÍQUIDOS EN BYMA)
// QQQ EXCLUIDO — protección de inversión personal
// ============================================================
const CEDEARS = [
  { ticker: 'AAPL',  nombre: 'Apple',          emoji: '🍎', sector: 'Tech' },
  { ticker: 'MSFT',  nombre: 'Microsoft',      emoji: '🪟', sector: 'Tech' },
  { ticker: 'GOOGL', nombre: 'Google',         emoji: '🔍', sector: 'Tech' },
  { ticker: 'META',  nombre: 'Meta',           emoji: '👤', sector: 'Tech' },
  { ticker: 'NVDA',  nombre: 'NVIDIA',         emoji: '🎮', sector: 'Semi' },
  { ticker: 'AMD',   nombre: 'AMD',            emoji: '💻', sector: 'Semi' },
  { ticker: 'AVGO',  nombre: 'Broadcom',       emoji: '🔌', sector: 'Semi' },
  { ticker: 'INTC',  nombre: 'Intel',          emoji: '⚙️', sector: 'Semi' },
  { ticker: 'AMZN',  nombre: 'Amazon',         emoji: '📦', sector: 'ECom' },
  { ticker: 'MELI',  nombre: 'MercadoLibre',   emoji: '🟡', sector: 'ECom' },
  { ticker: 'BABA',  nombre: 'Alibaba',        emoji: '🇨🇳', sector: 'ECom' },
  { ticker: 'TSLA',  nombre: 'Tesla',          emoji: '⚡', sector: 'ECom' },
  { ticker: 'V',     nombre: 'Visa',           emoji: '💳', sector: 'Fin' },
  { ticker: 'MA',    nombre: 'Mastercard',     emoji: '🔴', sector: 'Fin' },
  { ticker: 'JPM',   nombre: 'JPMorgan',       emoji: '🏦', sector: 'Fin' },
  { ticker: 'BAC',   nombre: 'Bank of America',emoji: '🏛️', sector: 'Fin' },
  { ticker: 'KO',    nombre: 'Coca-Cola',      emoji: '🥤', sector: 'Staples' },
  { ticker: 'PEP',   nombre: 'PepsiCo',        emoji: '🍾', sector: 'Staples' },
  { ticker: 'WMT',   nombre: 'Walmart',        emoji: '🛒', sector: 'Staples' },
  { ticker: 'PG',    nombre: 'Procter & Gamble',emoji: '🧼', sector: 'Staples' },
  { ticker: 'XOM',   nombre: 'ExxonMobil',     emoji: '⛽', sector: 'Energy' },
  { ticker: 'CVX',   nombre: 'Chevron',        emoji: '🛢️', sector: 'Energy' },
  { ticker: 'PFE',   nombre: 'Pfizer',         emoji: '💊', sector: 'Health' },
  { ticker: 'JNJ',   nombre: 'Johnson & Johnson',emoji: '🩺', sector: 'Health' },
  { ticker: 'DIS',   nombre: 'Disney',         emoji: '🏰', sector: 'Media' }
];

// ============================================================
// PARES DE PAIRS TRADING (COINTEGRACIÓN SECTORIAL)
// ============================================================
const PAIRS = [
  { key: 'NVDA_AMD',  a: 'NVDA',  b: 'AMD',  name: 'Semiconductores 🎮' },
  { key: 'MSFT_AAPL', a: 'MSFT',  b: 'AAPL', name: 'Big Tech 🪟' },
  { key: 'GOOGL_META',a: 'GOOGL', b: 'META', name: 'IA & Publicidad 🔍' },
  { key: 'V_MA',      a: 'V',     b: 'MA',   name: 'Medios de Pago 💳' },
  { key: 'AMZN_MELI', a: 'AMZN',  b: 'MELI', name: 'E-Commerce 📦' },
  { key: 'KO_PEP',    a: 'KO',    b: 'PEP',  name: 'Consumo Masivo 🥤' },
  { key: 'XOM_CVX',   a: 'XOM',   b: 'CVX',  name: 'Energía & Petróleo ⛽' }
];

const pairRatioHistory = {};

function calculatePairZScore(pairKey) {
  const history = pairRatioHistory[pairKey] || [];
  if (history.length < 5) return null;
  const mean = history.reduce((acc, v) => acc + v, 0) / history.length;
  const variance = history.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / history.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return { zScore: 0, mean, current: history[history.length - 1] };
  const currentRatio = history[history.length - 1];
  const zScore = (currentRatio - mean) / stdDev;
  return { zScore, mean, stdDev, current: currentRatio, pts: history.length };
}

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
// ============================================================
function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 810 && mins < 1200; // 13:30-20:00 UTC = 10:30-17:00 BA
}

// ============================================================
// IOL — ESTRATEGIA GAP DE APERTURA EN SPY Y SPXL (10:30 a 11:30 ART)
// QQQ 100% EXCLUIDO (PROTECCIÓN DE INVERSIÓN PERSONAL)
// ============================================================
const EXCLUDED_TICKERS = ['QQQ'];

async function scanMorningGapModule(token) {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 13:30 a 14:30 UTC = 10:30 a 11:30 ART
  if (mins < 810 || mins > 870) return null;

  const gapTickers = ['SPY', 'SPXL'];
  for (const ticker of gapTickers) {
    if (EXCLUDED_TICKERS.includes(ticker)) continue;
    const cotiz = await getIolCotizacion(token, ticker);
    if (cotiz && cotiz.ultimoPrecio && cotiz.cierreAnterior && cotiz.apertura) {
      const px = parseFloat(cotiz.ultimoPrecio);
      const closePrev = parseFloat(cotiz.cierreAnterior);
      const openPx = parseFloat(cotiz.apertura);
      const gapPct = ((openPx - closePrev) / closePrev) * 100;

      if (gapPct >= 0.40) {
        // Asumiendo log está disponible en el scope donde se use
        return { ticker, precioArs: px, gapPct, cotiz };
      }
    }
  }
  return null;
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
      plazo: 't2', // Plazo t2 (48hs) es el plazo estándar con más liquidez en BYMA para CEDEARs
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

  const MAX_LOTES = 3;
  const totalCap = Number(capitalArs) || 200000;
  const capitalPorLote = totalCap / MAX_LOTES;
  const gananciaEstimadaDia = totalCap * 0.022; // ~2.2% diario estimado con 3 lotes
  const gananciaEstimadaMes = gananciaEstimadaDia * 22;

  iolBot = {
    username: username.trim(),
    password: password.trim(),
    capitalArs: totalCap,
    capitalPorLote,
    slots: [ null, null, null ], // 3 slots independientes
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

  log(`🚀 BOT IOL CEDEARS v2 FASE 2.5 INICIADO`);
  log(`💰 Capital: $${totalCap.toLocaleString('es-AR')} ARS | 3 Slots de $${Math.round(capitalPorLote).toLocaleString('es-AR')} ARS cada uno`);
  log(`🔍 Monitoreando: 25 CEDEARs / 7 Pares Cointegrados / Filtro CCL vs MEP`);
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

    // ── FASE DE VENTA MULTI-SLOT ────────────────────────────
    for (let i = 0; i < MAX_LOTES; i++) {
      const pos = iolBot.slots[i];
      if (pos) {
        const cotiz = await getIolCotizacion(token, pos.ticker);
        if (cotiz && cotiz.ultimoPrecio) {
          const precioActual = parseFloat(cotiz.ultimoPrecio);
          const varPct = ((precioActual - pos.buyPriceArs) / pos.buyPriceArs) * 100;
          const tiempoEnPos = Date.now() - pos.buyTimestamp;
          const timeout = tiempoEnPos >= CFG.MAX_TIEMPO_POS;
          const takeProfit = varPct >= pos.tpPct;
          const stopLoss = varPct <= -pos.slPct;

          const horasPos = (tiempoEnPos / 3600000).toFixed(1);
          log(`📊 [SLOT #${i+1}] ${pos.ticker}: Comprado $${pos.buyPriceArs.toFixed(2)} → Actual $${precioActual.toFixed(2)} | Var: ${varPct >= 0 ? '+' : ''}${varPct.toFixed(2)}% | TP: +${pos.tpPct.toFixed(2)}% | SL: -${pos.slPct.toFixed(2)}% | En pos: ${horasPos}h`);

          let razon = null;
          if (takeProfit) razon = `✅ TAKE PROFIT +${pos.tpPct.toFixed(2)}%`;
          else if (stopLoss) razon = `🔴 STOP LOSS -${pos.slPct.toFixed(2)}%`;
          else if (timeout) razon = '⏱️ TIMEOUT 3 HORAS';

          if (razon) {
            log(`${razon} — Vendiendo Slot #${i+1}: ${pos.qty} CEDEARs de ${pos.ticker}...`);
            const resultado = await sendIolOrder(token, pos.ticker, pos.qty, precioActual, 'vender');
            if (resultado.success) {
              const gananciaBruta = (precioActual - pos.buyPriceArs) * pos.qty;
              const comisiones = (precioActual * pos.qty * CFG.COMISION_IOL / 100) + (pos.buyPriceArs * pos.qty * CFG.COMISION_IOL / 100);
              const gananciaNeta = gananciaBruta - comisiones;
              iolBot.totalGananciasArs += gananciaNeta;
              if (takeProfit) iolBot.wins++;
              else iolBot.losses++;
              log(`💵 Slot #${i+1} Liberado | Orden #${resultado.orderId} | Ganancia Neta: ${gananciaNeta >= 0 ? '+' : ''}$${Math.round(gananciaNeta).toLocaleString('es-AR')} ARS`);
              log(`📈 TOTAL ACUMULADO: $${Math.round(iolBot.totalGananciasArs).toLocaleString('es-AR')} ARS | Wins: ${iolBot.wins} | Losses: ${iolBot.losses}`);
              iolBot.slots[i] = null;
            } else {
              log(`❌ VENTA SLOT #${i+1} FALLIDA: ${resultado.error}`);
            }
          }
        }
      }
    }

    // ── VERIFICAR SI HAY SLOTS LIBRES ───────────────────────
    const freeSlotIndex = iolBot.slots.findIndex(s => s === null);
    if (freeSlotIndex === -1) {
      log(`🔒 Los 3 slots están ocupados. Monitoreando ventas en próximo ciclo.`);
      return;
    }

    // ── FASE DE ESCANEO DE LOS 25 CEDEARS Y MUESTREO ─────────
    const currentUsdValues = {};
    const currentQuotes = {};

    for (const c of CEDEARS) {
      const cotiz = await getIolCotizacion(token, c.ticker);
      if (cotiz && cotiz.ultimoPrecio) {
        const precioArs = parseFloat(cotiz.ultimoPrecio);
        const valorUsd = precioArs / mep;
        currentUsdValues[c.ticker] = valorUsd;
        currentQuotes[c.ticker] = { precioArs, valorUsd, cotiz };

        if (!cedearHistory[c.ticker]) cedearHistory[c.ticker] = [];
        cedearHistory[c.ticker].push({ valorUsd, ts: Date.now() });
        if (cedearHistory[c.ticker].length > CFG.HISTORIAL_MAX) cedearHistory[c.ticker].shift();
      }
    }

    // ── PROCESAMIENTO DE HISTORIAL Y PAIRS TRADING (RATIO Z-SCORE) ──
    let mejorOportunidadPair = null;
    let maxZDeviation = 0;

    // Verificar si hay señal de Gap de Apertura a la mañana en SPY/SPXL
    const gapOpp = await scanMorningGapModule(token);
    if (gapOpp && !iolBot.slots.some(s => s && s.ticker === gapOpp.ticker)) {
      mejorOportunidadPair = {
        ticker: gapOpp.ticker,
        precioArs: gapOpp.precioArs,
        valorUsd: gapOpp.precioArs / (iolBot.dolarMep || 1500),
        pairName: `Gap Apertura +${gapOpp.gapPct.toFixed(2)}%`,
        zScore: 2.50,
        cotiz: gapOpp.cotiz
      };
    }

    for (const pair of PAIRS) {
      const valA = currentUsdValues[pair.a];
      const valB = currentUsdValues[pair.b];
      if (valA && valB) {
        const ratio = valA / valB;
        if (!pairRatioHistory[pair.key]) pairRatioHistory[pair.key] = [];
        pairRatioHistory[pair.key].push(ratio);
        if (pairRatioHistory[pair.key].length > CFG.HISTORIAL_MAX) pairRatioHistory[pair.key].shift();

        const zData = calculatePairZScore(pair.key);
        if (zData && zData.pts >= 5) {
          const zVal = zData.zScore;
          const absZ = Math.abs(zVal);
          const statusIcon = absZ >= 1.8 ? '🔴 SEÑAL' : (absZ >= 1.2 ? '🟡 ALERTA' : '⚪ OK');
          log(`📊 [PAR ${pair.name}] Ratio: ${ratio.toFixed(4)} | Z-Score: ${zVal >= 0 ? '+' : ''}${zVal.toFixed(2)} ${statusIcon}`);

          if (absZ >= 1.8 && absZ > maxZDeviation) {
            maxZDeviation = absZ;
            const targetTicker = zVal < 0 ? pair.a : pair.b;
            const targetQuote = currentQuotes[targetTicker];
            if (targetQuote) {
              // Verificar si ya tenemos este ticker en alguno de los slots
              const yaComprado = iolBot.slots.some(s => s && s.ticker === targetTicker);
              if (!yaComprado) {
                mejorOportunidadPair = {
                  ticker: targetTicker,
                  precioArs: targetQuote.precioArs,
                  valorUsd: targetQuote.valorUsd,
                  pairName: pair.name,
                  zScore: zVal,
                  cotiz: targetQuote.cotiz
                };
              }
            }
          }
        }
      }
    }

    // ── COMPRA PAIRS TRADING EN SLOT LIBRE ──────────────────
    if (mejorOportunidadPair) {
      const q = mejorOportunidadPair;
      const cotiz = q.cotiz;
      const max = parseFloat(cotiz.maximo || cotiz.ultimoPrecio);
      const min = parseFloat(cotiz.minimo || cotiz.ultimoPrecio);
      const prevClose = parseFloat(cotiz.cierreAnterior || cotiz.ultimoPrecio);
      const tr = Math.max(max - min, Math.abs(max - prevClose), Math.abs(min - prevClose));
      const atrPct = (tr / q.precioArs) * 100 || 1.5;
      const dynamicTpPct = Math.min(Math.max(atrPct * 1.8, 2.0), 5.0);
      const dynamicSlPct = Math.min(Math.max(atrPct * 0.9, 1.0), 2.5);

      const cantidad = Math.floor(iolBot.capitalPorLote / q.precioArs);
      if (cantidad >= 1) {
        log(`⚡ SEÑAL DE PAIRS TRADING EN SLOT #${freeSlotIndex+1}: ${q.ticker} [${q.pairName}] (Z-Score ${q.zScore.toFixed(2)})`);
        log(`🛒 Comprando ${cantidad} CEDEARs de ${q.ticker} a $${q.precioArs.toFixed(2)} ARS (Slot #${freeSlotIndex+1}: $${(cantidad * q.precioArs).toLocaleString('es-AR')} ARS)`);

        const resultado = await sendIolOrder(token, q.ticker, cantidad, q.precioArs, 'comprar');
        if (resultado.success) {
          iolBot.slots[freeSlotIndex] = {
            id: freeSlotIndex + 1,
            ticker: q.ticker,
            qty: cantidad,
            buyPriceArs: q.precioArs,
            buyTimestamp: Date.now(),
            tpPct: dynamicTpPct,
            slPct: dynamicSlPct,
            atrPct: atrPct,
            pairName: q.pairName
          };
          log(`✅ SLOT #${freeSlotIndex+1} OCUPADO | Orden #${resultado.orderId} | ${cantidad}× ${q.ticker} | TP: +${dynamicTpPct.toFixed(2)}% | SL: -${dynamicSlPct.toFixed(2)}%`);
          return;
        } else {
          log(`❌ RECHAZO DE ORDEN IOL: ${resultado.error}`);
        }
      }
    }

    log(`⏳ Sin oportunidades nuevas para Slot libre #${freeSlotIndex+1}. Esperando próximo ciclo en 5 min.`);
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
