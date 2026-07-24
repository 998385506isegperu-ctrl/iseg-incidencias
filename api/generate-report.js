// api/generate-report.js — Vercel Serverless Function
// Llama a Claude para corregir redacción y generar el informe.
// Requiere ANTHROPIC_API_KEY en las variables de entorno de Vercel.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `Eres un editor técnico de informes de incidencia para ISEG Corp, empresa de seguridad privada en Perú. Recibes datos capturados por un líder operativo en campo con posibles errores de ortografía, gramática o redacción.

Tu trabajo:
1. Corregir ortografía, gramática, puntuación y redacción. NUNCA inventar hechos, horas, nombres ni montos que no estén en la captura. Si un dato falta o dice "POR CONFIRMAR", consérvalo tal cual.
2. Redactar en tono profesional, objetivo y verificable. Evita adjetivos innecesarios y lenguaje informal.
3. Redactar un resumen ejecutivo breve (máx 120 palabras) y una narrativa de hechos desarrollada, sin agregar información nueva.
4. Desarrollar un análisis de causa raíz estructurado en factores (tecnológico, proceso, humano) cuando la captura lo permita.
5. Generar conclusiones y recomendaciones ordenadas por impacto (inmediatas, corto plazo, estructurales).
6. Marcar cualquier hipótesis explícitamente como tal, nunca como conclusión.
7. Si detectas inconsistencias entre datos, señálalas en "observaciones_calidad".

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloques de markdown:

{
  "resumen_ejecutivo": "string",
  "severidad_justificacion": "string",
  "hechos_narrativa": "string (párrafos separados por \\n\\n)",
  "cronologia": [{"hora": "HH:MM", "evento": "string", "fuente": "string u omitir"}],
  "deteccion": "string",
  "impacto_operacional": "string u omitir",
  "impacto_reputacional_legal": "string u omitir",
  "analisis_causa_raiz": {
    "factor_tecnologico": "string u omitir",
    "factor_proceso": "string u omitir",
    "factor_humano": "string u omitir",
    "hipotesis": "string u omitir"
  },
  "conclusiones": ["string"],
  "recomendaciones": [{"prioridad": "Inmediata (0-7 días)|Corto plazo (30 días)|Estructural", "texto": "string"}],
  "observaciones_calidad": ["string"]
}`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en Vercel." });
  }

  const captura = req.body;
  if (!captura) return res.status(400).json({ error: "Body vacío" });

  const userMessage = "Captura del incidente (JSON del líder operativo):\n\n" +
    JSON.stringify(captura, null, 2) +
    "\n\nGenera el objeto JSON del informe según las instrucciones del sistema.";

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
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: "Error de la API de Claude", detail: errText });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text : "";
    const cleaned = raw.replace(/^```json\s*|```$/g, "").trim();

    let reportJson;
    try {
      reportJson = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: "La respuesta del modelo no fue JSON válido", raw });
    }

    return res.status(200).json(reportJson);
  } catch (err) {
    return res.status(500).json({ error: "Error interno", detail: String(err) });
  }
}
