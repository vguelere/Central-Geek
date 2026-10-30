const filesEl = document.getElementById("pdf-files");
const listStatus = document.getElementById("list-status");
const pdfCount = document.getElementById("pdf-count");
const readStatus = document.getElementById("read-status");
const textArea = document.getElementById("pdf-text");
const textStats = document.getElementById("text-stats");
const downloadButton = document.getElementById("download-txt");
const copyButton = document.getElementById("copy-text");
const scarletButton = document.getElementById("ask-scarlet");
const scarletPanel = document.getElementById("scarlet-panel");
const scarletStatus = document.getElementById("scarlet-status");
const scarletResult = document.getElementById("scarlet-result");
let selectedFilename = "";
let extractedText = "";
let scarletData = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function slugify(value = "texto-extraido") {
  return String(value).replace(/\.pdf$/i, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "texto-extraido";
}
function saveText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadText() {
  if (!textArea.value || !selectedFilename) return;
  saveText(`${slugify(selectedFilename)}-texto-extraido.txt`, textArea.value);
}
function getSummaryText() {
  if (!scarletData) return "";
  return `${scarletData.title}\n${scarletData.standfirst || ""}\n\n${(scarletData.summaryParagraphs || []).join("\n\n")}\n\nSEO PARA WORDPRESS\nMetadescrição: ${scarletData.metaDescription || ""}\nSlug: ${scarletData.slug || ""}\nFrase-chave de foco: ${scarletData.focusKeyphrase || ""}${scarletData.verify?.length ? `\n\nCHECAGEM EDITORIAL\n${scarletData.verify.map(x => `- ${x}`).join("\n")}` : ""}\n\n${scarletData.note || ""}`;
}
async function copyContent(content, statusEl) {
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    statusEl.textContent = "Conteúdo copiado para a área de transferência.";
  } catch {
    textArea.value = content;
    textArea.focus();
    textArea.select();
    statusEl.textContent = "Não foi possível copiar automaticamente. O conteúdo está selecionado; use Ctrl+C.";
  }
}
async function copyText() { await copyContent(textArea.value, readStatus); }
async function readPdf(filename) {
  selectedFilename = filename;
  scarletData = null;
  scarletPanel.hidden = true;
  scarletResult.hidden = true;
  scarletButton.disabled = true;
  document.querySelectorAll(".pdf-item").forEach(item => item.classList.toggle("active", item.dataset.filename === filename));
  readStatus.textContent = `Lendo ${filename}…`;
  textStats.textContent = "Extraindo…";
  textArea.value = "";
  extractedText = "";
  downloadButton.disabled = true;
  copyButton.disabled = true;
  document.querySelectorAll(".pdf-item").forEach(item => item.disabled = true);
  try {
    const response = await fetch("/api/read-pdf", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Não foi possível ler o PDF.");
    extractedText = data.text;
    textArea.value = data.text;
    textStats.textContent = `${data.pages || "?"} páginas · ${data.characters.toLocaleString("pt-BR")} caracteres`;
    readStatus.textContent = "Texto extraído. Você pode editar o conteúdo ou chamar a Scarlet para preparar a matéria.";
    downloadButton.disabled = false;
    copyButton.disabled = false;
    scarletButton.disabled = false;
  } catch (error) {
    readStatus.textContent = error.message;
    textStats.textContent = "Falha na leitura";
  } finally {
    document.querySelectorAll(".pdf-item").forEach(item => item.disabled = false);
  }
}
async function loadPdfs() {
  listStatus.textContent = "Consultando a pasta pdf-materia…";
  filesEl.innerHTML = "";
  try {
    const response = await fetch("/api/pdfs");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Não foi possível listar os PDFs.");
    pdfCount.textContent = `${data.files.length} PDF${data.files.length === 1 ? "" : "s"}`;
    if (!data.files.length) {
      listStatus.textContent = "Nenhum PDF encontrado. Coloque arquivos .pdf na pasta pdf-materia e atualize a lista.";
      return;
    }
    listStatus.textContent = "Clique em um arquivo para extrair o texto.";
    filesEl.innerHTML = data.files.map(file => `<button class="pdf-item" type="button" data-filename="${escapeHtml(file.name)}"><strong>${escapeHtml(file.name)}</strong><span>${formatSize(file.size)} · ${new Date(file.modifiedAt).toLocaleString("pt-BR")}</span></button>`).join("");
    filesEl.querySelectorAll(".pdf-item").forEach(button => button.addEventListener("click", () => readPdf(button.dataset.filename)));
  } catch (error) { listStatus.textContent = error.message; }
}
function renderList(targetId, items) {
  const target = document.getElementById(targetId);
  target.innerHTML = (items || []).length ? items.map(item => `<li>${escapeHtml(item)}</li>`).join("") : "<li>Nenhum item indicado.</li>";
}
async function loadRelatedImages(queries) {
  const target = document.getElementById("scarlet-images");
  target.innerHTML = '<div class="empty">Buscando imagens relacionadas no Pinterest, Tudum, IMDb e Flim…</div>';
  const unique = new Map();
  let sourceLinks = [];
  for (const query of (queries || []).slice(0, 3)) {
    try {
      const response = await fetch(`/api/images?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      sourceLinks = data.sources || sourceLinks;
      (data.images || []).forEach(image => { if (image.page && !unique.has(image.page)) unique.set(image.page, image); });
    } catch {}
    if (unique.size >= 16) break;
  }
  const images = [...unique.values()].slice(0, 16);
  const sourceHtml = sourceLinks.length ? `<div class="image-source-links">${sourceLinks.map(source => `<a class="image-source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Pesquisar no ${escapeHtml(source.name)} ↗</a>`).join("")}</div>` : "";
  if (!images.length) {
    target.innerHTML = `${sourceHtml}<div class="empty">Não encontrei miniaturas indexadas para este assunto. Use os links acima para pesquisar diretamente nas fontes.</div>`;
    return;
  }
  target.innerHTML = `${sourceHtml}${images.map(image => `<article class="image-card"><a href="${escapeHtml(image.page)}" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="${escapeHtml(image.thumb)}" alt="${escapeHtml(image.title)}" referrerpolicy="no-referrer"></a><div class="image-info"><h4>${escapeHtml(image.title)}</h4><p>Fonte: ${escapeHtml(image.source || "Site de origem")}</p><p>Crédito/licença: confira na página original.</p><a href="${escapeHtml(image.page)}" target="_blank" rel="noopener noreferrer">Abrir imagem na fonte ↗</a></div></article>`).join("")}`;
}

function renderScarlet(data) {
  scarletData = data;
  document.getElementById("scarlet-category").textContent = data.category || "Cultura geek";
  document.getElementById("scarlet-title").textContent = data.title || "Resumo da matéria";
  document.getElementById("scarlet-standfirst").textContent = data.standfirst || "";
  document.getElementById("scarlet-summary").innerHTML = (data.summaryParagraphs || []).map(p => `<p>${escapeHtml(p)}</p>`).join("");
  
  document.getElementById("scarlet-meta-description").textContent = data.metaDescription || "Metadescrição não gerada.";
  document.getElementById("scarlet-slug").textContent = data.slug || slugify(data.title);
  document.getElementById("scarlet-focus-keyphrase").textContent = data.focusKeyphrase || "Frase-chave não gerada.";
  renderList("scarlet-verify", data.verify || []);
  document.getElementById("scarlet-verify-wrap").hidden = !(data.verify || []).length;
  document.getElementById("scarlet-note").textContent = data.note || "Confira os fatos e a licença das imagens antes de publicar.";
  scarletResult.hidden = false;
  scarletStatus.textContent = "Pronto. O texto foi limpo sem acrescentar comentários ou opiniões.";
  loadRelatedImages(data.imageQueries || []);
}
async function askScarlet() {
  if (!selectedFilename) return;
  scarletPanel.hidden = false;
  scarletResult.hidden = true;
  scarletButton.disabled = true;
  scarletButton.textContent = "Scarlet está analisando…";
  scarletStatus.textContent = "A Scarlet está processando o texto atual. Matérias longas podem levar alguns minutos.";
  try {
    const response = await fetch("/api/scarlet", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: selectedFilename, text: textArea.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Não foi possível analisar o PDF.");
    renderScarlet(data);
  } catch (error) {
    scarletStatus.textContent = error.message;
  } finally {
    scarletButton.disabled = false;
    scarletButton.textContent = "✦ Scarlet: revisar matéria";
  }
}
downloadButton.addEventListener("click", downloadText);
copyButton.addEventListener("click", copyText);
document.getElementById("clear-text").addEventListener("click", () => {
  textArea.value = ""; extractedText = ""; downloadButton.disabled = true; copyButton.disabled = true;
  textStats.textContent = "Texto limpo"; readStatus.textContent = "Área de texto limpa.";
});
scarletButton.addEventListener("click", askScarlet);
document.getElementById("copy-summary").addEventListener("click", () => copyContent(getSummaryText(), scarletStatus));
document.getElementById("download-summary").addEventListener("click", () => {
  if (scarletData) saveText(`${slugify(scarletData.title)}-scarlet.txt`, getSummaryText());
});
document.getElementById("download-cleaned").addEventListener("click", () => {
  if (scarletData?.cleanedText) saveText(`${slugify(scarletData.title)}-texto-limpo.txt`, scarletData.cleanedText);
});
document.getElementById("reload-pdfs").addEventListener("click", loadPdfs);
loadPdfs();
