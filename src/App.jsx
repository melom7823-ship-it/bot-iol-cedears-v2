import { useState, useEffect, useCallback } from 'react';
import './index.css';

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

function getLogClass(entry) {
  if (entry.includes('TAKE PROFIT') || entry.includes('✅') || entry.includes('CONFIRMADA') || entry.includes('WIN')) return 'win';
  if (entry.includes('STOP LOSS') || entry.includes('❌') || entry.includes('FALLIDA')) return 'loss';
  if (entry.includes('COMPRA') || entry.includes('🛒') || entry.includes('🟢') || entry.includes('OPORTUNIDAD')) return 'buy';
  if (entry.includes('⚠️') || entry.includes('TIMEOUT') || entry.includes('⏱️')) return 'warn';
  if (entry.includes('⏰') || entry.includes('⏳') || entry.includes('Acumulando') || entry.includes('⚪') || entry.includes('⏸')) return 'muted';
  return 'info';
}

export default function App() {
  // ── ESTADO: CREDENCIALES Y CONFIGURACIÓN
  const [username, setUsername]   = useState(() => localStorage.getItem('IOL_USER') || '');
  const [password, setPassword]   = useState(() => localStorage.getItem('IOL_PASS') || '');
  const [capitalArs, setCapitalArs] = useState(() => Number(localStorage.getItem('IOL_CAPITAL')) || 200000);

  // ── ESTADO: BOT
  const [botActivo, setBotActivo]   = useState(false);
  const [estado, setEstado]         = useState('APAGADO');
  const [ticker, setTicker]         = useState(null);
  const [qty, setQty]               = useState(0);
  const [buyPrice, setBuyPrice]     = useState(null);
  const [wins, setWins]             = useState(0);
  const [losses, setLosses]         = useState(0);
  const [cycles, setCycles]         = useState(0);
  const [gananciasArs, setGananciasArs] = useState(0);
  const [logs, setLogs]             = useState([]);
  const [lastPoll, setLastPoll]     = useState(null);

  // ── PERSISTIR CREDENCIALES
  useEffect(() => {
    localStorage.setItem('IOL_USER', username);
    localStorage.setItem('IOL_PASS', password);
    localStorage.setItem('IOL_CAPITAL', capitalArs);
  }, [username, password, capitalArs]);

  // ── POLLING DE STATUS (cada 15s cuando el bot está activo)
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/iol/status');
      if (!res.ok) return;
      const data = await res.json();
      setEstado(data.estado || 'APAGADO');
      setTicker(data.ticker || null);
      setQty(data.qty || 0);
      setBuyPrice(data.buyPriceArs || null);
      setWins(data.wins || 0);
      setLosses(data.losses || 0);
      setCycles(data.cycles || 0);
      setGananciasArs(data.totalGananciasArs || 0);
      if (data.logs && data.logs.length > 0) setLogs(data.logs);
      setBotActivo(data.activo);
      setLastPoll(new Date().toLocaleTimeString('es-AR'));
    } catch { /* sin conexión */ }
  }, []);

  // ── AUTO-SYNC: si hay credenciales guardadas, re-enviar al servidor al cargar
  useEffect(() => {
    const savedUser = localStorage.getItem('IOL_USER');
    const savedPass = localStorage.getItem('IOL_PASS');
    const savedCap  = localStorage.getItem('IOL_CAPITAL');
    if (savedUser && savedPass) {
      fetch('/api/iol/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: savedUser, password: savedPass, capitalArs: Number(savedCap) || 200000 })
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 15000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  // ── ENCENDER BOT
  const handleStart = async () => {
    if (!username || !password) {
      alert('Ingresá tu usuario (email) y contraseña de IOL.');
      return;
    }
    try {
      const res = await fetch('/api/iol/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, capitalArs })
      });
      const data = await res.json();
      if (data.success) {
        setBotActivo(true);
        setEstado('DISPONIBLE');
        setTimeout(pollStatus, 2000);
      } else {
        alert('Error: ' + data.error);
      }
    } catch {
      alert('No se pudo conectar con el servidor. Verificá que esté activo en Render.');
    }
  };

  // ── APAGAR BOT
  const handleStop = async () => {
    try {
      await fetch('/api/iol/stop', { method: 'POST' });
      setBotActivo(false);
      setEstado('APAGADO');
      setTicker(null);
    } catch { /* ignore */ }
  };

  // ── CÁLCULOS
  const total = wins + losses;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
  const gananciaEstDia = capitalArs * 0.012;
  const gananciaEstMes = gananciaEstDia * 22;

  // ── RENDER
  return (
    <div className="app-wrapper">
      <div className="app-container">

        {/* HEADER */}
        <header className="app-header">
          <div className="header-badge">
            <span className="header-badge-dot" />
            InvertirOnline · CEDEARs · BYMA
          </div>
          <h1 className="app-title">🇦🇷 Bot IOL CEDEARs v2</h1>
          <p className="app-subtitle">
            Trading automático de CEDEARs con análisis de Dólar MEP. Estrategia mejorada con TP +3.5% y ciclos de 5 minutos.
          </p>
        </header>

        {/* STATS BAR */}
        <div className="stats-bar">
          <div className="stat-card">
            <span className="stat-label">Ganancias Totales</span>
            <span className={`stat-value ${gananciasArs >= 0 ? 'green' : 'red'}`}>
              ${Math.round(gananciasArs).toLocaleString('es-AR')}
            </span>
            <span className="stat-sub">ARS acumulados</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Win Rate</span>
            <span className={`stat-value ${winRate >= 55 ? 'green' : winRate > 0 ? 'gold' : 'blue'}`}>
              {winRate}%
            </span>
            <span className="stat-sub">{wins} ganadas / {losses} perdidas</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Ciclos Ejecutados</span>
            <span className="stat-value blue">{cycles}</span>
            <span className="stat-sub">análisis de mercado</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Estado</span>
            <span className={`stat-value ${estado === 'INVERTIDO' ? 'gold' : estado === 'DISPONIBLE' ? 'green' : 'red'}`}>
              {estado === 'INVERTIDO' ? '📊 ACTIVO' : estado === 'DISPONIBLE' ? '🔍 BUSCANDO' : '⏸ APAGADO'}
            </span>
            <span className="stat-sub">{lastPoll ? `Último poll: ${lastPoll}` : 'Sin datos aún'}</span>
          </div>
        </div>

        {/* CARD: CONEXIÓN IOL */}
        <div className="card">
          <div className="card-header">
            <div className="card-icon green">🔐</div>
            <span className="card-title">Conexión con InvertirOnline</span>
            <div className="status-indicator">
              <span className={`status-dot ${botActivo ? (estado === 'INVERTIDO' ? 'warning' : 'online') : 'offline'}`} />
              <span className="status-text" style={{ color: botActivo ? 'var(--green)' : 'var(--text-muted)' }}>
                {botActivo ? estado : 'DESCONECTADO'}
              </span>
            </div>
          </div>
          <div className="card-body">

            {botActivo && (
              <div className="alert green" style={{ marginBottom: 14 }}>
                ✅ Bot activo en el servidor de Render. Los ciclos se ejecutan cada 5 minutos aunque cierres esta ventana.
              </div>
            )}

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">📧 Email / Usuario IOL</label>
                <input
                  type="email"
                  className="form-input"
                  placeholder="tucuenta@email.com"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">🔑 Contraseña IOL</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Tu contraseña de InvertirOnline"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">💰 Capital Autorizado (ARS)</label>
                <input
                  type="number"
                  className="form-input"
                  placeholder="200000"
                  value={capitalArs}
                  onChange={e => setCapitalArs(Number(e.target.value))}
                />
                <span className="form-hint">📊 Estimado: ${Math.round(gananciaEstDia).toLocaleString('es-AR')}/día | ${Math.round(gananciaEstMes).toLocaleString('es-AR')}/mes</span>
              </div>
              <div className="form-group">
                <label className="form-label">🔒 QQQ</label>
                <input type="text" className="form-input" value="BLOQUEADO — Protegido siempre" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }} />
                <span className="form-hint">🛡️ Tus CEDEARs personales de QQQ jamás se tocan</span>
              </div>
            </div>

            <div className="btn-row">
              <button id="btn-iniciar-bot" className="btn btn-green" onClick={handleStart} disabled={botActivo}>
                🚀 {botActivo ? 'Bot Activo en Render' : 'Iniciar Bot IOL v2'}
              </button>
              <button id="btn-apagar-bot" className="btn btn-red" onClick={handleStop} disabled={!botActivo}>
                ⏹ Apagar Bot
              </button>
            </div>
          </div>
        </div>

        {/* CARD: POSICIÓN ACTUAL */}
        {botActivo && (
          <div className="card">
            <div className="card-header">
              <div className="card-icon gold">📊</div>
              <span className="card-title">Posición Actual</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Actualiza cada 15 seg</span>
            </div>
            <div className="card-body">
              {estado === 'INVERTIDO' ? (
                <>
                  <div className="alert gold">
                    💼 En posición: {qty}× {ticker} comprados a ${buyPrice?.toFixed(2)} ARS | TP: ${buyPrice ? (buyPrice * 1.035).toFixed(2) : '—'} | SL: ${buyPrice ? (buyPrice * 0.985).toFixed(2) : '—'}
                  </div>
                  <div className="position-box">
                    <div className="pos-item">
                      <span className="pos-label">CEDEAR</span>
                      <span className="pos-value gold">{ticker}</span>
                    </div>
                    <div className="pos-item">
                      <span className="pos-label">Cantidad</span>
                      <span className="pos-value">{qty}</span>
                    </div>
                    <div className="pos-item">
                      <span className="pos-label">Precio Compra</span>
                      <span className="pos-value">${buyPrice?.toFixed(2)}</span>
                    </div>
                    <div className="pos-item">
                      <span className="pos-label">Take Profit</span>
                      <span className="pos-value green">${buyPrice ? (buyPrice * 1.035).toFixed(2) : '—'}</span>
                    </div>
                    <div className="pos-item">
                      <span className="pos-label">Stop Loss</span>
                      <span className="pos-value red">${buyPrice ? (buyPrice * 0.985).toFixed(2) : '—'}</span>
                    </div>
                    <div className="pos-item">
                      <span className="pos-label">Total Invertido</span>
                      <span className="pos-value">${buyPrice && qty ? (buyPrice * qty).toLocaleString('es-AR', { maximumFractionDigits: 0 }) : '—'} ARS</span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="alert green">
                  🔍 El bot está buscando oportunidades. Se comprará cuando algún CEDEAR esté ≥2% más barato que su precio justo.
                </div>
              )}
            </div>
          </div>
        )}

        {/* CARD: ESTRATEGIA */}
        <div className="card">
          <div className="card-header">
            <div className="card-icon blue">⚙️</div>
            <span className="card-title">Estrategia Optimizada v2</span>
            <span style={{ fontSize: 11, background: 'var(--green-glow)', border: '1px solid var(--green)', color: 'var(--green)', padding: '2px 10px', borderRadius: 999, fontWeight: 700 }}>MEJORADA</span>
          </div>
          <div className="card-body">
            <div className="strategy-grid" style={{ marginBottom: 14 }}>
              <div className="strategy-item">
                <div className="strategy-val green">+3.5%</div>
                <div className="strategy-lbl">Take Profit</div>
              </div>
              <div className="strategy-item">
                <div className="strategy-val red">-1.5%</div>
                <div className="strategy-lbl">Stop Loss</div>
              </div>
              <div className="strategy-item">
                <div className="strategy-val blue">5 min</div>
                <div className="strategy-lbl">Ciclo análisis</div>
              </div>
              <div className="strategy-item">
                <div className="strategy-val gold">-2.0%</div>
                <div className="strategy-lbl">Señal mínima</div>
              </div>
              <div className="strategy-item">
                <div className="strategy-val green">20 pts</div>
                <div className="strategy-lbl">Historial base</div>
              </div>
              <div className="strategy-item">
                <div className="strategy-val blue">3 hs</div>
                <div className="strategy-lbl">Timeout máx</div>
              </div>
            </div>
            <div className="alert blue">
              💡 Ganancia neta real por WIN: ~+2.3% (después de comisiones IOL 1.2%). Por LOSS: ~-2.7%. Con 60% de win rate el resultado mensual es <strong>positivo</strong>.
            </div>
          </div>
        </div>

        {/* CARD: CEDEARs MONITOREADOS */}
        <div className="card">
          <div className="card-header">
            <div className="card-icon green">🔍</div>
            <span className="card-title">CEDEARs Monitoreados (8 activos)</span>
          </div>
          <div className="card-body">
            <div className="cedears-grid">
              {CEDEARS.map(c => (
                <div key={c.ticker} className={`cedear-chip ${ticker === c.ticker ? 'held' : botActivo ? 'active' : ''}`}>
                  <span className="cedear-emoji">{c.emoji}</span>
                  <span className="cedear-name">{c.nombre}</span>
                  <span className="cedear-ticker">{c.ticker}</span>
                  {ticker === c.ticker && <div style={{ fontSize: 10, color: 'var(--gold)', marginTop: 3 }}>EN POSICIÓN</div>}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }} className="alert gold">
              🔒 QQQ: BLOQUEADO permanentemente. Jamás será operado por el bot.
            </div>
          </div>
        </div>

        {/* CARD: LOG EN TIEMPO REAL */}
        <div className="card">
          <div className="card-header">
            <div className="card-icon green">📡</div>
            <span className="card-title">Log en Tiempo Real — Servidor Render</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Polling cada 15s</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="log-terminal">
              <div className="log-terminal-header">
                <div className="log-dots">
                  <div className="log-dot r" />
                  <div className="log-dot y" />
                  <div className="log-dot g" />
                </div>
                <span className="log-title-bar">bot-iol-cedears-v2 — render.com — bash</span>
              </div>
              <div className="log-entries">
                {logs.length === 0 ? (
                  <div className="log-empty">
                    {botActivo ? '⏳ Esperando primer ciclo del bot...' : '🔌 Iniciá el bot para ver los logs en tiempo real.'}
                  </div>
                ) : (
                  logs.map((entry, i) => (
                    <div key={i} className={`log-entry ${getLogClass(entry)}`}>
                      {entry}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* FOOTER */}
        <footer className="app-footer">
          🇦🇷 Bot IOL CEDEARs v2 · Estrategia Dólar MEP · Solo opera Lun–Vie 10:30–17:00 hs (BYMA) ·
          QQQ protegido · No es asesoramiento financiero
        </footer>
      </div>
    </div>
  );
}
