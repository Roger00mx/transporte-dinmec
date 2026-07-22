// ============ Utilidades compartidas — Control de Transporte DINMEC ============

// --- Sesión: exige usuario logueado, si no, manda al login ---
async function exigirSesion() {
  try {
    const est = await fetch("/api/estado").then(r => r.json());
    if (!est.yo) { location.href = "login.html"; return null; }
    return est.yo; // { id, usuario, nombre, rol, rol_app }
  } catch {
    location.href = "login.html"; return null;
  }
}
async function cerrarSesion() {
  await fetch("/api/logout", { method: "POST" });
  location.href = "login.html";
}

// --- Avisos rápidos (toast) ---
let _toastT;
function aviso(txt) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = txt; t.classList.add("ver");
  clearTimeout(_toastT); _toastT = setTimeout(() => t.classList.remove("ver"), 2200);
}

// --- API helpers ---
const api = {
  get: (u) => fetch(u).then(r => r.json()),
  post: (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  put: (u, b) => fetch(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json()),
  del: (u) => fetch(u, { method: "DELETE" }).then(r => r.json()),
};

// --- Sincronización en vivo (SSE) ---
function conectarEnVivo(alCambiar) {
  try {
    const ev = new EventSource("/api/eventos");
    ev.onmessage = (e) => { try { alCambiar(JSON.parse(e.data)); } catch {} };
    return ev;
  } catch { return null; }
}

// --- Fechas y horas ---
function fechaHoy() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function horaAhora() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function fechaBonita(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-").map(Number);
  if (!a || !m || !d) return iso;
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return d + " " + meses[m - 1] + " " + a;
}

// --- Firma con el dedo / mouse (canvas) ---
function crearFirma(caja) {
  const canvas = caja.querySelector("canvas");
  const ph = caja.querySelector(".ph");
  const ctx = canvas.getContext("2d");
  let pintando = false, vacio = true;
  function ajustar() {
    const r = caja.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#13284a";
  }
  setTimeout(ajustar, 0);
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  }
  function ini(e) { e.preventDefault(); pintando = true; const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y); }
  function mov(e) { if (!pintando) return; e.preventDefault(); const { x, y } = pos(e); ctx.lineTo(x, y); ctx.stroke(); if (vacio) { vacio = false; if (ph) ph.style.display = "none"; } }
  function fin() { pintando = false; }
  canvas.addEventListener("mousedown", ini); canvas.addEventListener("mousemove", mov);
  window.addEventListener("mouseup", fin);
  canvas.addEventListener("touchstart", ini, { passive: false });
  canvas.addEventListener("touchmove", mov, { passive: false });
  canvas.addEventListener("touchend", fin);
  return {
    estaVacio: () => vacio,
    limpiar: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); vacio = true; if (ph) ph.style.display = "flex"; },
    aDataURL: () => vacio ? "" : canvas.toDataURL("image/png"),
  };
}

// --- Visor de fotos: zoom en la misma pantalla, sin abrir otra pestaña ---
function verFoto(url) {
  let v = document.getElementById("visor-foto");
  if (!v) {
    v = document.createElement("div");
    v.id = "visor-foto"; v.className = "visor-foto";
    v.innerHTML = '<button class="cerrar" title="Cerrar">×</button><img alt="foto">';
    document.body.appendChild(v);
    const img = v.querySelector("img");
    const cerrar = () => { v.style.display = "none"; img.classList.remove("zoom"); };
    v.addEventListener("click", (e) => { if (e.target !== img) cerrar(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrar(); });
    // Un toque/clic sobre la foto acerca justo donde tocaste; otro toque la regresa
    img.addEventListener("click", (e) => {
      const r = img.getBoundingClientRect();
      img.style.transformOrigin = ((e.clientX - r.left) / r.width * 100) + "% " + ((e.clientY - r.top) / r.height * 100) + "%";
      img.classList.toggle("zoom");
    });
  }
  const img = v.querySelector("img");
  img.classList.remove("zoom");
  img.src = url;
  v.style.display = "flex";
}

function escaparHTML(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function paramURL(n) { return new URL(location.href).searchParams.get(n); }

// --- Reducir foto antes de subir (ahorra datos y espacio) ---
function comprimirImagen(file, maxLado = 1600, calidad = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      if (Math.max(w, h) > maxLado) {
        const esc = maxLado / Math.max(w, h);
        w = Math.round(w * esc); h = Math.round(h * esc);
      }
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      c.toBlob((blob) => resolve(blob || file), "image/jpeg", calidad);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// --- PWA: instalar como app con ícono ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
let _promptInstalar = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); _promptInstalar = e;
  document.querySelectorAll("[data-instalar]").forEach(b => b.style.display = "inline-flex");
});
window.addEventListener("appinstalled", () => {
  document.querySelectorAll("[data-instalar]").forEach(b => b.style.display = "none");
});
async function instalarApp() {
  if (!_promptInstalar) {
    aviso("En tu navegador: menú ⋮ → \"Instalar app\" o \"Agregar a inicio\".");
    return;
  }
  _promptInstalar.prompt();
  await _promptInstalar.userChoice;
  _promptInstalar = null;
}
