// =============================================================
//  CONTROL DE TRANSPORTE DINMEC  -  Servidor (Node.js puro, sin dependencias)
//  Bitácora digital de salidas de unidades, gasolina e incidentes - 2026
//
//  Arranca con: node server.js   (o doble clic en INICIAR.bat)
//  Base de datos integrada (node:sqlite). No requiere instalar nada.
// =============================================================

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");

// En la nube se usan variables de entorno (PORT y DIR_DATOS); en local, los valores por defecto.
const PUERTO = process.env.PORT || 3500;
const DIR = __dirname;
const DIR_DATOS = process.env.DIR_DATOS || path.join(DIR, "data");
const DIR_FOTOS = path.join(DIR_DATOS, "uploads");
const DIR_PUBLIC = path.join(DIR, "public");
fs.mkdirSync(DIR_FOTOS, { recursive: true });

// ---------- Base de datos ----------
const db = new DatabaseSync(path.join(DIR_DATOS, "transporte.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS viajes (
    id TEXT PRIMARY KEY,
    folio TEXT,
    descripcion TEXT,
    solicitante TEXT, firma_solicitante TEXT,
    fecha_salida TEXT, hora_salida TEXT,
    fecha_regreso TEXT,                -- fecha estimada de regreso (si el viaje dura más de 1 día)
    fecha_regreso_real TEXT, hora_regreso TEXT,
    unidad TEXT,
    operador TEXT, firma_operador TEXT,
    recibe_carga TEXT, firma_recibe TEXT,
    observaciones TEXT,
    estado TEXT,                       -- 'en_curso' | 'finalizado'
    creado TEXT, creado_por TEXT,
    actualizado TEXT, actualizado_por TEXT
  );
  CREATE TABLE IF NOT EXISTS fotos (
    id TEXT PRIMARY KEY,
    ref_id TEXT,
    tipo TEXT DEFAULT 'viaje',         -- 'viaje' | 'carga' | 'incidente'
    categoria TEXT DEFAULT '',         -- para gasolina: 'bomba' | 'kilometraje' | 'ticket'
    archivo TEXT, nombre_original TEXT, subido TEXT, subido_por TEXT
  );
  CREATE TABLE IF NOT EXISTS cargas (
    id TEXT PRIMARY KEY,
    fecha TEXT, hora TEXT,
    unidad TEXT,
    lugar TEXT,                        -- dónde se realiza la carga
    tipo_pago TEXT,                    -- 'efectivo' | 'tarjeta'
    operador TEXT, firma_operador TEXT,
    observaciones TEXT,
    creado TEXT, creado_por TEXT,
    actualizado TEXT, actualizado_por TEXT
  );
  CREATE TABLE IF NOT EXISTS incidentes (
    id TEXT PRIMARY KEY,
    fecha TEXT, hora TEXT,
    unidad TEXT,
    descripcion TEXT,                  -- falla o percance
    reporta TEXT,
    creado TEXT, creado_por TEXT,
    actualizado TEXT, actualizado_por TEXT
  );
  CREATE TABLE IF NOT EXISTS unidades (
    id TEXT PRIMARY KEY,
    nombre TEXT UNIQUE,
    activo INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    usuario TEXT UNIQUE, nombre TEXT, rol TEXT,
    clave TEXT,            -- hash scrypt (salt:hash)
    rol_app TEXT,          -- 'admin' | 'supervisor' | 'operador'
    creado TEXT
  );
  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    usuario_id TEXT, creado TEXT, expira TEXT
  );
  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );
`);

// ---------- Configuración guardada (avisos de WhatsApp, etc.) ----------
function leerConfig(clave, fallback) {
  const r = db.prepare("SELECT valor FROM config WHERE clave=?").get(clave);
  if (!r) return fallback;
  try { return JSON.parse(r.valor); } catch { return fallback; }
}
function guardarConfig(clave, v) {
  db.prepare("INSERT INTO config (clave,valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor")
    .run(clave, JSON.stringify(v));
}

// ---- Migraciones: actualizan bases creadas con versiones anteriores, sin perder datos ----
function colExiste(tabla, col) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === col);
}
if (colExiste("fotos", "viaje_id")) {
  db.exec("ALTER TABLE fotos RENAME COLUMN viaje_id TO ref_id");
}
if (!colExiste("fotos", "tipo")) db.exec("ALTER TABLE fotos ADD COLUMN tipo TEXT DEFAULT 'viaje'");
if (!colExiste("fotos", "categoria")) db.exec("ALTER TABLE fotos ADD COLUMN categoria TEXT DEFAULT ''");
// Entrega y retorno de llaves
for (const col of ["llaves_entrega_por", "llaves_recibe", "firma_llaves_salida", "llaves_devuelve_a", "firma_llaves_regreso"]) {
  if (!colExiste("viajes", col)) db.exec(`ALTER TABLE viajes ADD COLUMN ${col} TEXT DEFAULT ''`);
}
// Kilometrajes del viaje, viáticos, gastos y registros de tráfico (JSON)
for (const col of ["km_inicial", "km_final", "viaticos_asignados", "gastos", "traficos"]) {
  if (!colExiste("viajes", col)) db.exec(`ALTER TABLE viajes ADD COLUMN ${col} TEXT DEFAULT ''`);
}
// Fondo de emergencias, TAG y tarjeta asignada
for (const col of ["emergencias_asignadas", "tag_digitos", "tc_banco", "tc_digitos"]) {
  if (!colExiste("viajes", col)) db.exec(`ALTER TABLE viajes ADD COLUMN ${col} TEXT DEFAULT ''`);
}
// Casetas del viaje (JSON: [{id, ubicacion, monto, pago}])
if (!colExiste("viajes", "casetas")) db.exec("ALTER TABLE viajes ADD COLUMN casetas TEXT DEFAULT ''");
// Kilometraje, nivel de combustible y costo en cargas de gasolina
if (!colExiste("cargas", "kilometraje")) db.exec("ALTER TABLE cargas ADD COLUMN kilometraje TEXT DEFAULT ''");
if (!colExiste("cargas", "nivel_combustible")) db.exec("ALTER TABLE cargas ADD COLUMN nivel_combustible TEXT DEFAULT ''");
if (!colExiste("cargas", "costo")) db.exec("ALTER TABLE cargas ADD COLUMN costo TEXT DEFAULT ''");
// Ficha de flota por unidad: servicio, verificación vehicular, póliza de seguro y GPS vinculado
for (const col of ["servicio_km", "servicio_fecha", "verif_ultima", "verif_vence", "poliza_aseguradora", "poliza_numero", "poliza_vence", "gps_imei"]) {
  if (!colExiste("unidades", col)) db.exec(`ALTER TABLE unidades ADD COLUMN ${col} TEXT DEFAULT ''`);
}

// Unidades iniciales (el administrador puede agregar más desde la app)
const hayUnidades = db.prepare("SELECT COUNT(*) c FROM unidades").get().c > 0;
if (!hayUnidades) {
  const ins = db.prepare("INSERT INTO unidades (id,nombre,activo) VALUES (?,?,1)");
  ins.run(crypto.randomUUID(), "OROCH");
  ins.run(crypto.randomUUID(), "NISSAN");
}

// ---------- Utilidades ----------
const ahora = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

// ---------- Zona horaria de la planta ----------
// El servidor puede vivir en otro huso horario (ej. Render usa UTC).
// Todas las fechas/horas capturadas son hora de México centro (UTC-6, sin horario de verano).
const TZ_OFFSET = process.env.TZ_OFFSET || "-06:00";
const TZ_MS = (() => {
  const m = TZ_OFFSET.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return -6 * 3600000;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600000 + Number(m[3]) * 60000);
})();
// Convierte "fecha de la planta" + "hora de la planta" al instante real (ms)
function msDePlanta(fecha, hora) {
  return new Date(fecha + "T" + (hora || "00:00") + ":00" + TZ_OFFSET).getTime();
}
// La fecha de HOY según el reloj de la planta (no el del servidor)
function hoyPlanta() {
  const d = new Date(Date.now() + TZ_MS);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};
function leerCuerpo(req, limite = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limite) { reject(new Error("Archivo demasiado grande")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function ipsLocales() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const nombre of Object.keys(ifaces)) {
    for (const ni of ifaces[nombre]) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// Folio consecutivo por año: TR-2026-001
function nuevoFolio() {
  const anio = hoyPlanta().slice(0, 4);
  const pref = `TR-${anio}-`;
  const filas = db.prepare("SELECT folio FROM viajes WHERE folio LIKE ?").all(pref + "%");
  let max = 0;
  for (const f of filas) {
    const n = parseInt((f.folio || "").slice(pref.length), 10);
    if (n > max) max = n;
  }
  return pref + String(max + 1).padStart(3, "0");
}

// ---------- Seguridad: contraseñas, cookies y sesiones ----------
function hashClave(pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pass, salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verificarClave(pass, guardado) {
  try {
    const [salt, hash] = guardado.split(":");
    const h = crypto.scryptSync(pass, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hash, "hex"));
  } catch { return false; }
}
function leerCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("="); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function crearSesion(usuarioId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expira = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sesiones (token,usuario_id,creado,expira) VALUES (?,?,?,?)").run(token, usuarioId, ahora(), expira);
  return token;
}
function usuarioDeSesion(req) {
  const tok = leerCookies(req)["ct_sesion"];
  if (!tok) return null;
  const s = db.prepare("SELECT * FROM sesiones WHERE token=?").get(tok);
  if (!s) return null;
  if (s.expira && s.expira < ahora()) { db.prepare("DELETE FROM sesiones WHERE token=?").run(tok); return null; }
  return db.prepare("SELECT id,usuario,nombre,rol,rol_app FROM usuarios WHERE id=?").get(s.usuario_id) || null;
}
function hayUsuarios() {
  return db.prepare("SELECT COUNT(*) c FROM usuarios").get().c > 0;
}
// Puede capturar/editar salidas (el operador solo registra el regreso)
const esAdmin = (u) => u && u.rol_app === "admin";
const esSupervisor = (u) => u && (u.rol_app === "admin" || u.rol_app === "supervisor");

// ---------- Avisos por WhatsApp (CallMeBot, igual que el Monitor) ----------
function enviarWhatsApp(phone, apikey, texto) {
  return new Promise((resolve) => {
    const u = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(phone) +
      "&apikey=" + encodeURIComponent(apikey) + "&text=" + encodeURIComponent(texto);
    const r = https.get(u, { timeout: 20000 }, (resp) => {
      let cuerpo = "";
      resp.on("data", (c) => cuerpo += c);
      resp.on("end", () => resolve({ ok: resp.statusCode === 200 && !/ERROR|blocked|Invalid/i.test(cuerpo.slice(0, 500)), detalle: cuerpo.slice(0, 200) }));
    });
    r.on("error", (e) => resolve({ ok: false, detalle: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ ok: false, detalle: "timeout" }); });
  });
}
// Manda un JSON a un webhook (ej. n8n) que se encarga de enviar el WhatsApp
function enviarWebhook(urlWebhook, datos) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlWebhook);
      const lib = u.protocol === "https:" ? https : http;
      const cuerpo = JSON.stringify(datos);
      const r = lib.request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(cuerpo) }, timeout: 15000 }, (resp) => {
        let b = "";
        resp.on("data", (c) => b += c);
        resp.on("end", () => resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, estatus: resp.statusCode, detalle: b.slice(0, 200) }));
      });
      r.on("error", (e) => resolve({ ok: false, detalle: e.message }));
      r.on("timeout", () => { r.destroy(); resolve({ ok: false, detalle: "timeout" }); });
      r.end(cuerpo);
    } catch (e) { resolve({ ok: false, detalle: e.message }); }
  });
}

async function avisarNuevaSalida(v) {
  const texto = "🚚 DINMEC - Nueva salida " + v.folio +
    "\nUnidad: " + (v.unidad || "-") +
    "\nOperador: " + (v.operador || "-") +
    "\nActividad: " + (v.descripcion || "").slice(0, 150) +
    "\nSalida: " + v.fecha_salida + " " + (v.hora_salida || "") +
    "\nSolicitó: " + (v.solicitante || "-");
  // 1) Webhook de n8n (si está configurado): n8n reparte el WhatsApp con su número vinculado
  const webhook = leerConfig("whatsapp_webhook", "");
  if (webhook) {
    // Las plantillas de Meta no aceptan saltos de línea en las variables: todo en una sola línea
    const plano = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max || 200) || "-";
    const r = await enviarWebhook(webhook, {
      evento: "nueva_salida", mensaje: texto,
      folio: plano(v.folio, 30), unidad: plano(v.unidad, 40), operador: plano(v.operador, 60),
      descripcion: plano(v.descripcion, 150),
      fecha_salida: plano(v.fecha_salida, 20), hora_salida: plano(v.hora_salida, 10),
      salida: plano((v.fecha_salida || "") + " " + (v.hora_salida || ""), 30),
      solicitante: plano(v.solicitante, 60),
    });
    console.log("Webhook n8n nueva salida: " + (r.ok ? "enviado" : "FALLO " + r.detalle));
  }
  // 2) Números de CallMeBot (si hay)
  const numeros = leerConfig("whatsapp_numeros", []);
  for (const n of numeros) {
    if (!n.phone || !n.apikey) continue;
    try {
      const r = await enviarWhatsApp(n.phone, n.apikey, texto);
      console.log("WhatsApp nueva salida a " + n.phone + ": " + (r.ok ? "enviado" : "FALLO " + r.detalle));
    } catch (e) { console.log("WhatsApp error: " + e.message); }
  }
}

// ---------- Sincronizacion en vivo (SSE) ----------
const clientesSSE = new Set();
function avisarCambio(refId, motivo) {
  const msg = `data: ${JSON.stringify({ refId, motivo, t: ahora() })}\n\n`;
  for (const c of clientesSSE) { try { c.write(msg); } catch (_) {} }
}

// ---------- Registros completos (con fotos) ----------
function fotosDe(tipo, refId) {
  return db.prepare("SELECT * FROM fotos WHERE tipo=? AND ref_id=? ORDER BY subido").all(tipo, refId)
    .map((f) => ({ id: f.id, url: "/foto/" + f.archivo, nombre: f.nombre_original, categoria: f.categoria || "", subido: f.subido, subido_por: f.subido_por }));
}
function obtenerViaje(id) {
  const v = db.prepare("SELECT * FROM viajes WHERE id=?").get(id);
  if (!v) return null;
  return { ...v, fotos: fotosDe("viaje", id) };
}
function obtenerCarga(id) {
  const c = db.prepare("SELECT * FROM cargas WHERE id=?").get(id);
  if (!c) return null;
  return { ...c, fotos: fotosDe("carga", id) };
}
function obtenerIncidente(id) {
  const i = db.prepare("SELECT * FROM incidentes WHERE id=?").get(id);
  if (!i) return null;
  return { ...i, fotos: fotosDe("incidente", id) };
}

// Campos que cada rol puede modificar en un viaje
const CAMPOS_REGRESO = [
  "fecha_regreso_real", "hora_regreso", "recibe_carga", "firma_recibe", "firma_operador",
  "llaves_devuelve_a", "firma_llaves_regreso", "km_inicial", "km_final", "gastos", "traficos", "casetas",
  "observaciones", "estado",
];
const CAMPOS_SUPERVISOR = [
  "descripcion", "solicitante", "firma_solicitante", "hora_salida", "fecha_regreso",
  "unidad", "operador", "llaves_entrega_por", "llaves_recibe", "firma_llaves_salida",
  "km_inicial", "viaticos_asignados", "emergencias_asignadas", "tag_digitos", "tc_banco", "tc_digitos",
  ...CAMPOS_REGRESO,
];
const CAMPOS_ADMIN = ["fecha_salida", ...CAMPOS_SUPERVISOR];

const CAMPOS_CARGA = ["fecha", "hora", "unidad", "lugar", "tipo_pago", "kilometraje", "nivel_combustible", "costo", "operador", "firma_operador", "observaciones"];
const CAMPOS_UNIDAD = ["servicio_km", "servicio_fecha", "verif_ultima", "verif_vence", "poliza_aseguradora", "poliza_numero", "poliza_vence", "gps_imei"];
const SERVICIO_CADA_KM = 10000;

// ---------- Conexión con el Monitor DINMEC (GPS) ----------
const https = require("node:https");
function leerMonitor(rutaMonitor) {
  const monitorURL = process.env.MONITOR_URL || "http://localhost:3400";
  const lib = monitorURL.startsWith("https") ? https : http;
  const cabeceras = { "ngrok-skip-browser-warning": "1" };
  // Cuando la app corre en la nube, el Monitor pide su token de acceso
  if (process.env.MONITOR_TOKEN) cabeceras["x-monitor-token"] = process.env.MONITOR_TOKEN;
  return new Promise((resolve, reject) => {
    const r = lib.get(monitorURL + rutaMonitor, { timeout: 8000, headers: cabeceras }, (resp) => {
      let cuerpo = "";
      resp.on("data", (c) => cuerpo += c);
      resp.on("end", () => { try { resolve(JSON.parse(cuerpo)); } catch (e) { reject(e); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
  });
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function listaFechas(desde, hasta, max = 8) {
  const out = [];
  const d = new Date(desde + "T12:00");
  const fin = new Date(hasta + "T12:00");
  while (d <= fin && out.length < max) {
    out.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ==========================================================================
//  GPS INTEGRADO: la app lee Tracksolid directamente (igual que el Monitor
//  DINMEC) para que el GPS funcione 24/7 en la nube SIN depender de la PC.
//  Se activa al registrar vehículos (config "gps_vehiculos"); si no hay,
//  se usa el Monitor externo (MONITOR_URL) como antes.
// ==========================================================================
const DIR_POSICIONES = path.join(DIR_DATOS, "positions");
const ARCHIVO_PARADAS_GPS = path.join(DIR_DATOS, "gps-paradas.json");
const GPS_STOP_KMH = 3, GPS_DRIFT_M = 300, GPS_STALE_MIN = 15, GPS_MIN_PARADA_MIN = 5, GPS_POLL_SEG = 60;

let gpsParadas = [];
try { gpsParadas = JSON.parse(fs.readFileSync(ARCHIVO_PARADAS_GPS, "utf8")); } catch (_) {}
const _gpsEstado = {};
function gpsVehiculos() { return leerConfig("gps_vehiculos", []); }
function gpsSt(imei) {
  if (!_gpsEstado[imei]) _gpsEstado[imei] = { cookie: null, fix: null, lastGpsTime: 0, lastSeen: 0, stop: null, errors: 0 };
  return _gpsEstado[imei];
}
// al arrancar, retomar paradas que quedaron abiertas
for (const p of gpsParadas) if (!p.fin) { const st = gpsSt(p.imei); st.stop = { inicio: p.inicio, lat: p.lat, lng: p.lng, registroId: p.id }; }
function guardarParadasGPS() { try { fs.writeFileSync(ARCHIVO_PARADAS_GPS, JSON.stringify(gpsParadas)); } catch (_) {} }
function fechaPlantaDe(ms) {
  const d = new Date(ms + TZ_MS);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

function httpGetSimple(urlStr, headers, redirs) {
  redirs = redirs || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === "https:" ? https : http;
    const r = lib.get(u, { headers: headers || {}, timeout: 20000 }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && redirs < 3) {
        resp.resume();
        return resolve(httpGetSimple(new URL(resp.headers.location, urlStr).toString(), headers, redirs + 1));
      }
      let cuerpo = "";
      resp.on("data", (c) => cuerpo += c);
      resp.on("end", () => resolve({ status: resp.statusCode, headers: resp.headers, body: cuerpo }));
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
  });
}
async function gpsRefrescarCookie(v) {
  const r = await httpGetSimple(v.shareUrl, { "User-Agent": "Mozilla/5.0" });
  const setc = r.headers["set-cookie"] || [];
  const cookie = setc.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("sin cookie (¿enlace de Tracksolid vencido?)");
  gpsSt(v.imei).cookie = cookie;
}
async function gpsConsultar(v) {
  const st = gpsSt(v.imei);
  if (!st.cookie) await gpsRefrescarCookie(v);
  const url = "https://us.tracksolidpro.com/getStatus?imei=" + v.imei + "&isShare=1&ctimezone=GMT-06%3A00&_=" + Date.now();
  let r = await httpGetSimple(url, { Cookie: st.cookie, "User-Agent": "Mozilla/5.0" });
  let data = null;
  try { data = JSON.parse(r.body); } catch (_) {}
  if (!data || data.code !== 0 || !data.data || !data.data.gps) {
    await gpsRefrescarCookie(v);
    r = await httpGetSimple(url, { Cookie: st.cookie, "User-Agent": "Mozilla/5.0" });
    data = JSON.parse(r.body);
    if (!data || data.code !== 0 || !data.data || !data.data.gps) throw new Error("respuesta inválida de Tracksolid");
  }
  const g = data.data.gps;
  return {
    lat: Number(g.latitude), lng: Number(g.longitude),
    speed: Number(g.gpsSpeed) || 0, acc: g.acc === "1",
    gpsTime: new Date(String(g.gpsTime).replace(" ", "T")).getTime(),
  };
}
function gpsGuardarPunto(imei, fix) {
  const dir = path.join(DIR_POSICIONES, imei);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, fechaPlantaDe(fix.gpsTime) + ".ndjson"),
    JSON.stringify({ t: fix.gpsTime, lat: fix.lat, lng: fix.lng, s: fix.speed, a: fix.acc ? 1 : 0 }) + "\n");
}
async function gpsGeocodificar(lat, lng) {
  try {
    const r = await httpGetSimple("https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=" + lat + "&lon=" + lng + "&accept-language=es",
      { "User-Agent": "transporte-dinmec/1.0 (uso interno)" });
    return JSON.parse(r.body).display_name || "";
  } catch (_) { return ""; }
}
async function gpsProcesar(v, fix) {
  const st = gpsSt(v.imei);
  const ahoraMs = Date.now();
  st.lastSeen = ahoraMs; st.errors = 0; st.fix = fix;
  if (fix.gpsTime !== st.lastGpsTime) { st.lastGpsTime = fix.gpsTime; gpsGuardarPunto(v.imei, fix); }
  const detenido = fix.speed < GPS_STOP_KMH;
  if (detenido) {
    if (!st.stop) { st.stop = { inicio: ahoraMs, lat: fix.lat, lng: fix.lng, registroId: null }; return; }
    if (haversineKm(st.stop.lat, st.stop.lng, fix.lat, fix.lng) * 1000 > GPS_DRIFT_M) {
      cerrarParadaGPS(st, ahoraMs);
      st.stop = { inicio: ahoraMs, lat: fix.lat, lng: fix.lng, registroId: null };
      return;
    }
    const min = (ahoraMs - st.stop.inicio) / 60000;
    if (!st.stop.registroId && min >= GPS_MIN_PARADA_MIN) {
      const reg = { id: "p" + ahoraMs + "_" + v.imei.slice(-4), imei: v.imei, nombre: v.name,
        inicio: st.stop.inicio, fin: null, minutos: null, lat: st.stop.lat, lng: st.stop.lng, direccion: "" };
      gpsParadas.push(reg);
      if (gpsParadas.length > 3000) gpsParadas = gpsParadas.slice(-2000); // no crecer sin límite
      st.stop.registroId = reg.id;
      guardarParadasGPS();
      gpsGeocodificar(reg.lat, reg.lng).then((dir) => { reg.direccion = dir; guardarParadasGPS(); });
    }
  } else if (st.stop) {
    cerrarParadaGPS(st, ahoraMs);
    st.stop = null;
  }
}
function cerrarParadaGPS(st, ahoraMs) {
  if (!st.stop || !st.stop.registroId) return;
  const reg = gpsParadas.find((r) => r.id === st.stop.registroId);
  if (reg) { reg.fin = ahoraMs; reg.minutos = Math.round((ahoraMs - st.stop.inicio) / 60000); guardarParadasGPS(); }
}
let _gpsOcupado = false;
async function gpsCiclo() {
  if (_gpsOcupado) return;
  const vs = gpsVehiculos();
  if (!vs.length) return;
  _gpsOcupado = true;
  for (const v of vs) {
    try { await gpsProcesar(v, await gpsConsultar(v)); }
    catch (e) { gpsSt(v.imei).errors++; console.log("GPS " + v.name + ": " + e.message); }
  }
  _gpsOcupado = false;
}
setInterval(gpsCiclo, GPS_POLL_SEG * 1000);
setTimeout(gpsCiclo, 3000);

// --- Lecturas internas con el MISMO formato que el Monitor externo ---
function gpsStatusInterno() {
  const ahoraMs = Date.now();
  return gpsVehiculos().map((v) => {
    const st = gpsSt(v.imei);
    const viejo = st.lastSeen ? (ahoraMs - st.lastSeen) > GPS_STALE_MIN * 60000 : true;
    let estado = "sin datos";
    if (st.fix) estado = (st.errors >= 3 || viejo) ? "sin señal" : (st.stop ? "detenido" : "en movimiento");
    else if (st.errors >= 3) estado = "sin señal";
    return { name: v.name, imei: v.imei, estado, fix: st.fix, lastSeen: st.lastSeen,
      stoppedSince: st.stop ? st.stop.inicio : null,
      stoppedMinutes: st.stop ? Math.round((ahoraMs - st.stop.inicio) / 60000) : null, alerted: false };
  });
}
function gpsRutaInterna(imei, fecha) {
  try {
    return fs.readFileSync(path.join(DIR_POSICIONES, path.basename(imei), fecha + ".ndjson"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
  } catch (_) { return []; }
}
function gpsParadasInternas(imei, fecha) {
  return gpsParadas.filter((p) => p.imei === imei && fechaPlantaDe(p.inicio) === fecha)
    .map((p) => ({ id: p.id, startTime: p.inicio, endTime: p.fin, minutes: p.minutos, lat: p.lat, lng: p.lng, address: p.direccion || "" }));
}
// Ruta/paradas: primero el GPS integrado; si no hay vehículos, el Monitor externo
async function rutaGPS(imei, fecha) {
  if (gpsVehiculos().length) return gpsRutaInterna(imei, fecha);
  return await leerMonitor("/api/route?imei=" + encodeURIComponent(imei) + "&date=" + fecha).catch(() => []);
}
async function paradasGPS(imei, fecha) {
  if (gpsVehiculos().length) return gpsParadasInternas(imei, fecha);
  return await leerMonitor("/api/stops?imei=" + encodeURIComponent(imei) + "&date=" + fecha).catch(() => []);
}
const CAMPOS_INCIDENTE = ["fecha", "hora", "unidad", "descripcion", "reporta"];

// ---------- Servir archivos estaticos ----------
const TIPOS = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json; charset=utf-8", ".json": "application/json; charset=utf-8", ".pdf": "application/pdf" };
function servirArchivo(res, archivo) {
  fs.readFile(archivo, (err, data) => {
    if (err) { res.writeHead(404); res.end("No encontrado"); return; }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(archivo).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- Servidor ----------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ruta = decodeURIComponent(url.pathname);
  try {
    const yo = usuarioDeSesion(req);

    // ---- Autenticacion (rutas publicas) ----
    if (ruta === "/api/estado" && req.method === "GET") {
      return json(res, 200, { configurado: hayUsuarios(), yo: yo ? { id: yo.id, usuario: yo.usuario, nombre: yo.nombre, rol: yo.rol, rol_app: yo.rol_app } : null });
    }
    if (ruta === "/api/setup" && req.method === "POST") {
      if (hayUsuarios()) return json(res, 403, { error: "Ya está configurado" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      if (!b.usuario || !b.clave) return json(res, 400, { error: "Faltan datos" });
      const id = uid();
      db.prepare("INSERT INTO usuarios (id,usuario,nombre,rol,clave,rol_app,creado) VALUES (?,?,?,?,?,?,?)")
        .run(id, b.usuario.toLowerCase().trim(), b.nombre || b.usuario, b.rol || "", hashClave(b.clave), "admin", ahora());
      const token = crearSesion(id);
      res.setHeader("Set-Cookie", `ct_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
      return json(res, 200, { ok: true });
    }
    if (ruta === "/api/login" && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const u = db.prepare("SELECT * FROM usuarios WHERE usuario=?").get((b.usuario || "").toLowerCase().trim());
      if (!u || !verificarClave(b.clave || "", u.clave)) return json(res, 401, { error: "Usuario o contraseña incorrectos" });
      const token = crearSesion(u.id);
      res.setHeader("Set-Cookie", `ct_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
      return json(res, 200, { ok: true, yo: { usuario: u.usuario, nombre: u.nombre, rol: u.rol, rol_app: u.rol_app } });
    }
    if (ruta === "/api/logout" && req.method === "POST") {
      const tok = leerCookies(req)["ct_sesion"];
      if (tok) db.prepare("DELETE FROM sesiones WHERE token=?").run(tok);
      res.setHeader("Set-Cookie", "ct_sesion=; Path=/; HttpOnly; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    // ---- Gestion de usuarios (solo admin) ----
    if (ruta === "/api/usuarios") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      if (req.method === "GET") {
        return json(res, 200, db.prepare("SELECT id,usuario,nombre,rol,rol_app,creado FROM usuarios ORDER BY creado").all());
      }
      if (req.method === "POST") {
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        if (!b.usuario || !b.clave) return json(res, 400, { error: "Faltan usuario o contraseña" });
        const existe = db.prepare("SELECT id FROM usuarios WHERE usuario=?").get(b.usuario.toLowerCase().trim());
        if (existe) return json(res, 409, { error: "Ese usuario ya existe" });
        const rolApp = ["admin", "supervisor", "operador"].includes(b.rol_app) ? b.rol_app : "operador";
        db.prepare("INSERT INTO usuarios (id,usuario,nombre,rol,clave,rol_app,creado) VALUES (?,?,?,?,?,?,?)")
          .run(uid(), b.usuario.toLowerCase().trim(), b.nombre || b.usuario, b.rol || "", hashClave(b.clave), rolApp, ahora());
        return json(res, 200, { ok: true });
      }
    }
    const mUsr = ruta.match(/^\/api\/usuarios\/([^/]+)$/);
    if (mUsr) {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      if (req.method === "DELETE") {
        if (mUsr[1] === yo.id) return json(res, 400, { error: "No puedes eliminarte a ti mismo" });
        db.prepare("DELETE FROM usuarios WHERE id=?").run(mUsr[1]);
        db.prepare("DELETE FROM sesiones WHERE usuario_id=?").run(mUsr[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === "PUT") { // cambiar contraseña y/o rol
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        if (b.clave) db.prepare("UPDATE usuarios SET clave=? WHERE id=?").run(hashClave(b.clave), mUsr[1]);
        if (b.rol_app && ["admin", "supervisor", "operador"].includes(b.rol_app)) {
          db.prepare("UPDATE usuarios SET rol_app=? WHERE id=?").run(b.rol_app, mUsr[1]);
        }
        return json(res, 200, { ok: true });
      }
    }

    // ---- Avisos de WhatsApp para nuevas salidas (solo admin) ----
    if (ruta === "/api/whatsapp") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      if (req.method === "GET") {
        return json(res, 200, { numeros: leerConfig("whatsapp_numeros", []), webhook: leerConfig("whatsapp_webhook", "") });
      }
      if (req.method === "PUT") {
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        if (Array.isArray(b.numeros)) {
          const numeros = b.numeros
            .filter((n) => n.phone)
            .map((n) => ({ nombre: String(n.nombre || ""), phone: String(n.phone).trim(), apikey: String(n.apikey || "").trim() }));
          guardarConfig("whatsapp_numeros", numeros);
        }
        if ("webhook" in b) guardarConfig("whatsapp_webhook", String(b.webhook || "").trim());
        return json(res, 200, { ok: true });
      }
    }
    if (ruta === "/api/whatsapp/probar-webhook" && req.method === "POST") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      const webhook = leerConfig("whatsapp_webhook", "");
      if (!webhook) return json(res, 400, { error: "Primero guarda la dirección del webhook" });
      const r = await enviarWebhook(webhook, { evento: "prueba", mensaje: "✅ Prueba de Control de Transporte DINMEC: la conexión con n8n funciona.", folio: "TR-PRUEBA", unidad: "", operador: "", descripcion: "Mensaje de prueba", fecha_salida: hoyPlanta(), hora_salida: "", solicitante: yo.nombre });
      return json(res, 200, r);
    }
    if (ruta === "/api/whatsapp/probar" && req.method === "POST") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const r = await enviarWhatsApp(b.phone, b.apikey, "✅ Prueba de Control de Transporte DINMEC: los avisos de nuevas salidas funcionan.");
      return json(res, 200, r);
    }

    // ---- Respaldo de la base de datos (solo admin) ----
    if (ruta === "/api/respaldo" && req.method === "GET") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      const tmp = path.join(DIR_DATOS, "respaldo_tmp.db");
      try { fs.unlinkSync(tmp); } catch (_) {}
      db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); // copia consistente
      const data = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch (_) {}
      const fecha = ahora().slice(0, 10);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="respaldo-transporte-${fecha}.db"` });
      return res.end(data);
    }

    // ---- Proteccion: toda la API de datos y las fotos requieren sesion ----
    if ((ruta.startsWith("/api/") || ruta.startsWith("/foto/")) && !yo) {
      return json(res, 401, { error: "Necesitas iniciar sesión" });
    }

    // ---- Unidades ----
    if (ruta === "/api/unidades" && req.method === "GET") {
      return json(res, 200, db.prepare("SELECT * FROM unidades WHERE activo=1 ORDER BY nombre").all());
    }
    if (ruta === "/api/unidades" && req.method === "POST") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const nombre = (b.nombre || "").trim().toUpperCase();
      if (!nombre) return json(res, 400, { error: "Escribe el nombre de la unidad" });
      const existe = db.prepare("SELECT * FROM unidades WHERE nombre=?").get(nombre);
      if (existe) { db.prepare("UPDATE unidades SET activo=1 WHERE id=?").run(existe.id); return json(res, 200, { ok: true }); }
      db.prepare("INSERT INTO unidades (id,nombre,activo) VALUES (?,?,1)").run(uid(), nombre);
      return json(res, 200, { ok: true });
    }
    const mUni = ruta.match(/^\/api\/unidades\/([^/]+)$/);
    if (mUni && req.method === "DELETE") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      db.prepare("UPDATE unidades SET activo=0 WHERE id=?").run(mUni[1]); // se conserva el historial
      return json(res, 200, { ok: true });
    }
    if (mUni && req.method === "PUT") { // ficha de la unidad: servicio, verificación, póliza
      if (!esSupervisor(yo)) return json(res, 403, { error: "Solo el coordinador o el administrador" });
      const existe = db.prepare("SELECT id FROM unidades WHERE id=?").get(mUni[1]);
      if (!existe) return json(res, 404, { error: "Unidad no encontrada" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const cambios = {};
      for (const campo of CAMPOS_UNIDAD) if (campo in b) cambios[campo] = String(b[campo] ?? "");
      const sets = Object.keys(cambios).map((c) => c + "=?");
      if (sets.length) {
        db.prepare(`UPDATE unidades SET ${sets.join(",")} WHERE id=?`).run(...Object.values(cambios), mUni[1]);
        avisarCambio(mUni[1], "unidad");
      }
      return json(res, 200, { ok: true });
    }

    // ---- Flota: ficha de cada unidad con kilometraje, servicio, verificación y póliza ----
    if (ruta === "/api/flota" && req.method === "GET") {
      const unidades = db.prepare("SELECT * FROM unidades WHERE activo=1 ORDER BY nombre").all();
      const flota = unidades.map((u) => {
        // último kilometraje conocido (de las cargas de gasolina)
        const filas = db.prepare("SELECT kilometraje, fecha FROM cargas WHERE unidad=? AND kilometraje!='' ORDER BY fecha DESC, creado DESC").all(u.nombre);
        let ultimoKm = null, ultimoKmFecha = "";
        for (const f of filas) {
          const n = parseFloat(f.kilometraje);
          if (!isNaN(n)) { ultimoKm = n; ultimoKmFecha = f.fecha; break; }
        }
        const servicioKm = parseFloat(u.servicio_km);
        const kmDesdeServicio = (ultimoKm !== null && !isNaN(servicioKm)) ? ultimoKm - servicioKm : null;
        const proximoServicioKm = !isNaN(servicioKm) ? servicioKm + SERVICIO_CADA_KM : null;
        return {
          ...u,
          ultimo_km: ultimoKm, ultimo_km_fecha: ultimoKmFecha,
          km_desde_servicio: kmDesdeServicio,
          proximo_servicio_km: proximoServicioKm,
          servicio_cada: SERVICIO_CADA_KM,
          docs_poliza: fotosDe("unidad", u.id).filter((f) => f.categoria === "poliza"),
        };
      });
      return json(res, 200, flota);
    }

    // ---- Reporte mensual de gasolina y kilómetros recorridos ----
    if (ruta === "/api/reporte-gasolina" && req.method === "GET") {
      const mes = url.searchParams.get("mes") || hoyPlanta().slice(0, 7); // YYYY-MM (hora de la planta)
      const cargasMes = db.prepare("SELECT * FROM cargas WHERE fecha LIKE ? ORDER BY fecha, hora").all(mes + "%")
        .map((c) => { const { firma_operador, ...resto } = c; return resto; });
      // resumen por unidad
      const porUnidad = {};
      for (const c of cargasMes) {
        const u = c.unidad || "(sin unidad)";
        porUnidad[u] = porUnidad[u] || { unidad: u, cargas: 0, efectivo: 0, tarjeta: 0, kms: [], costo_total: 0 };
        porUnidad[u].cargas++;
        if (c.tipo_pago === "efectivo") porUnidad[u].efectivo++;
        if (c.tipo_pago === "tarjeta") porUnidad[u].tarjeta++;
        const n = parseFloat(c.kilometraje);
        if (!isNaN(n)) porUnidad[u].kms.push(n);
        const $ = parseFloat(c.costo);
        if (!isNaN($)) porUnidad[u].costo_total += $;
      }
      const resumen = Object.values(porUnidad).map((r) => {
        // punto de partida: última lectura ANTES del mes (si existe) para no perder el primer tramo
        const previa = db.prepare("SELECT kilometraje FROM cargas WHERE unidad=? AND fecha<? AND kilometraje!='' ORDER BY fecha DESC, creado DESC").all(r.unidad, mes + "-01")
          .map((f) => parseFloat(f.kilometraje)).find((n) => !isNaN(n));
        const kmFin = r.kms.length ? Math.max(...r.kms) : null;
        let base = previa !== undefined ? previa : (r.kms.length ? Math.min(...r.kms) : null);
        let recorridos = (kmFin !== null && base !== null && kmFin >= base) ? kmFin - base : null;
        return { unidad: r.unidad, cargas: r.cargas, efectivo: r.efectivo, tarjeta: r.tarjeta,
                 km_inicio: base, km_fin: kmFin, km_recorridos: recorridos, costo_total: Math.round(r.costo_total * 100) / 100 };
      });
      return json(res, 200, { mes, cargas: cargasMes, resumen });
    }

    // ---- GPS: posición de cada auto (integrado o vía Monitor DINMEC) ----
    if (ruta === "/api/gps" && req.method === "GET") {
      if (gpsVehiculos().length) {
        return json(res, 200, { ok: true, interno: true, vehicles: gpsStatusInterno() });
      }
      try {
        const datos = await leerMonitor("/api/status");
        return json(res, 200, { ok: true, ...datos });
      } catch (e) {
        return json(res, 200, { ok: false, error: "No hay GPS configurado. Agrega los vehículos en Usuarios y unidades → 📡 GPS, o enciende el Monitor DINMEC local." });
      }
    }

    // ---- Vehículos GPS del lector integrado (solo admin) ----
    if (ruta === "/api/gps-vehiculos") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo administrador" });
      if (req.method === "GET") return json(res, 200, { vehiculos: gpsVehiculos() });
      if (req.method === "PUT") {
        const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
        const vehiculos = (Array.isArray(b.vehiculos) ? b.vehiculos : [])
          .filter((v) => v.imei && v.shareUrl)
          .map((v) => ({ name: String(v.name || "Vehículo"), imei: String(v.imei).trim(), shareUrl: String(v.shareUrl).trim() }));
        guardarConfig("gps_vehiculos", vehiculos);
        for (const v of vehiculos) { const st = gpsSt(v.imei); st.cookie = null; st.errors = 0; }
        setTimeout(gpsCiclo, 500); // leer de inmediato
        return json(res, 200, { ok: true });
      }
    }

    // ---- Resumen del viaje: ruta GPS, paradas, velocidad máxima, gasolina e incidentes ----
    const mResumen = ruta.match(/^\/api\/viaje\/([^/]+)\/resumen$/);
    if (mResumen && req.method === "GET") {
      const v = db.prepare("SELECT * FROM viajes WHERE id=?").get(mResumen[1]);
      if (!v) return json(res, 404, { error: "Registro no encontrado" });
      const fechaFin = (v.estado === "finalizado" ? (v.fecha_regreso_real || v.fecha_salida) : hoyPlanta());
      const iniMs = msDePlanta(v.fecha_salida, v.hora_salida || "00:00");
      const finMs = v.estado === "finalizado"
        ? msDePlanta(fechaFin, v.hora_regreso || "23:59")
        : Date.now();

      // Cargas de gasolina e incidentes de ESA unidad dentro de la ventana del viaje
      const enVentana = (fecha, hora) => {
        const ms = msDePlanta(fecha, hora || "12:00");
        return !isNaN(ms) && ms >= iniMs - 30 * 60000 && ms <= finMs + 30 * 60000;
      };
      const cargas = db.prepare("SELECT fecha,hora,lugar,tipo_pago,kilometraje,nivel_combustible,costo,operador,id FROM cargas WHERE unidad=? AND fecha>=? AND fecha<=?")
        .all(v.unidad, v.fecha_salida, fechaFin).filter((c) => enVentana(c.fecha, c.hora));
      const incidentes = db.prepare("SELECT fecha,hora,descripcion,reporta,id FROM incidentes WHERE unidad=? AND fecha>=? AND fecha<=?")
        .all(v.unidad, v.fecha_salida, fechaFin).filter((i) => enVentana(i.fecha, i.hora));

      // Ruta y paradas desde el Monitor DINMEC (si la unidad tiene GPS vinculado)
      const uni = db.prepare("SELECT * FROM unidades WHERE nombre=?").get(v.unidad);
      let gps = { ok: false, motivo: "sin_gps" };
      if (uni && uni.gps_imei) {
        try {
          const fechas = listaFechas(v.fecha_salida, fechaFin);
          let puntos = [];
          const paradasMap = {};
          for (const f of fechas) {
            const pts = await rutaGPS(uni.gps_imei, f);
            if (Array.isArray(pts)) puntos = puntos.concat(pts);
            const stops = await paradasGPS(uni.gps_imei, f);
            if (Array.isArray(stops)) for (const s of stops) paradasMap[s.id] = s;
          }
          puntos = puntos.filter((p) => p.t >= iniMs && p.t <= finMs).sort((a, b) => a.t - b.t);
          const paradas = Object.values(paradasMap)
            .filter((s) => s.startTime >= iniMs && s.startTime <= finMs)
            .sort((a, b) => a.startTime - b.startTime)
            .map((s) => ({ inicio: s.startTime, fin: s.endTime, minutos: s.minutes, lat: s.lat, lng: s.lng, direccion: s.address || "" }));
          let dist = 0, velMax = 0;
          for (let i = 1; i < puntos.length; i++) {
            dist += haversineKm(puntos[i - 1].lat, puntos[i - 1].lng, puntos[i].lat, puntos[i].lng);
          }
          for (const p of puntos) if (p.s > velMax) velMax = p.s;
          // aligerar la ruta para el mapa (máx ~600 puntos)
          const paso = Math.max(1, Math.ceil(puntos.length / 600));
          const ruta_mapa = puntos.filter((_, i) => i % paso === 0 || i === puntos.length - 1)
            .map((p) => [p.lat, p.lng]);
          gps = { ok: true, puntos: puntos.length, distancia_km: Math.round(dist * 10) / 10, vel_max: Math.round(velMax), paradas, ruta_mapa };
        } catch (e) {
          gps = { ok: false, motivo: "monitor_apagado" };
        }
      }
      const { firma_solicitante, firma_operador, firma_recibe, firma_llaves_salida, firma_llaves_regreso, ...viajeLigero } = v;
      return json(res, 200, { viaje: viajeLigero, inicio: iniMs, fin: finMs, cargas, incidentes, gps });
    }

    // ---- Lista de operadores (para elegir en el formulario) ----
    if (ruta === "/api/operadores" && req.method === "GET") {
      return json(res, 200, db.prepare("SELECT nombre FROM usuarios WHERE rol_app='operador' ORDER BY nombre").all());
    }

    // ---- Viajes ----
    if (ruta === "/api/viajes" && req.method === "GET") {
      const desde = url.searchParams.get("desde");
      const hasta = url.searchParams.get("hasta");
      let sql = "SELECT * FROM viajes WHERE 1=1";
      const args = [];
      if (desde) { sql += " AND fecha_salida >= ?"; args.push(desde); }
      if (hasta) { sql += " AND fecha_salida <= ?"; args.push(hasta); }
      sql += " ORDER BY fecha_salida DESC, creado DESC";
      const lista = db.prepare(sql).all(...args);
      // sin firmas (pesadas) para que la lista cargue rápido
      const ligera = lista.map((v) => {
        const { firma_solicitante, firma_operador, firma_recibe, firma_llaves_salida, firma_llaves_regreso, ...resto } = v;
        return { ...resto, firmado_sol: !!firma_solicitante, firmado_op: !!firma_operador };
      });
      return json(res, 200, ligera);
    }

    if (ruta === "/api/viajes" && req.method === "POST") {
      if (!esSupervisor(yo)) return json(res, 403, { error: "Solo el coordinador de transporte o el administrador pueden registrar salidas" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const id = uid();
      const folio = nuevoFolio();
      // La fecha de salida siempre es HOY (hora de la planta); solo el administrador puede poner otra.
      const fechaSalida = esAdmin(yo) && b.fecha_salida ? b.fecha_salida : hoyPlanta();
      db.prepare(`INSERT INTO viajes (id,folio,descripcion,solicitante,firma_solicitante,fecha_salida,hora_salida,
                  fecha_regreso,fecha_regreso_real,hora_regreso,unidad,operador,firma_operador,recibe_carga,firma_recibe,
                  llaves_entrega_por,llaves_recibe,firma_llaves_salida,llaves_devuelve_a,firma_llaves_regreso,
                  km_inicial,km_final,viaticos_asignados,emergencias_asignadas,tag_digitos,tc_banco,tc_digitos,gastos,traficos,casetas,
                  observaciones,estado,creado,creado_por,actualizado,actualizado_por)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, folio, b.descripcion || "", b.solicitante || yo.nombre, b.firma_solicitante || "",
        fechaSalida, b.hora_salida || "", b.fecha_regreso || "", "", "",
        b.unidad || "", b.operador || "", b.firma_operador || "", "", "",
        b.llaves_entrega_por || "", b.llaves_recibe || "", b.firma_llaves_salida || "", "", "",
        String(b.km_inicial || ""), "", String(b.viaticos_asignados || ""),
        String(b.emergencias_asignadas || ""), String(b.tag_digitos || ""), String(b.tc_banco || ""), String(b.tc_digitos || ""),
        b.gastos || "", b.traficos || "", b.casetas || "",
        b.observaciones || "", "en_curso", ahora(), yo.nombre, ahora(), yo.nombre);
      avisarCambio(id, "nuevo");
      // Aviso por WhatsApp (sin detener la respuesta)
      avisarNuevaSalida({ folio, unidad: b.unidad, operador: b.operador, descripcion: b.descripcion,
        fecha_salida: fechaSalida, hora_salida: b.hora_salida, solicitante: b.solicitante || yo.nombre }).catch(() => {});
      return json(res, 200, { id });
    }

    const mViaje = ruta.match(/^\/api\/viaje\/([^/]+)$/);
    if (mViaje && req.method === "GET") {
      const v = obtenerViaje(mViaje[1]);
      if (!v) return json(res, 404, { error: "Registro no encontrado" });
      return json(res, 200, v);
    }
    if (mViaje && req.method === "PUT") {
      const v = db.prepare("SELECT * FROM viajes WHERE id=?").get(mViaje[1]);
      if (!v) return json(res, 404, { error: "Registro no encontrado" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      // Cada rol solo puede tocar sus campos (el operador registra el regreso)
      const permitidos = esAdmin(yo) ? CAMPOS_ADMIN : esSupervisor(yo) ? CAMPOS_SUPERVISOR : CAMPOS_REGRESO;
      const cambios = {};
      for (const campo of permitidos) if (campo in b) cambios[campo] = b[campo];
      if (b.fecha_salida !== undefined && !esAdmin(yo) && b.fecha_salida !== v.fecha_salida) {
        // aviso claro en vez de ignorar en silencio
        return json(res, 403, { error: "Solo el administrador puede cambiar la fecha de salida" });
      }
      if ("estado" in cambios && !["en_curso", "finalizado"].includes(cambios.estado)) delete cambios.estado;
      const sets = Object.keys(cambios).map((c) => c + "=?");
      if (sets.length) {
        db.prepare(`UPDATE viajes SET ${sets.join(",")},actualizado=?,actualizado_por=? WHERE id=?`)
          .run(...Object.values(cambios), ahora(), yo.nombre, mViaje[1]);
        avisarCambio(mViaje[1], "viaje");
      }
      return json(res, 200, { ok: true });
    }
    if (mViaje && req.method === "DELETE") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo el administrador puede eliminar registros" });
      borrarFotosDe("viaje", mViaje[1]);
      db.prepare("DELETE FROM viajes WHERE id=?").run(mViaje[1]);
      avisarCambio(mViaje[1], "eliminado");
      return json(res, 200, { ok: true });
    }

    // ---- Cargas de gasolina ----
    if (ruta === "/api/cargas" && req.method === "GET") {
      const lista = db.prepare("SELECT * FROM cargas ORDER BY fecha DESC, creado DESC").all();
      const ligera = lista.map((c) => {
        const { firma_operador, ...resto } = c;
        return { ...resto, firmado: !!firma_operador, num_fotos: db.prepare("SELECT COUNT(*) n FROM fotos WHERE tipo='carga' AND ref_id=?").get(c.id).n };
      });
      return json(res, 200, ligera);
    }
    if (ruta === "/api/cargas" && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const id = uid();
      db.prepare(`INSERT INTO cargas (id,fecha,hora,unidad,lugar,tipo_pago,kilometraje,nivel_combustible,costo,operador,firma_operador,observaciones,creado,creado_por,actualizado,actualizado_por)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, b.fecha || "", b.hora || "", b.unidad || "", b.lugar || "", b.tipo_pago || "", String(b.kilometraje || ""), b.nivel_combustible || "",
        String(b.costo || ""), b.operador || yo.nombre, b.firma_operador || "", b.observaciones || "", ahora(), yo.nombre, ahora(), yo.nombre);
      avisarCambio(id, "carga");
      return json(res, 200, { id });
    }
    const mCarga = ruta.match(/^\/api\/carga\/([^/]+)$/);
    if (mCarga && req.method === "GET") {
      const c = obtenerCarga(mCarga[1]);
      if (!c) return json(res, 404, { error: "Registro no encontrado" });
      return json(res, 200, c);
    }
    if (mCarga && req.method === "PUT") {
      const existe = db.prepare("SELECT id FROM cargas WHERE id=?").get(mCarga[1]);
      if (!existe) return json(res, 404, { error: "Registro no encontrado" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const cambios = {};
      for (const campo of CAMPOS_CARGA) if (campo in b) cambios[campo] = b[campo];
      const sets = Object.keys(cambios).map((c) => c + "=?");
      if (sets.length) {
        db.prepare(`UPDATE cargas SET ${sets.join(",")},actualizado=?,actualizado_por=? WHERE id=?`)
          .run(...Object.values(cambios), ahora(), yo.nombre, mCarga[1]);
        avisarCambio(mCarga[1], "carga");
      }
      return json(res, 200, { ok: true });
    }
    if (mCarga && req.method === "DELETE") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo el administrador puede eliminar registros" });
      borrarFotosDe("carga", mCarga[1]);
      db.prepare("DELETE FROM cargas WHERE id=?").run(mCarga[1]);
      avisarCambio(mCarga[1], "eliminado");
      return json(res, 200, { ok: true });
    }

    // ---- Incidentes ----
    if (ruta === "/api/incidentes" && req.method === "GET") {
      const lista = db.prepare("SELECT * FROM incidentes ORDER BY fecha DESC, creado DESC").all();
      const conFotos = lista.map((i) => ({ ...i, num_fotos: db.prepare("SELECT COUNT(*) n FROM fotos WHERE tipo='incidente' AND ref_id=?").get(i.id).n }));
      return json(res, 200, conFotos);
    }
    if (ruta === "/api/incidentes" && req.method === "POST") {
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const id = uid();
      db.prepare(`INSERT INTO incidentes (id,fecha,hora,unidad,descripcion,reporta,creado,creado_por,actualizado,actualizado_por)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, b.fecha || "", b.hora || "", b.unidad || "", b.descripcion || "", b.reporta || yo.nombre,
        ahora(), yo.nombre, ahora(), yo.nombre);
      avisarCambio(id, "incidente");
      return json(res, 200, { id });
    }
    const mInc = ruta.match(/^\/api\/incidente\/([^/]+)$/);
    if (mInc && req.method === "GET") {
      const i = obtenerIncidente(mInc[1]);
      if (!i) return json(res, 404, { error: "Registro no encontrado" });
      return json(res, 200, i);
    }
    if (mInc && req.method === "PUT") {
      const existe = db.prepare("SELECT id FROM incidentes WHERE id=?").get(mInc[1]);
      if (!existe) return json(res, 404, { error: "Registro no encontrado" });
      const b = JSON.parse((await leerCuerpo(req)).toString() || "{}");
      const cambios = {};
      for (const campo of CAMPOS_INCIDENTE) if (campo in b) cambios[campo] = b[campo];
      const sets = Object.keys(cambios).map((c) => c + "=?");
      if (sets.length) {
        db.prepare(`UPDATE incidentes SET ${sets.join(",")},actualizado=?,actualizado_por=? WHERE id=?`)
          .run(...Object.values(cambios), ahora(), yo.nombre, mInc[1]);
        avisarCambio(mInc[1], "incidente");
      }
      return json(res, 200, { ok: true });
    }
    if (mInc && req.method === "DELETE") {
      if (!esAdmin(yo)) return json(res, 403, { error: "Solo el administrador puede eliminar registros" });
      borrarFotosDe("incidente", mInc[1]);
      db.prepare("DELETE FROM incidentes WHERE id=?").run(mInc[1]);
      avisarCambio(mInc[1], "eliminado");
      return json(res, 200, { ok: true });
    }

    // Subir foto de evidencia (cuerpo = bytes de imagen o PDF; metadatos en query)
    // /api/viaje/ID/foto | /api/carga/ID/foto?categoria=bomba | /api/incidente/ID/foto | /api/unidad/ID/foto?categoria=poliza
    const mFoto = ruta.match(/^\/api\/(viaje|carga|incidente|unidad)\/([^/]+)\/foto$/);
    if (mFoto && req.method === "POST") {
      const buf = await leerCuerpo(req);
      const tipo = mFoto[1];
      const refId = mFoto[2];
      const categoria = url.searchParams.get("categoria") || "";
      const nombre = url.searchParams.get("nombre") || "foto.jpg";
      const ext = (path.extname(nombre) || ".jpg").toLowerCase();
      const archivo = uid() + ext;
      fs.writeFileSync(path.join(DIR_FOTOS, archivo), buf);
      const fid = uid();
      db.prepare("INSERT INTO fotos (id,ref_id,tipo,categoria,archivo,nombre_original,subido,subido_por) VALUES (?,?,?,?,?,?,?,?)")
        .run(fid, refId, tipo, categoria, archivo, nombre, ahora(), yo.nombre);
      avisarCambio(refId, "foto");
      return json(res, 200, { id: fid, url: "/foto/" + archivo, nombre, categoria });
    }

    const mFotoDel = ruta.match(/^\/api\/foto\/([^/]+)$/);
    if (mFotoDel && req.method === "DELETE") {
      const f = db.prepare("SELECT * FROM fotos WHERE id=?").get(mFotoDel[1]);
      if (f) {
        try { fs.unlinkSync(path.join(DIR_FOTOS, f.archivo)); } catch (_) {}
        db.prepare("DELETE FROM fotos WHERE id=?").run(mFotoDel[1]);
        avisarCambio(f.ref_id, "foto");
      }
      return json(res, 200, { ok: true });
    }

    // Imagen de evidencia
    const mImg = ruta.match(/^\/foto\/(.+)$/);
    if (mImg && req.method === "GET") {
      return servirArchivo(res, path.join(DIR_FOTOS, path.basename(mImg[1])));
    }

    // Sincronizacion en vivo
    if (ruta === "/api/eventos" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write("retry: 3000\n\n");
      clientesSSE.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
      req.on("close", () => { clearInterval(ping); clientesSSE.delete(res); });
      return;
    }

    // ---- Archivos estaticos ----
    if (ruta === "/" || ruta === "") return servirArchivo(res, path.join(DIR_PUBLIC, "index.html"));
    const archivoEstatico = path.join(DIR_PUBLIC, path.normalize(ruta).replace(/^([/\\])+/, ""));
    if (archivoEstatico.startsWith(DIR_PUBLIC) && fs.existsSync(archivoEstatico) && fs.statSync(archivoEstatico).isFile()) {
      return servirArchivo(res, archivoEstatico);
    }
    res.writeHead(404); res.end("No encontrado");
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function borrarFotosDe(tipo, refId) {
  const fotos = db.prepare("SELECT * FROM fotos WHERE tipo=? AND ref_id=?").all(tipo, refId);
  for (const f of fotos) { try { fs.unlinkSync(path.join(DIR_FOTOS, f.archivo)); } catch (_) {} }
  db.prepare("DELETE FROM fotos WHERE tipo=? AND ref_id=?").run(tipo, refId);
}

servidor.listen(PUERTO, "0.0.0.0", () => {
  const ips = ipsLocales();
  console.log("\n==================================================");
  console.log("   CONTROL DE TRANSPORTE  -  DINMEC 2026");
  console.log("==================================================");
  console.log("   Servidor encendido. Para entrar abre en tu navegador:\n");
  console.log("   En esta misma PC:   http://localhost:" + PUERTO);
  for (const ip of ips) console.log("   Desde otro equipo/celular:   http://" + ip + ":" + PUERTO);
  console.log("\n   (Todos deben estar en la MISMA red / WiFi de la planta)");
  console.log("   Para apagar el servidor: cierra esta ventana.");
  console.log("==================================================\n");
});
