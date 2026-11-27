// Checador QR — Registro electrónico de jornada laboral
// Sin dependencias externas: requiere Node.js >= 22.13 (usa node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ_EMPRESA || 'America/Mexico_City';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'datos', 'checador.db');
const EMPRESA = process.env.EMPRESA || 'Mi Empresa S.A. de C.V.';
const QR_VENTANA_S = 30;          // el QR del kiosco cambia cada 30 s
const PASE_MIN = 5;               // minutos para completar el registro tras escanear
const DUPLICADO_MIN = 2;          // evita doble registro del mismo tipo en este lapso

// ---------------------------------------------------------------- Base de datos
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, usuario TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL,
  pass_hash TEXT NOT NULL, creado_en TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS empleados (
  id INTEGER PRIMARY KEY, numero TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL,
  rfc TEXT, curp TEXT, puesto TEXT, pin_hash TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1, creado_en TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dispositivos (
  id INTEGER PRIMARY KEY, empleado_id INTEGER NOT NULL REFERENCES empleados(id),
  token_hash TEXT UNIQUE NOT NULL, user_agent TEXT, creado_en TEXT NOT NULL,
  revocado_en TEXT);
CREATE TABLE IF NOT EXISTS kioscos (
  id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, clave TEXT UNIQUE NOT NULL,
  secreto TEXT NOT NULL, activo INTEGER NOT NULL DEFAULT 1, creado_en TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registros (
  id INTEGER PRIMARY KEY,
  empleado_id INTEGER NOT NULL REFERENCES empleados(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ENTRADA','SALIDA','INICIO_DESCANSO','FIN_DESCANSO','ANULACION')),
  fecha_hora TEXT NOT NULL,            -- UTC ISO-8601, siempre hora del servidor
  origen TEXT NOT NULL CHECK (origen IN ('QR','CORRECCION')),
  registrado_por TEXT NOT NULL,        -- 'empleado:<num>' o 'admin:<usuario>'
  kiosco_id INTEGER REFERENCES kioscos(id),
  dispositivo_id INTEGER REFERENCES dispositivos(id),
  ref_id INTEGER REFERENCES registros(id),   -- registro anulado (ANULACION)
  motivo TEXT, ip TEXT, user_agent TEXT, lat REAL, lon REAL, precision_m REAL,
  capturado_en TEXT NOT NULL,          -- momento real de captura (UTC)
  hash_prev TEXT, hash TEXT);
CREATE INDEX IF NOT EXISTS ix_reg_emp_fecha ON registros(empleado_id, fecha_hora);
CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, actor TEXT NOT NULL,
  accion TEXT NOT NULL, detalle TEXT);
-- Los registros son inalterables: no se pueden modificar ni borrar.
CREATE TRIGGER IF NOT EXISTS reg_no_update BEFORE UPDATE ON registros
  WHEN OLD.hash IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Registro inalterable'); END;
CREATE TRIGGER IF NOT EXISTS reg_no_delete BEFORE DELETE ON registros
  BEGIN SELECT RAISE(ABORT, 'Registro inalterable'); END;
-- Conformidad del trabajador con sus registros de una semana (firma electrónica simple)
CREATE TABLE IF NOT EXISTS conformidades (
  id INTEGER PRIMARY KEY, empleado_id INTEGER NOT NULL REFERENCES empleados(id),
  desde TEXT NOT NULL, hasta TEXT NOT NULL,       -- fechas locales YYYY-MM-DD
  acuerdo INTEGER NOT NULL,                       -- 1 = de acuerdo, 0 = con observación
  comentario TEXT, resumen TEXT NOT NULL, resumen_hash TEXT NOT NULL,
  dispositivo_id INTEGER REFERENCES dispositivos(id), ip TEXT, user_agent TEXT,
  fecha TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS conf_no_update BEFORE UPDATE ON conformidades
  BEGIN SELECT RAISE(ABORT, 'Conformidad inalterable'); END;
CREATE TRIGGER IF NOT EXISTS conf_no_delete BEFORE DELETE ON conformidades
  BEGIN SELECT RAISE(ABORT, 'Conformidad inalterable'); END;
`);
// Migraciones de bases creadas con la versión 1.0
if (!db.prepare('PRAGMA table_info(empleados)').all().some((c) => c.name === 'horas_semana'))
  db.exec('ALTER TABLE empleados ADD COLUMN horas_semana REAL');   // jornada semanal pactada (vacío = máximo legal)
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name='registros'").get().sql.includes('INICIO_DESCANSO')) {
  // Se reconstruye la tabla para admitir los tipos de descanso, copiando los registros tal cual (mismos sellos).
  const sqlNueva = db.prepare("SELECT sql FROM sqlite_master WHERE name='registros'").get().sql
    .replace("'ENTRADA','SALIDA','ANULACION'", "'ENTRADA','SALIDA','INICIO_DESCANSO','FIN_DESCANSO','ANULACION'")
    .replace(/CREATE TABLE registros/i, 'CREATE TABLE registros_v2');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN; DROP TRIGGER reg_no_update; DROP TRIGGER reg_no_delete; ${sqlNueva};
    INSERT INTO registros_v2 SELECT * FROM registros; DROP TABLE registros; ALTER TABLE registros_v2 RENAME TO registros;
    CREATE INDEX IF NOT EXISTS ix_reg_emp_fecha ON registros(empleado_id, fecha_hora);
    CREATE TRIGGER reg_no_update BEFORE UPDATE ON registros WHEN OLD.hash IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Registro inalterable'); END;
    CREATE TRIGGER reg_no_delete BEFORE DELETE ON registros BEGIN SELECT RAISE(ABORT, 'Registro inalterable'); END;
    COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Base de datos migrada a la versión 1.1 (descansos).');
}

// ---------- Jornada legal y horas extra (configurables por si cambia la regulación)
// Calendario de la reforma publicada el 1-may-2026: 48 h (2026), 46 (2027), 44 (2028), 42 (2029), 40 (2030 en adelante).
const CALENDARIO_JORNADA = { 2026: 48, 2027: 46, 2028: 44, 2029: 42 };
const jornadaLegal = (anio) => Number(process.env.JORNADA_SEMANAL) || (anio < 2026 ? 48 : CALENDARIO_JORNADA[anio] ?? 40);
// Horas extra que se pagan al doble por semana; el excedente se paga al triple (art. 68 LFT).
const HORAS_EXTRA_DOBLES = Number(process.env.HORAS_EXTRA_DOBLES || 9);
const TIPOS_MARCA = ['ENTRADA', 'SALIDA', 'INICIO_DESCANSO', 'FIN_DESCANSO'];
const NOMBRE_TIPO = { ENTRADA: 'Entrada', SALIDA: 'Salida', INICIO_DESCANSO: 'Inicio de descanso', FIN_DESCANSO: 'Fin de descanso', ANULACION: 'Anulación' };

const ahora = () => new Date().toISOString();
const cfg = (k) => db.prepare('SELECT valor FROM config WHERE clave=?').get(k)?.valor;
const setCfg = (k, v) => db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run(k, v);
if (!cfg('secreto')) setCfg('secreto', crypto.randomBytes(32).toString('hex'));
const SECRETO = cfg('secreto');

// ---------------------------------------------------------------- Utilidades
function hashPass(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(p), salt, 32).toString('hex');
}
function checkPass(p, stored) {
  const [salt, h] = String(stored).split(':');
  const calc = crypto.scryptSync(String(p), salt, 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
const randTok = (n = 32) => crypto.randomBytes(n).toString('base64url');

function bitacora(actor, accion, detalle) {
  db.prepare('INSERT INTO bitacora (fecha, actor, accion, detalle) VALUES (?,?,?,?)')
    .run(ahora(), actor, accion, detalle ? JSON.stringify(detalle) : null);
}

// Administrador inicial
if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get()) {
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASSWORD || 'cambiar123';
  db.prepare('INSERT INTO admins (usuario, nombre, pass_hash, creado_en) VALUES (?,?,?,?)')
    .run(u, 'Administrador', hashPass(p), ahora());
  console.log(`\n  Administrador inicial creado → usuario: ${u}  contraseña: ${p}`);
  console.log('  ¡Cámbiela al entrar por primera vez!\n');
}

// ---------- Zona horaria
function tzOffsetMs(date, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
// 'YYYY-MM-DDTHH:mm' en hora local de la empresa → Date (UTC)
function localAUtc(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(String(str || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  let t = guess - tzOffsetMs(new Date(guess));
  t = guess - tzOffsetMs(new Date(t));
  return new Date(t);
}
const fmtFecha = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fechaLocal = (iso) => fmtFecha.format(new Date(iso));
const horaLocal = (iso) => fmtHora.format(new Date(iso));
const hoyLocal = () => fechaLocal(ahora());
function rangoUtc(desde, hasta) {
  const d = localAUtc(desde || hoyLocal());
  const h = localAUtc(hasta || desde || hoyLocal());
  if (!d || !h) return null;
  return [d.toISOString(), new Date(h.getTime() + 86400000).toISOString()];
}

// ---------- Registros con cadena de integridad (hash encadenado)
function camposHash(r) {
  return [r.id, r.empleado_id, r.tipo, r.fecha_hora, r.origen, r.registrado_por,
    r.kiosco_id ?? '', r.ref_id ?? '', r.motivo ?? '', r.capturado_en].join('|');
}
function insertarRegistro(r) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prev = db.prepare('SELECT hash FROM registros ORDER BY id DESC LIMIT 1').get()?.hash || 'GENESIS';
    const capturado = ahora();
    const info = db.prepare(`INSERT INTO registros
      (empleado_id, tipo, fecha_hora, origen, registrado_por, kiosco_id, dispositivo_id, ref_id,
       motivo, ip, user_agent, lat, lon, precision_m, capturado_en, hash_prev)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.empleado_id, r.tipo, r.fecha_hora || capturado, r.origen, r.registrado_por,
      r.kiosco_id ?? null, r.dispositivo_id ?? null, r.ref_id ?? null, r.motivo ?? null,
      r.ip ?? null, r.user_agent ?? null, r.lat ?? null, r.lon ?? null, r.precision_m ?? null,
      capturado, prev);
    const id = Number(info.lastInsertRowid);
    const row = db.prepare('SELECT * FROM registros WHERE id=?').get(id);
    const h = sha256(prev + '|' + camposHash(row));
    db.prepare('UPDATE registros SET hash=? WHERE id=?').run(h, id);
    db.exec('COMMIT');
    return { ...row, hash: h };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function verificarCadena() {
  let prev = 'GENESIS', n = 0;
  for (const r of db.prepare('SELECT * FROM registros ORDER BY id').iterate()) {
    n++;
    if (r.hash_prev !== prev || r.hash !== sha256(prev + '|' + camposHash(r)))
      return { ok: false, total: n, fallo_en: r.id };
    prev = r.hash;
  }
  return { ok: true, total: n, ultimo_hash: prev };
}

// ---------- Cálculo de jornadas (ENTRADA → [descansos] → SALIDA)
function calcularJornadas(desdeIso, hastaIso, empleadoId) {
  // Se amplía el rango 1 día hacia atrás para captar entradas de turnos nocturnos.
  const desdeExt = new Date(new Date(desdeIso).getTime() - 86400000).toISOString();
  const params = [desdeExt, hastaIso];
  let sql = `SELECT r.*, e.numero, e.nombre FROM registros r JOIN empleados e ON e.id=r.empleado_id
    WHERE r.tipo IN ('ENTRADA','SALIDA','INICIO_DESCANSO','FIN_DESCANSO') AND r.fecha_hora >= ? AND r.fecha_hora < ?
    AND r.id NOT IN (SELECT ref_id FROM registros WHERE tipo='ANULACION' AND ref_id IS NOT NULL)`;
  if (empleadoId) { sql += ' AND r.empleado_id=?'; params.push(Number(empleadoId)); }
  sql += ' ORDER BY r.empleado_id, r.fecha_hora, r.id';
  const filas = db.prepare(sql).all(...params);
  const out = [];
  const ms = (a, b) => new Date(b.fecha_hora) - new Date(a.fecha_hora);
  const cerrar = (j) => {
    const ref = j.entrada || j.salida;
    if (ref.fecha_hora < desdeIso) return;   // pertenece al día previo al rango
    const obs = [...j.obs];
    if (j.descansoAbierto) {
      if (j.salida) { j.descansos.push([j.descansoAbierto, j.salida]); obs.push('Descanso sin registro de fin'); }
      else obs.push('Descanso sin registro de fin');
    }
    const total = j.entrada && j.salida ? ms(j.entrada, j.salida) / 3600000 : null;
    const descanso = j.descansos.reduce((s, [a, b]) => s + ms(a, b), 0) / 3600000;
    if (!j.salida) obs.push('Sin registro de salida');
    if (!j.entrada) obs.push('Salida sin entrada');
    if ([j.entrada, j.salida, ...j.descansos.flat()].some((x) => x && x.origen === 'CORRECCION')) obs.push('Incluye corrección');
    if (total !== null && total > 16) obs.push('Jornada mayor a 16 h, revisar');
    const r2 = (x) => Math.round(x * 100) / 100;
    out.push({
      empleado_id: ref.empleado_id, numero: ref.numero, nombre: ref.nombre,
      fecha: fechaLocal(ref.fecha_hora),
      entrada: j.entrada ? horaLocal(j.entrada.fecha_hora) : null,
      salida: j.salida ? horaLocal(j.salida.fecha_hora) : null,
      salida_fecha: j.salida ? fechaLocal(j.salida.fecha_hora) : null,
      entrada_id: j.entrada?.id ?? null, salida_id: j.salida?.id ?? null,
      descansos: j.descansos.map(([a, b]) => `${horaLocal(a.fecha_hora).slice(0, 5)}–${horaLocal(b.fecha_hora).slice(0, 5)}`).join(', '),
      horas_presencia: total === null ? null : r2(total),
      horas_descanso: r2(descanso),
      horas: total === null ? null : r2(total - descanso),     // horas efectivas trabajadas
      observaciones: [...new Set(obs)].join('; '),
    });
  };
  let abierta = null, empActual = null;
  const nueva = (entrada) => ({ entrada, salida: null, descansos: [], descansoAbierto: null, obs: [] });
  for (const f of filas) {
    if (f.empleado_id !== empActual) { if (abierta) cerrar(abierta); abierta = null; empActual = f.empleado_id; }
    if (f.tipo === 'ENTRADA') {
      if (abierta) cerrar(abierta);
      abierta = nueva(f);
    } else if (f.tipo === 'SALIDA') {
      if (abierta) { abierta.salida = f; cerrar(abierta); abierta = null; }
      else { const j = nueva(null); j.salida = f; cerrar(j); }
    } else if (f.tipo === 'INICIO_DESCANSO') {
      if (abierta && !abierta.descansoAbierto) abierta.descansoAbierto = f;
      else if (abierta) abierta.obs.push('Inicio de descanso duplicado');
    } else if (f.tipo === 'FIN_DESCANSO') {
      if (abierta?.descansoAbierto) { abierta.descansos.push([abierta.descansoAbierto, f]); abierta.descansoAbierto = null; }
      else if (abierta) abierta.obs.push('Fin de descanso sin inicio');
    }
  }
  if (abierta) cerrar(abierta);
  return out;
}

// ---------- Horas extra por semana (lunes a domingo)
const sumarDias = (fecha, n) => { const d = new Date(fecha + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lunesDe = (fecha) => { const d = new Date(fecha + 'T12:00:00Z'); return sumarDias(fecha, -((d.getUTCDay() + 6) % 7)); };
function calcularSemanas(desde, hasta, empleadoId) {
  const ini = lunesDe(desde || hoyLocal()), fin = sumarDias(lunesDe(hasta || desde || hoyLocal()), 6);
  const [d, h] = rangoUtc(ini, fin);
  const jornadas = calcularJornadas(d, h, empleadoId);
  const emps = Object.fromEntries(db.prepare('SELECT id, numero, nombre, rfc, curp, puesto, horas_semana FROM empleados').all().map((e) => [e.id, e]));
  const semanas = {};
  for (const j of jornadas) {
    const lunes = lunesDe(j.fecha), clave = `${j.empleado_id}|${lunes}`;
    const s = semanas[clave] ??= { empleado_id: j.empleado_id, numero: j.numero, nombre: j.nombre, desde: lunes, hasta: sumarDias(lunes, 6),
      dias: new Set(), horas: 0, descanso: 0, incidencias: 0, jornadas: [] };
    s.dias.add(j.fecha); s.horas += j.horas || 0; s.descanso += j.horas_descanso || 0; if (j.observaciones) s.incidencias++;
    s.jornadas.push(j);
  }
  return Object.values(semanas).map((s) => {
    const limite = emps[s.empleado_id]?.horas_semana || jornadaLegal(Number(s.desde.slice(0, 4)));
    const extra = Math.max(0, s.horas - limite);
    const r2 = (x) => Math.round(x * 100) / 100;
    const conf = db.prepare('SELECT * FROM conformidades WHERE empleado_id=? AND desde=? AND hasta=? ORDER BY id DESC LIMIT 1')
      .get(s.empleado_id, s.desde, s.hasta);
    const resumenHash = sha256(resumenSemana(s.jornadas));
    return { ...s, dias: s.dias.size, horas: r2(s.horas), descanso: r2(s.descanso), jornada_semanal: limite,
      horas_extra: r2(extra), extra_dobles: r2(Math.min(extra, HORAS_EXTRA_DOBLES)), extra_triples: r2(Math.max(0, extra - HORAS_EXTRA_DOBLES)),
      resumen_hash: resumenHash,
      conformidad: conf ? { acuerdo: !!conf.acuerdo, comentario: conf.comentario, fecha: `${fechaLocal(conf.fecha)} ${horaLocal(conf.fecha)}`,
        vigente: conf.resumen_hash === resumenHash, sello: conf.hash.slice(0, 16) } : null };
  }).sort((a, b) => a.desde.localeCompare(b.desde) || a.nombre.localeCompare(b.nombre));
}
// Resumen canónico de una semana: lo que el trabajador confirma con su conformidad.
const resumenSemana = (jornadas) => JSON.stringify(jornadas.map((j) =>
  [j.fecha, j.entrada, j.salida_fecha, j.salida, j.descansos, j.horas]));

// ---------- Tokens de kiosco (QR rotativo) y pases de registro
const ventanaActual = () => Math.floor(Date.now() / 1000 / QR_VENTANA_S);
function tokenKiosco(k, win = ventanaActual()) {
  return `${k.id}.${win}.${hmac(k.secreto, `${k.id}.${win}`).slice(0, 22)}`;
}
function validarTokenKiosco(t) {
  const [id, win, sig] = String(t || '').split('.');
  if (!id || !win || !sig) return null;
  const k = db.prepare('SELECT * FROM kioscos WHERE id=? AND activo=1').get(Number(id));
  if (!k) return null;
  const w = Number(win), cur = ventanaActual();
  if (!(w === cur || w === cur - 1)) return null;          // vigencia: 30–60 s
  const esperado = tokenKiosco(k, w).split('.')[2];
  if (esperado.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(sig))) return null;
  return k;
}
const pases = new Map();   // pase -> { kiosco_id, expira }
setInterval(() => { const n = Date.now(); for (const [k, v] of pases) if (v.expira < n) pases.delete(k); }, 60000).unref();

// ---------- Cookies y sesiones
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('='))
    .filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function esHttps(req) { return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'; }
function setCookie(res, req, nombre, valor, maxAgeS) {
  const partes = [`${nombre}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeS}`];
  if (esHttps(req)) partes.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...prev, partes.join('; ')]);
}
function sesionAdmin(req) {
  const c = cookies(req).adm;
  if (!c) return null;
  const [id, exp, sig] = c.split('.');
  if (!sig || hmac(SECRETO, `adm.${id}.${exp}`) !== sig || Number(exp) < Date.now()) return null;
  return db.prepare('SELECT id, usuario, nombre FROM admins WHERE id=?').get(Number(id)) || null;
}
function dispositivoActual(req) {
  const t = cookies(req).disp;
  if (!t) return null;
  return db.prepare(`SELECT d.id AS dispositivo_id, e.* FROM dispositivos d JOIN empleados e ON e.id=d.empleado_id
    WHERE d.token_hash=? AND d.revocado_en IS NULL AND e.activo=1`).get(sha256(t)) || null;
}
function ip(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress; }

// Límite de intentos de PIN / contraseña
const intentos = new Map();
function bloqueado(clave) { const x = intentos.get(clave); return x && x.hasta > Date.now(); }
function fallo(clave) {
  const x = intentos.get(clave) || { n: 0, hasta: 0 };
  x.n++; if (x.n >= 5) { x.hasta = Date.now() + 15 * 60000; x.n = 0; }
  intentos.set(clave, x);
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function enviarJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function enviarArchivo(res, archivo) {
  const p = path.join(__dirname, 'public', archivo);
  if (!p.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(p)) return enviarJson(res, 404, { error: 'No encontrado' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
}
function enviarCsv(res, nombre, encabezados, filas) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + [encabezados.map((h) => esc(h[1])).join(','),
    ...filas.map((f) => encabezados.map((h) => esc(f[h[0]])).join(','))].join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nombre}"` });
  res.end(csv);
}
async function leerJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 100000) throw new Error('Cuerpo demasiado grande'); }
  return body ? JSON.parse(body) : {};
}
class ErrorHttp extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const exigir = (cond, code, msg) => { if (!cond) throw new ErrorHttp(code, msg); };

function ultimoRegistro(empleadoId) {
  return db.prepare(`SELECT tipo, fecha_hora FROM registros WHERE empleado_id=? AND tipo <> 'ANULACION'
    AND id NOT IN (SELECT ref_id FROM registros WHERE tipo='ANULACION' AND ref_id IS NOT NULL)
    ORDER BY fecha_hora DESC, id DESC LIMIT 1`).get(empleadoId);
}
// Acciones posibles según el último registro; la primera es la sugerida.
function opciones(ult) {
  if (!ult || ult.tipo === 'SALIDA' || Date.now() - new Date(ult.fecha_hora) > 18 * 3600000) return ['ENTRADA', 'SALIDA'];
  if (ult.tipo === 'INICIO_DESCANSO') return ['FIN_DESCANSO', 'SALIDA'];
  return ['SALIDA', 'INICIO_DESCANSO'];   // ENTRADA o FIN_DESCANSO
}
function estado(ult) {
  if (!ult) return 'SIN REGISTRO HOY';
  const vigente = Date.now() - new Date(ult.fecha_hora) < 18 * 3600000;
  if (vigente && ult.tipo === 'INICIO_DESCANSO') return 'EN DESCANSO';
  if (vigente && ult.tipo !== 'SALIDA') return 'DENTRO';
  return fechaLocal(ult.fecha_hora) === hoyLocal() ? 'SALIÓ' : 'SIN REGISTRO HOY';
}
const fmtUlt = (u) => u ? { tipo: u.tipo, nombre_tipo: NOMBRE_TIPO[u.tipo], fecha: fechaLocal(u.fecha_hora), hora: horaLocal(u.fecha_hora) } : null;

const rutas = {
  // ---------- Kiosco
  'GET /api/kiosco/token': (req, res, q) => {
    const k = db.prepare('SELECT * FROM kioscos WHERE clave=? AND activo=1').get(q.get('k') || '');
    exigir(k, 403, 'Clave de kiosco inválida');
    const restante = QR_VENTANA_S - Math.floor(Date.now() / 1000) % QR_VENTANA_S;
    enviarJson(res, 200, { token: tokenKiosco(k), kiosco: k.nombre, empresa: EMPRESA, renovar_en_s: restante,
      hora: horaLocal(ahora()), fecha: hoyLocal() });
  },

  // ---------- Celular del trabajador
  'POST /api/escaneo': async (req, res) => {
    const { t } = await leerJson(req);
    const k = validarTokenKiosco(t);
    exigir(k, 400, 'El código QR expiró o no es válido. Vuelve a escanear el código de la pantalla.');
    const pase = randTok(18);
    pases.set(pase, { kiosco_id: k.id, expira: Date.now() + PASE_MIN * 60000 });
    enviarJson(res, 200, { pase, kiosco: k.nombre, empresa: EMPRESA });
  },
  'GET /api/yo': (req, res) => {
    const e = dispositivoActual(req);
    if (!e) return enviarJson(res, 200, { vinculado: false, empresa: EMPRESA });
    const ult = ultimoRegistro(e.id);
    enviarJson(res, 200, { vinculado: true, empresa: EMPRESA, empleado: { numero: e.numero, nombre: e.nombre, puesto: e.puesto },
      ultimo: fmtUlt(ult), opciones: opciones(ult), nombres: NOMBRE_TIPO });
  },
  'POST /api/vincular': async (req, res) => {
    const { numero, pin } = await leerJson(req);
    const clave = 'pin:' + String(numero || '').trim();
    exigir(!bloqueado(clave), 429, 'Demasiados intentos. Espera 15 minutos.');
    const e = db.prepare('SELECT * FROM empleados WHERE numero=? AND activo=1').get(String(numero || '').trim());
    if (!e || !checkPass(String(pin || ''), e.pin_hash)) { fallo(clave); throw new ErrorHttp(401, 'Número de empleado o NIP incorrecto'); }
    intentos.delete(clave);
    const tok = randTok();
    db.exec('BEGIN');
    // Un solo celular activo por persona: vincular uno nuevo revoca los anteriores.
    db.prepare('UPDATE dispositivos SET revocado_en=? WHERE empleado_id=? AND revocado_en IS NULL').run(ahora(), e.id);
    db.prepare('INSERT INTO dispositivos (empleado_id, token_hash, user_agent, creado_en) VALUES (?,?,?,?)')
      .run(e.id, sha256(tok), req.headers['user-agent'] || '', ahora());
    db.exec('COMMIT');
    bitacora(`empleado:${e.numero}`, 'vincular_dispositivo', { ip: ip(req), ua: req.headers['user-agent'] });
    setCookie(res, req, 'disp', tok, 400 * 86400);
    enviarJson(res, 200, { ok: true });
  },
  'POST /api/desvincular': (req, res) => {
    const e = dispositivoActual(req);
    if (e) {
      db.prepare('UPDATE dispositivos SET revocado_en=? WHERE id=?').run(ahora(), e.dispositivo_id);
      bitacora(`empleado:${e.numero}`, 'desvincular_dispositivo', null);
    }
    setCookie(res, req, 'disp', '', 0);
    enviarJson(res, 200, { ok: true });
  },
  'POST /api/registrar': async (req, res) => {
    const b = await leerJson(req);
    const e = dispositivoActual(req);
    exigir(e, 401, 'Este celular no está vinculado. Ingresa tu número y NIP.');
    const p = pases.get(b.pase);
    exigir(p && p.expira > Date.now(), 400, 'El tiempo para registrar expiró. Vuelve a escanear el código QR.');
    exigir(TIPOS_MARCA.includes(b.tipo), 400, 'Tipo de registro inválido');
    const ult = ultimoRegistro(e.id);
    exigir(!(ult && ult.tipo === b.tipo && Date.now() - new Date(ult.fecha_hora) < DUPLICADO_MIN * 60000), 409,
      `Ya registraste "${NOMBRE_TIPO[b.tipo].toLowerCase()}" hace un momento.`);
    exigir(opciones(ult).includes(b.tipo), 409, `No puedes registrar "${NOMBRE_TIPO[b.tipo].toLowerCase()}" ahora. Vuelve a escanear el código.`);
    pases.delete(b.pase);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const r = insertarRegistro({
      empleado_id: e.id, tipo: b.tipo, origen: 'QR', registrado_por: `empleado:${e.numero}`,
      kiosco_id: p.kiosco_id, dispositivo_id: e.dispositivo_id, ip: ip(req), user_agent: req.headers['user-agent'] || '',
      lat: num(b.lat), lon: num(b.lon), precision_m: num(b.precision),
    });
    enviarJson(res, 200, { ok: true, folio: r.id, tipo: r.tipo, nombre_tipo: NOMBRE_TIPO[r.tipo], fecha: fechaLocal(r.fecha_hora),
      hora: horaLocal(r.fecha_hora), sello: r.hash.slice(0, 12), nombre: e.nombre });
  },
  'GET /api/mis-registros': (req, res) => {
    const e = dispositivoActual(req);
    exigir(e, 401, 'Celular no vinculado');
    const hasta = hoyLocal();
    const desde = sumarDias(hasta, -34);
    const semanas = calcularSemanas(desde, hasta, e.id).reverse().map(({ jornadas, ...s }) => ({
      ...s, cerrada: s.hasta < hasta, jornadas: jornadas.slice().reverse() }));
    enviarJson(res, 200, { nombre: e.nombre, semanas });
  },
  // El trabajador confirma (o hace observaciones a) sus registros de una semana ya terminada.
  'POST /api/conformidad': async (req, res) => {
    const b = await leerJson(req);
    const e = dispositivoActual(req);
    exigir(e, 401, 'Celular no vinculado');
    exigir(/^\d{4}-\d{2}-\d{2}$/.test(b.desde || '') && lunesDe(b.desde) === b.desde, 400, 'Semana inválida');
    const hasta = sumarDias(b.desde, 6);
    exigir(hasta < hoyLocal(), 400, 'Solo puedes confirmar semanas que ya terminaron');
    exigir(b.acuerdo || String(b.comentario || '').trim().length >= 5, 400, 'Escribe tu observación (mín. 5 caracteres)');
    const s = calcularSemanas(b.desde, b.desde, e.id)[0];
    exigir(s, 404, 'No hay registros en esa semana');
    exigir(!(s.conformidad && s.conformidad.vigente), 409, 'Ya respondiste por esta semana');
    const resumen = resumenSemana(s.jornadas), fecha = ahora();
    const hash = sha256([e.id, s.desde, hasta, b.acuerdo ? 1 : 0, b.comentario || '', sha256(resumen), fecha].join('|'));
    db.prepare(`INSERT INTO conformidades (empleado_id, desde, hasta, acuerdo, comentario, resumen, resumen_hash, dispositivo_id, ip, user_agent, fecha, hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.id, s.desde, hasta, b.acuerdo ? 1 : 0, b.acuerdo ? null : String(b.comentario).trim(),
      resumen, sha256(resumen), e.dispositivo_id, ip(req), req.headers['user-agent'] || '', fecha, hash);
    bitacora(`empleado:${e.numero}`, b.acuerdo ? 'conformidad' : 'observacion', { semana: s.desde });
    enviarJson(res, 200, { ok: true, sello: hash.slice(0, 16) });
  },

  // ---------- Administración
  'POST /api/admin/login': async (req, res) => {
    const { usuario, password } = await leerJson(req);
    const clave = 'adm:' + usuario;
    exigir(!bloqueado(clave), 429, 'Demasiados intentos. Espera 15 minutos.');
    const a = db.prepare('SELECT * FROM admins WHERE usuario=?').get(String(usuario || ''));
    if (!a || !checkPass(String(password || ''), a.pass_hash)) { fallo(clave); throw new ErrorHttp(401, 'Usuario o contraseña incorrectos'); }
    const exp = Date.now() + 12 * 3600000;
    setCookie(res, req, 'adm', `${a.id}.${exp}.${hmac(SECRETO, `adm.${a.id}.${exp}`)}`, 12 * 3600);
    bitacora(`admin:${a.usuario}`, 'login', { ip: ip(req) });
    enviarJson(res, 200, { ok: true });
  },
  'POST /api/admin/logout': (req, res) => { setCookie(res, req, 'adm', '', 0); enviarJson(res, 200, { ok: true }); },
};

const rutasAdmin = {
  'GET /api/admin/yo': (req, res, q, a) => enviarJson(res, 200, { usuario: a.usuario, nombre: a.nombre, empresa: EMPRESA, tz: TZ, hoy: hoyLocal(),
    jornada_legal: jornadaLegal(Number(hoyLocal().slice(0, 4))), horas_extra_dobles: HORAS_EXTRA_DOBLES, nombres: NOMBRE_TIPO }),
  'POST /api/admin/password': async (req, res, q, a) => {
    const { actual, nueva } = await leerJson(req);
    const fila = db.prepare('SELECT pass_hash FROM admins WHERE id=?').get(a.id);
    exigir(checkPass(String(actual || ''), fila.pass_hash), 400, 'La contraseña actual no es correcta');
    exigir(String(nueva || '').length >= 8, 400, 'La nueva contraseña debe tener al menos 8 caracteres');
    db.prepare('UPDATE admins SET pass_hash=? WHERE id=?').run(hashPass(nueva), a.id);
    bitacora(`admin:${a.usuario}`, 'cambiar_password', null);
    enviarJson(res, 200, { ok: true });
  },
  'GET /api/admin/admins': (req, res) => enviarJson(res, 200, db.prepare('SELECT id, usuario, nombre, creado_en FROM admins').all()),
  'POST /api/admin/admins': async (req, res, q, a) => {
    const b = await leerJson(req);
    exigir(b.usuario && b.nombre && String(b.password || '').length >= 8, 400, 'Usuario, nombre y contraseña (mín. 8) son obligatorios');
    try {
      db.prepare('INSERT INTO admins (usuario, nombre, pass_hash, creado_en) VALUES (?,?,?,?)').run(b.usuario.trim(), b.nombre.trim(), hashPass(b.password), ahora());
    } catch { throw new ErrorHttp(409, 'Ese usuario ya existe'); }
    bitacora(`admin:${a.usuario}`, 'crear_admin', { usuario: b.usuario });
    enviarJson(res, 200, { ok: true });
  },

  'GET /api/admin/empleados': (req, res) => {
    enviarJson(res, 200, db.prepare(`SELECT e.id, e.numero, e.nombre, e.rfc, e.curp, e.puesto, e.horas_semana, e.activo, e.creado_en,
      (SELECT COUNT(*) FROM dispositivos d WHERE d.empleado_id=e.id AND d.revocado_en IS NULL) AS celular
      FROM empleados e ORDER BY e.activo DESC, e.nombre`).all());
  },
  'POST /api/admin/empleados': async (req, res, q, a) => {
    const b = await leerJson(req);
    exigir(b.numero && b.nombre, 400, 'Número y nombre son obligatorios');
    exigir(/^\d{4,8}$/.test(String(b.pin || '')), 400, 'El NIP debe ser de 4 a 8 dígitos');
    try {
      db.prepare('INSERT INTO empleados (numero, nombre, rfc, curp, puesto, horas_semana, pin_hash, creado_en) VALUES (?,?,?,?,?,?,?,?)')
        .run(String(b.numero).trim(), String(b.nombre).trim(), (b.rfc || '').toUpperCase().trim() || null,
          (b.curp || '').toUpperCase().trim() || null, (b.puesto || '').trim() || null, Number(b.horas_semana) || null, hashPass(b.pin), ahora());
    } catch { throw new ErrorHttp(409, 'Ya existe un empleado con ese número'); }
    bitacora(`admin:${a.usuario}`, 'alta_empleado', { numero: b.numero, nombre: b.nombre });
    enviarJson(res, 200, { ok: true });
  },
  'POST /api/admin/empleados/editar': async (req, res, q, a) => {
    const b = await leerJson(req);
    const e = db.prepare('SELECT * FROM empleados WHERE id=?').get(Number(b.id));
    exigir(e, 404, 'Empleado no encontrado');
    if (b.pin !== undefined && b.pin !== '') {
      exigir(/^\d{4,8}$/.test(String(b.pin)), 400, 'El NIP debe ser de 4 a 8 dígitos');
      db.prepare('UPDATE empleados SET pin_hash=? WHERE id=?').run(hashPass(b.pin), e.id);
    }
    db.prepare('UPDATE empleados SET nombre=?, rfc=?, curp=?, puesto=?, horas_semana=?, activo=? WHERE id=?').run(
      (b.nombre ?? e.nombre).trim(), (b.rfc ?? e.rfc ?? '').toUpperCase().trim() || null,
      (b.curp ?? e.curp ?? '').toUpperCase().trim() || null, (b.puesto ?? e.puesto ?? '').trim() || null, b.horas_semana === undefined ? e.horas_semana : (Number(b.horas_semana) || null),
      b.activo === undefined ? e.activo : (b.activo ? 1 : 0), e.id);
    if (b.revocar_celular || b.activo === false)
      db.prepare('UPDATE dispositivos SET revocado_en=? WHERE empleado_id=? AND revocado_en IS NULL').run(ahora(), e.id);
    bitacora(`admin:${a.usuario}`, 'editar_empleado', { id: e.id, numero: e.numero,
      cambios: Object.keys(b).filter((k) => k !== 'id' && k !== 'pin').concat(b.pin ? ['pin'] : []) });
    enviarJson(res, 200, { ok: true });
  },

  'GET /api/admin/kioscos': (req, res) => enviarJson(res, 200, db.prepare('SELECT id, nombre, clave, activo, creado_en FROM kioscos').all()),
  'POST /api/admin/kioscos': async (req, res, q, a) => {
    const b = await leerJson(req);
    exigir(b.nombre, 400, 'Indica el nombre del kiosco (ej. "Entrada principal")');
    db.prepare('INSERT INTO kioscos (nombre, clave, secreto, creado_en) VALUES (?,?,?,?)').run(b.nombre.trim(), randTok(12), randTok(32), ahora());
    bitacora(`admin:${a.usuario}`, 'alta_kiosco', { nombre: b.nombre });
    enviarJson(res, 200, { ok: true });
  },
  'POST /api/admin/kioscos/estado': async (req, res, q, a) => {
    const b = await leerJson(req);
    db.prepare('UPDATE kioscos SET activo=? WHERE id=?').run(b.activo ? 1 : 0, Number(b.id));
    bitacora(`admin:${a.usuario}`, b.activo ? 'activar_kiosco' : 'desactivar_kiosco', { id: b.id });
    enviarJson(res, 200, { ok: true });
  },

  'GET /api/admin/presentes': (req, res) => {
    const emps = db.prepare('SELECT id, numero, nombre, puesto FROM empleados WHERE activo=1 ORDER BY nombre').all();
    enviarJson(res, 200, emps.map((e) => {
      const u = ultimoRegistro(e.id);
      return { ...e, estado: estado(u), ultimo: fmtUlt(u) };
    }));
  },
  'GET /api/admin/registros': (req, res, q) => enviarJson(res, 200, consultarRegistros(q)),
  'GET /api/admin/jornadas': (req, res, q) => {
    const r = rangoUtc(q.get('desde'), q.get('hasta'));
    exigir(r, 400, 'Rango de fechas inválido');
    enviarJson(res, 200, calcularJornadas(r[0], r[1], q.get('empleado_id')));
  },
  'POST /api/admin/correccion': async (req, res, q, a) => {
    const b = await leerJson(req);
    exigir(String(b.motivo || '').trim().length >= 5, 400, 'Describe el motivo de la corrección (mín. 5 caracteres)');
    let r;
    if (b.anular_id) {
      const orig = db.prepare('SELECT * FROM registros WHERE id=?').get(Number(b.anular_id));
      exigir(orig && orig.tipo !== 'ANULACION', 404, 'Registro no encontrado');
      exigir(!db.prepare("SELECT 1 FROM registros WHERE tipo='ANULACION' AND ref_id=?").get(orig.id), 409, 'Ese registro ya fue anulado');
      r = insertarRegistro({ empleado_id: orig.empleado_id, tipo: 'ANULACION', origen: 'CORRECCION', ref_id: orig.id,
        registrado_por: `admin:${a.usuario}`, motivo: b.motivo.trim(), ip: ip(req), user_agent: req.headers['user-agent'] || '' });
    } else {
      exigir(TIPOS_MARCA.includes(b.tipo), 400, 'Tipo inválido');
      const e = db.prepare('SELECT * FROM empleados WHERE id=?').get(Number(b.empleado_id));
      exigir(e, 404, 'Empleado no encontrado');
      const f = localAUtc(b.fecha_hora);
      exigir(f && f.getTime() <= Date.now(), 400, 'Fecha y hora inválidas (no pueden ser futuras)');
      r = insertarRegistro({ empleado_id: e.id, tipo: b.tipo, fecha_hora: f.toISOString(), origen: 'CORRECCION',
        registrado_por: `admin:${a.usuario}`, motivo: b.motivo.trim(), ip: ip(req), user_agent: req.headers['user-agent'] || '' });
    }
    enviarJson(res, 200, { ok: true, folio: r.id });
  },
  'GET /api/admin/integridad': (req, res) => enviarJson(res, 200, verificarCadena()),
  'GET /api/admin/bitacora': (req, res) => enviarJson(res, 200, db.prepare('SELECT * FROM bitacora ORDER BY id DESC LIMIT 300').all()
    .map((b) => ({ ...b, fecha_local: `${fechaLocal(b.fecha)} ${horaLocal(b.fecha)}` }))),

  'GET /api/admin/export/jornadas.csv': (req, res, q) => {
    const r = rangoUtc(q.get('desde'), q.get('hasta'));
    exigir(r, 400, 'Rango inválido');
    const filas = calcularJornadas(r[0], r[1], q.get('empleado_id'));
    const emp = Object.fromEntries(db.prepare('SELECT id, rfc, curp FROM empleados').all().map((e) => [e.id, e]));
    enviarCsv(res, `jornadas_${q.get('desde')}_${q.get('hasta')}.csv`,
      [['numero', 'No. empleado'], ['nombre', 'Nombre'], ['rfc', 'RFC'], ['curp', 'CURP'], ['fecha', 'Fecha'], ['entrada', 'Hora entrada'],
        ['salida_fecha', 'Fecha salida'], ['salida', 'Hora salida'], ['descansos', 'Descansos'], ['horas_presencia', 'Horas en centro de trabajo'], ['horas_descanso', 'Horas de descanso'], ['horas', 'Horas efectivas'], ['observaciones', 'Observaciones']],
      filas.map((f) => ({ ...f, rfc: emp[f.empleado_id]?.rfc, curp: emp[f.empleado_id]?.curp })));
  },
  'GET /api/admin/semanas': (req, res, q) =>
    enviarJson(res, 200, calcularSemanas(q.get('desde'), q.get('hasta'), q.get('empleado_id')).map(({ jornadas, ...s }) => s)),
  'GET /api/admin/export/semanas.csv': (req, res, q) => {
    const filas = calcularSemanas(q.get('desde'), q.get('hasta'), q.get('empleado_id')).map((s) => ({ ...s,
      conf: !s.conformidad ? 'Pendiente' : !s.conformidad.vigente ? 'Registros cambiaron después de confirmar'
        : s.conformidad.acuerdo ? `De acuerdo (${s.conformidad.fecha})` : `Observación: ${s.conformidad.comentario}` }));
    enviarCsv(res, `horas_extra_${q.get('desde')}_${q.get('hasta')}.csv`,
      [['numero', 'No. empleado'], ['nombre', 'Nombre'], ['desde', 'Semana del'], ['hasta', 'al'], ['dias', 'Días'],
        ['horas', 'Horas efectivas'], ['descanso', 'Horas de descanso'], ['jornada_semanal', 'Jornada semanal'], ['horas_extra', 'Horas extra'],
        ['extra_dobles', 'Extra al doble'], ['extra_triples', 'Extra al triple'], ['incidencias', 'Incidencias'], ['conf', 'Conformidad del trabajador']],
      filas);
  },
  // Reporte imprimible (Imprimir → Guardar como PDF) con espacio para firmas
  'GET /api/admin/reporte': (req, res, q, a) => {
    const e = db.prepare('SELECT * FROM empleados WHERE id=?').get(Number(q.get('empleado_id')));
    exigir(e, 404, 'Selecciona un empleado');
    const semanas = calcularSemanas(q.get('desde'), q.get('hasta'), e.id);
    const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tot = semanas.reduce((t, s) => ({ horas: t.horas + s.horas, extra: t.extra + s.horas_extra, d: t.d + s.extra_dobles, t: t.t + s.extra_triples }),
      { horas: 0, extra: 0, d: 0, t: 0 });
    const generado = ahora();
    const sello = sha256(JSON.stringify([e.id, semanas.map((s) => [s.desde, s.resumen_hash]), generado]));
    const confTxt = (c) => !c ? 'Pendiente de confirmar por el trabajador' : !c.vigente ? 'Los registros cambiaron después de su confirmación'
      : c.acuerdo ? `Confirmada de conformidad por el trabajador el ${c.fecha} (sello ${c.sello})` : `Con observación del trabajador (${c.fecha}): “${h(c.comentario)}”`;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Registro de jornada · ${h(e.nombre)}</title>
<style>body{font:12px/1.4 system-ui,sans-serif;color:#111;margin:24px}h1{font-size:18px;margin:0}h2{font-size:13px;margin:18px 0 6px}
table{width:100%;border-collapse:collapse;margin-top:4px}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}th{background:#f0f0f0}
td.n,th.n{text-align:right}.datos td{border:none;padding:2px 8px 2px 0}.conf{font-size:11px;margin:4px 0 0;color:#333}
.firmas{display:flex;gap:60px;margin-top:60px}.firmas div{flex:1;border-top:1px solid #000;text-align:center;padding-top:4px}
.pie{margin-top:24px;font-size:10px;color:#555}.noimp{margin-bottom:16px}@media print{.noimp{display:none}body{margin:0}}</style></head><body>
<div class="noimp"><button onclick="print()">Imprimir / Guardar como PDF</button></div>
<h1>Registro electrónico de jornada laboral</h1><div>${h(EMPRESA)} · Art. 132, fr. XXXIV, Ley Federal del Trabajo</div>
<table class="datos" style="width:auto;margin-top:10px"><tr><td><b>Persona trabajadora:</b> ${h(e.nombre)}</td><td><b>No.:</b> ${h(e.numero)}</td></tr>
<tr><td><b>RFC:</b> ${h(e.rfc || '—')}</td><td><b>CURP:</b> ${h(e.curp || '—')}</td></tr><tr><td><b>Puesto:</b> ${h(e.puesto || '—')}</td>
<td><b>Periodo:</b> ${h(semanas[0]?.desde || q.get('desde'))} al ${h(semanas.at(-1)?.hasta || q.get('hasta'))}</td></tr></table>
${semanas.map((s) => `<h2>Semana del ${s.desde} al ${s.hasta}</h2>
<table><tr><th>Fecha</th><th>Entrada</th><th>Salida</th><th>Descansos</th><th class="n">Horas efectivas</th><th>Observaciones</th></tr>
${s.jornadas.map((j) => `<tr><td>${j.fecha}</td><td>${j.entrada || '—'}</td><td>${j.salida ? j.salida + (j.salida_fecha !== j.fecha ? ` (${j.salida_fecha})` : '') : '—'}</td>
<td>${h(j.descansos || '—')}</td><td class="n">${j.horas ?? '—'}</td><td>${h(j.observaciones)}</td></tr>`).join('')}
<tr><th colspan="4">Total semana · jornada semanal ${s.jornada_semanal} h · extra ${s.horas_extra} h (doble ${s.extra_dobles}, triple ${s.extra_triples})</th><th class="n">${s.horas}</th><th></th></tr></table>
<p class="conf">${confTxt(s.conformidad)}</p>`).join('') || '<p>Sin registros en el periodo.</p>'}
<h2>Resumen del periodo</h2><table style="width:auto"><tr><th>Horas efectivas</th><th>Horas extra</th><th>Al doble</th><th>Al triple</th></tr>
<tr><td class="n">${tot.horas.toFixed(2)}</td><td class="n">${tot.extra.toFixed(2)}</td><td class="n">${tot.d.toFixed(2)}</td><td class="n">${tot.t.toFixed(2)}</td></tr></table>
<div class="firmas"><div>${h(e.nombre)}<br>Persona trabajadora</div><div>Nombre y firma<br>Representante del patrón</div></div>
<p class="pie">Generado el ${fechaLocal(generado)} ${horaLocal(generado)} (${h(TZ)}) por ${h(a.usuario)}. Sello del reporte: ${sello}.<br>
Horas extra calculadas sobre la jornada semanal (${HORAS_EXTRA_DOBLES} h por semana al doble y el excedente al triple, art. 68 LFT). El cálculo es informativo; verifique contra el contrato y la normativa vigente.</p>
</body></html>`;
    bitacora(`admin:${a.usuario}`, 'reporte', { empleado: e.numero, desde: q.get('desde'), hasta: q.get('hasta'), sello });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  },
  'GET /api/admin/export/registros.csv': (req, res, q) => {
    enviarCsv(res, `registros_${q.get('desde')}_${q.get('hasta')}.csv`,
      [['id', 'Folio'], ['numero', 'No. empleado'], ['nombre', 'Nombre'], ['tipo', 'Tipo'], ['fecha', 'Fecha'], ['hora', 'Hora'],
        ['origen', 'Origen'], ['registrado_por', 'Registrado por'], ['kiosco', 'Kiosco'], ['ref_id', 'Anula folio'],
        ['motivo', 'Motivo'], ['ip', 'IP'], ['lat', 'Latitud'], ['lon', 'Longitud'], ['capturado', 'Capturado en'], ['hash', 'Sello (SHA-256)']],
      consultarRegistros(q));
  },
};

function consultarRegistros(q) {
  const r = rangoUtc(q.get('desde'), q.get('hasta'));
  exigir(r, 400, 'Rango de fechas inválido');
  const params = [r[0], r[1]];
  let sql = `SELECT r.*, e.numero, e.nombre, k.nombre AS kiosco,
    (SELECT a.id FROM registros a WHERE a.tipo='ANULACION' AND a.ref_id=r.id) AS anulado_por
    FROM registros r JOIN empleados e ON e.id=r.empleado_id LEFT JOIN kioscos k ON k.id=r.kiosco_id
    WHERE r.fecha_hora >= ? AND r.fecha_hora < ?`;
  if (q.get('empleado_id')) { sql += ' AND r.empleado_id=?'; params.push(Number(q.get('empleado_id'))); }
  sql += ' ORDER BY r.fecha_hora DESC, r.id DESC';
  return db.prepare(sql).all(...params).map((x) => ({ ...x, fecha: fechaLocal(x.fecha_hora), hora: horaLocal(x.fecha_hora),
    capturado: `${fechaLocal(x.capturado_en)} ${horaLocal(x.capturado_en)}` }));
}

const paginas = { '/': 'admin.html', '/admin': 'admin.html', '/kiosco': 'kiosco.html', '/r': 'registro.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (req.method === 'GET' && paginas[url.pathname]) return enviarArchivo(res, paginas[url.pathname]);
    if (req.method === 'GET' && url.pathname.startsWith('/static/')) return enviarArchivo(res, url.pathname.slice(8));
    const clave = `${req.method} ${url.pathname}`;
    if (rutas[clave]) return await rutas[clave](req, res, url.searchParams);
    if (rutasAdmin[clave]) {
      const a = sesionAdmin(req);
      exigir(a, 401, 'Sesión de administrador requerida');
      if (req.method === 'POST') {   // protección CSRF básica
        const origen = req.headers.origin;
        exigir(!origen || new URL(origen).host === req.headers.host, 403, 'Origen no permitido');
      }
      return await rutasAdmin[clave](req, res, url.searchParams, a);
    }
    enviarJson(res, 404, { error: 'No encontrado' });
  } catch (e) {
    if (e instanceof ErrorHttp) return enviarJson(res, e.code, { error: e.message });
    if (e instanceof SyntaxError) return enviarJson(res, 400, { error: 'JSON inválido' });
    console.error(e);
    enviarJson(res, 500, { error: 'Error interno' });
  }
});

server.listen(PORT, () => {
  console.log(`Checador QR escuchando en http://localhost:${PORT}  (zona horaria: ${TZ})`);
  console.log(`Panel de administración: http://localhost:${PORT}/admin`);
});
