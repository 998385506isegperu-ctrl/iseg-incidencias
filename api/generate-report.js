// api/generate-report.js — Vercel Serverless Function
// Corrige la redaccion de la captura de campo y arma el informe de incidencia.
// Requiere la variable de entorno: anthropic_api_key

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 5000;

const SYSTEM_PROMPT = `Editor de informes de incidencia para ISEG Corp (seguridad privada, Peru). Recibes datos capturados en campo por un lider operativo, con errores de ortografia y redaccion.

TU TRABAJO
- Corrige ortografia, gramatica y redaccion. Tono profesional y objetivo.
- NUNCA inventes hechos, horas, nombres, documentos ni montos. Si un dato falta, no lo completes ni lo menciones.
- No repitas la misma informacion en varias secciones.
- Marca toda hipotesis como hipotesis, nunca como conclusion.
- Si un campo no tiene datos suficientes en la captura, omite esa clave del JSON.

LIMITES DE LONGITUD (obligatorios)
resumen_ejecutivo: 60 palabras
severidad_justificacion: 30 palabras
hechos_narrativa: 130 palabras
deteccion: 25 palabras
impacto_operacional: 30 palabras
impacto_reputacional_legal: 30 palabras
cada factor de causa raiz: 30 palabras
hipotesis: 30 palabras
conclusiones: maximo 4 items de 20 palabras
recomendaciones: maximo 5 items de 20 palabras
observaciones_calidad: maximo 3 items de 15 palabras (solo inconsistencias reales de datos)

FORMATO DE SALIDA
Responde SOLO el objeto JSON. Sin backticks, sin markdown, sin texto adicional. Esta es la forma exacta:
{"resumen_ejecutivo":"","severidad_justificacion":"","hechos_narrativa":"","deteccion":"","impacto_operacional":"","impacto_reputacional_legal":"","analisis_causa_raiz":{"factor_tecnologico":"","factor_proceso":"","factor_humano":"","hipotesis":""},"conclusiones":[],"recomendaciones":[{"prioridad":"","texto":""}],"observaciones_calidad":[]}

La clave "prioridad" solo acepta: "Inmediata (0-7 dias)", "Corto plazo (30 dias)" o "Estructural".`;

// --- Reparacion de JSON truncado -------------------------------------------
// Recorre el texto rastreando strings y contenedores abiertos, corta en el
// ultimo punto seguro y cierra lo que quedo abierto. Probado contra 10 casos.
function repairJson(text) {
  const stack = [];
  let inString = false, escape = false;
  let safeIndex = -1, safeStack = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { if (inString) escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); continue; }
    if (c === "}" || c === "]") { stack.pop(); safeIndex = i + 1; safeStack = stack.slice(); continue; }
    if (c === ",") { safeIndex = i; safeStack = stack.slice(); continue; }
  }

  if (safeIndex === -1) return null;
  let out = text.substring(0, safeIndex).replace(/,\s*$/, "");
  for (let i = safeStack.length - 1; i >= 0; i--) out += safeStack[i];
  return out;
}

// --- Payload limpio ---------------------------------------------------------
// Envia solo los datos del incidente. Excluye el catalogo fijo de opciones de
// clasificacion y las casillas no marcadas, que solo gastan tokens y confunden.
function buildPayload(state) {
  const s = state || {};
  const seleccionadas = Object.entries(s.clasificacionSel || {})
    .filter(([, v]) => v)
    .map(([k]) => k.split("|")[1] || k);

  const limpio = {
    general: s.general,
    clasificacion_seleccionada: seleccionadas,
    severidad: s.severidad,
    hechos: s.hechos,
    impacto: s.impacto,
    notificaciones: s.notificaciones,
    acciones: s.acciones,
    personas: s.personas,
    evidencias: s.evidencias,
    plan_accion: s.planAccion,
  };

  // Quita claves vacias para no inducir al modelo a rellenarlas
  const podar = (obj) => {
    if (Array.isArray(obj)) {
      const arr = obj.map(podar).filter((v) => v !== undefined);
      return arr.length ? arr : undefined;
    }
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const p = podar(v);
        if (p !== undefined) out[k] = p;
      }
      return Object.keys(out).length ? out : undefined;
    }
    if (typeof obj === "string" && obj.trim() === "") return undefined;
    if (obj === null) return undefined;
    return obj;
  };

  return podar(limpio) || {};
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Metodo no permitido" });

  const apiKey = process.env.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Falta configurar la variable anthropic_api_key en Vercel." });
  }

  let state = req.body;
  if (typeof state === "string") { try { state = JSON.parse(state); } catch (e) {} }
  if (!state || typeof state !== "object") {
    return res.status(400).json({ error: "No se recibieron datos de la captura." });
  }

  const payload = buildPayload(state);
  const userMessage =
    "Datos capturados en campo:\n" +
    JSON.stringify(payload) +
    "\n\nGenera el JSON del informe respetando los limites de palabras. Solo el objeto JSON.";

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: userMessage },
          // Prellenado: obliga al modelo a arrancar en JSON, sin backticks.
          { role: "assistant", content: "{" },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      let detalle = errText;
      try { detalle = JSON.parse(errText)?.error?.message || errText; } catch (e) {}
      return res.status(502).json({ error: "La API de Claude devolvio un error", detail: detalle });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      return res.status(502).json({ error: "La API no devolvio contenido de texto." });
    }

    // El prellenado "{" no viene en la respuesta: se antepone.
    let raw = ("{" + textBlock.text).trim();
    // Quita una valla de codigo de cierre si el modelo la agrego al final.
    raw = raw.replace(/\s*```\s*$/, "").trim();

    const truncado = data.stop_reason === "max_tokens";
    let reportJson = null;

    try {
      reportJson = JSON.parse(raw);
    } catch (e) {
      const reparado = repairJson(raw);
      if (reparado) { try { reportJson = JSON.parse(reparado); } catch (e2) {} }
    }

    if (!reportJson) {
      return res.status(502).json({
        error: "No se pudo interpretar la respuesta del modelo. Intenta generar de nuevo.",
        detail: "stop_reason: " + data.stop_reason,
      });
    }

    // Si hubo truncamiento, avisar en el propio informe.
    if (truncado) {
      reportJson.observaciones_calidad = Array.isArray(reportJson.observaciones_calidad)
        ? reportJson.observaciones_calidad
        : [];
      reportJson.observaciones_calidad.push(
        "El informe se genero de forma parcial por extension del contenido. Revisar que no falten secciones antes de enviarlo."
      );
    }

    return res.status(200).json(reportJson);
  } catch (err) {
    return res.status(500).json({ error: "Error interno del servidor", detail: String(err) });
  }
}
