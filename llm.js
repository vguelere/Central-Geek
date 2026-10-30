// Camada de IA da Central Geek.
// Escolhe entre Ollama (local) e OpenAI (API) pela variável LLM_PROVIDER no .env.
// Não precisa instalar nada novo: usa o fetch que o Node já tem.

const provider = () => String(process.env.LLM_PROVIDER || "ollama").trim().toLowerCase();
const ollamaHost = () => String(process.env.OLLAMA_HOST || "http://127.0.0.1:11434").trim().replace(/\/$/, "");
const ollamaModel = () => String(process.env.OLLAMA_MODEL || "qwen2.5:7b").trim();
const openaiBase = () => String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/$/, "");
const openaiModel = () => String(process.env.OPENAI_MODEL || "gpt-6-astra").trim();
const openaiEffort = () => String(process.env.OPENAI_REASONING_EFFORT || "low").trim().toLowerCase();

function currentModel() {
  return provider() === "openai" ? openaiModel() : ollamaModel();
}

// Junta os trechos de texto da resposta da Responses API.
function extractOpenAIText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  let text = "";
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (item.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text.trim();
}

async function generateOpenAI(prompt, { json, maxTokens, timeout }) {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  if (!key) throw new Error("OPENAI_API_KEY não está configurada no arquivo .env.");
  const body = {
    model: openaiModel(),
    input: prompt,
    reasoning: { effort: openaiEffort() },
    // O limite da OpenAI inclui os tokens de raciocínio; a folga evita cortar a matéria.
    max_output_tokens: maxTokens + 6000
  };
  if (json) body.text = { format: { type: "json_object" } };
  const response = await fetch(`${openaiBase()}/responses`, {
    method: "POST",
    signal: AbortSignal.timeout(timeout),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || `HTTP ${response.status}`;
    if (response.status === 401) throw new Error("A chave da OpenAI foi recusada (401). Confira OPENAI_API_KEY.");
    if (response.status === 429) throw new Error(`Limite ou saldo da API da OpenAI esgotado (429): ${detail}`);
    throw new Error(`Erro da OpenAI: ${detail}`);
  }
  const text = extractOpenAIText(data);
  if (!text && data.status === "incomplete") throw new Error("A OpenAI cortou a resposta antes do texto. Aumente o limite de tokens ou reduza OPENAI_REASONING_EFFORT.");
  return text;
}

async function generateOllama(prompt, { json, temperature, topP, repeatPenalty, numCtx, maxTokens, timeout }) {
  const response = await fetch(`${ollamaHost()}/api/generate`, {
    method: "POST",
    signal: AbortSignal.timeout(timeout),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel(), prompt, stream: false,
      format: json ? "json" : undefined,
      options: { temperature, top_p: topP, repeat_penalty: repeatPenalty, num_ctx: numCtx, num_predict: maxTokens }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "erro do Ollama");
  return String(data.response || "").trim();
}

// Ponto único de geração de texto. As opções temperature/topP/repeatPenalty/numCtx só valem no Ollama
// (modelos de raciocínio da OpenAI não aceitam temperature).
async function generate(prompt, opts = {}) {
  const options = { json: false, maxTokens: 4000, timeout: 180000, ...opts };
  return provider() === "openai" ? generateOpenAI(prompt, options) : generateOllama(prompt, options);
}

// Usado pelo /api/scarlet/status e pelo log de inicialização.
async function status() {
  const model = currentModel();
  if (provider() === "openai") {
    const hasKey = !!String(process.env.OPENAI_API_KEY || "").trim();
    return hasKey
      ? { provider: "openai", configured: true, connected: true, model, modelAvailable: true, models: [model] }
      : { provider: "openai", configured: false, connected: false, model, modelAvailable: false, error: "Defina OPENAI_API_KEY no arquivo .env e reinicie o servidor." };
  }
  try {
    const response = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Ollama respondeu com erro.");
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const modelAvailable = models.some(item => item.name === model || item.name?.startsWith(`${model.split(":")[0]}:`));
    return { provider: "ollama", configured: true, connected: true, model, modelAvailable, models: models.map(item => item.name) };
  } catch {
    return { provider: "ollama", configured: false, connected: false, model, modelAvailable: false, error: "Ollama não está respondendo em localhost:11434. Abra o aplicativo Ollama e tente novamente." };
  }
}

module.exports = { generate, status, currentModel, provider };
