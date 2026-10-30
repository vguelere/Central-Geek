const express = require("express");
const Parser = require("rss-parser");
const path = require("path");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const pdfParse = require("pdf-parse");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const llm = require("./llm");

const app = express();
const parser = new Parser({ timeout: 12000 });
const PORT = process.env.PORT || 3000;
const PDF_MATERIA_DIR = path.join(__dirname, "pdf-materia");
const DATA_DIR = path.join(__dirname, "data");
const SOURCES_FILE = path.join(DATA_DIR, "portals.json");
fs.mkdirSync(PDF_MATERIA_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const defaultSources = [
  { name: "AdoroCinema", domain: "adorocinema.com" },
  { name: "Ei Nerd", domain: "einerd.com" },
  { name: "Omelete", domain: "omelete.com.br" }
];
function loadSources() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
    return Array.isArray(parsed) && parsed.length ? parsed : defaultSources;
  } catch { return defaultSources; }
}
let sources = loadSources();
function saveSources() { fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2), "utf8"); }
if (!fs.existsSync(SOURCES_FILE)) saveSources();

const categories = {
  "Anime": ["anime", "otaku", "one piece", "naruto", "dragon ball", "demon slayer", "crunchyroll", "animação japonesa"],
  "Manga": ["mangá", "manga", "shonen jump", "volume de mangá", "capítulo de mangá", "manga plus"],
  "Cinema e TV": ["filme", "cinema", "bilheteria", "estreia", "trailer", "série", "serie", "temporada", "episódio", "streaming", "netflix", "disney+", "prime video", "hbo", "oscar", "elenco"],
  "Quadrinhos": ["quadrinhos", "hq", "graphic novel", "comic book", "marvel comics", "dc comics", "panini", "gibi"],
  "Games": ["videogame", "video game", "gameplay", "jogo", "jogos", "playstation", "xbox", "nintendo", "steam", "gta", "esports", "e-sports", "dlc", "game pass", "console", "lançamento de game", "patch notes", "jogabilidade", "rpg", "fps", "switch 2"],
  "Tech": ["tecnologia da informação", "inteligência artificial", "machine learning", "aprendizado de máquina", "programação", "linguagem de programação", "código-fonte", "desenvolvedor", "desenvolvimento de software", "software", "hardware", "computador", "notebook", "processador", "placa de vídeo", "cibersegurança", "segurança digital", "cloud computing", "computação em nuvem", "banco de dados", "open source", "github", "linux", "windows 11", "android", "ios", "smartphone", "nvidia", "amd", "intel", "aplicativo", "internet", "startup de tecnologia", "robótica", "chip", "data center", "devops", "api", "frontend", "backend", "web development"],
  "Mundo Pop": ["influenciador", "influenciadora", "celebridade", "celebridades", "famoso", "famosa", "ator", "atriz", "cantor", "cantora", "artista", "modelo", "streamer", "youtuber", "tiktoker", "vida pessoal", "namoro", "casamento", "separação", "fortuna de", "bilionário", "bilionária", "herdeiro", "herdeira", "luxo", "mansão", "família de", "entrevista", "polêmica", "fãs", "seguidores", "cultura pop", "star wars", "harry potter", "fantasia", "ficção científica", "ficcao cientifica", "geek", "nerd"],
  "Esporte": ["esporte", "futebol", "basquete", "nba", "olimpíada", "olimpiada", "campeonato", "corrida", "formula 1", "ufc", "wwe", "luta", "atleta"],
  "Listas": ["lista", "listas", "top 10", "top 5", "melhores", "piores", "ranking", "ordem para assistir", "todos os filmes"]
};

function classify(text) {
  const value = (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const has = term => value.includes(term.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
  // Games tem prioridade sobre termos genéricos de tecnologia; celebridades vão para Mundo Pop.
  const gameTerms = categories.Games;
  if (gameTerms.some(has)) return "Games";
  const popTerms = categories["Mundo Pop"];
  if (popTerms.some(has)) return "Mundo Pop";
  let best = "Mundo Pop", score = 0;
  for (const [category, words] of Object.entries(categories)) {
    if (category === "Games" || category === "Mundo Pop") continue;
    const current = words.reduce((sum, word) => sum + (has(word) ? (word.length > 8 ? 2 : 1) : 0), 0);
    if (current > score) { score = current; best = category; }
  }
  return best;
}

function googleNewsRss(domain, recentOnly = true) {
  const queryText = recentOnly ? `site:${domain} when:7d` : `site:${domain}`;
  const query = encodeURIComponent(queryText);
  // O portal cadastrado pode publicar em português mesmo quando usa domínio .com.
  // Priorizamos pt-BR para a central editorial brasileira e tentamos uma busca sem limite de data como fallback.
  return `https://news.google.com/rss/search?q=${query}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
}

const FEED_PATHS = ["/feed", "/feed/", "/rss", "/rss/", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/feeds/posts/default"];
const FEED_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; CentralGeek/1.1)", "Accept": "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8" };

async function tryParseFeed(feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);
    if (Array.isArray(feed.items) && feed.items.some(item => item && (item.link || item.guid) && (item.title || item.contentSnippet))) {
      return { feedUrl, feed };
    }
  } catch (_) {}
  return null;
}

async function discoverFeed(domain) {
  const homepage = `https://${domain}/`;
  const candidates = [];
  try {
    const response = await fetch(homepage, { redirect: "follow", signal: AbortSignal.timeout(7000), headers: FEED_HEADERS });
    const finalUrl = new URL(response.url || homepage);
    if (response.ok && ["http:", "https:"].includes(finalUrl.protocol) && (finalUrl.hostname.toLowerCase() === domain || finalUrl.hostname.toLowerCase().endsWith(`.${domain}`))) {
      const html = (await response.text()).slice(0, 2_000_000);
      const base = finalUrl.origin;
      const linkTag = /<link\b[^>]*>/gi;
      let match;
      while ((match = linkTag.exec(html)) !== null) {
        const tag = match[0];
        const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
        const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (href && (/rss|atom|xml/i.test(type) || /application\/(rss|atom)\+xml/i.test(type))) {
          try { candidates.push(new URL(href.replace(/&amp;/g, "&"), base).href); } catch (_) {}
        }
      }
    }
  } catch (_) {}
  for (const pathPart of FEED_PATHS) {
    try { candidates.push(new URL(pathPart, homepage).href); } catch (_) {}
  }
  const safeCandidates = [...new Set(candidates)].filter(url => {
    try {
      const parsed = new URL(url);
      return ["http:", "https:"].includes(parsed.protocol) && (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
    } catch (_) { return false; }
  });
  const detected = await Promise.all(safeCandidates.map(url => tryParseFeed(url)));
  return detected.find(Boolean)?.feedUrl || null;
}

function safePortalUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null;
    if (!host.includes(".") || host.length > 253) return null;
    return { name: host.split(".").slice(0, -1).join(".").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()), domain: host };
  } catch { return null; }
}
app.get("/api/sources", (req, res) => res.json({ sources }));
app.post("/api/sources", async (req, res) => {
  const raw = String(req.body?.url || "").trim();
  const candidate = safePortalUrl(raw);
  if (!candidate) return res.status(400).json({ error: "Informe um endereço público válido, como https://www.exemplo.com.br." });
  const exists = sources.find(s => s.domain === candidate.domain || s.domain.endsWith(`.${candidate.domain}`) || candidate.domain.endsWith(`.${s.domain}`));
  if (exists) return res.status(409).json({ error: `${exists.name} já está cadastrado.`, source: exists, sources });
  // Descobre RSS/Atom do próprio portal durante o cadastro. A fonte ainda pode ser cadastrada
  // quando não há feed detectável; nesse caso, a busca do Google News será usada como alternativa.
  candidate.feedUrl = await discoverFeed(candidate.domain);
  candidate.feedStatus = candidate.feedUrl ? "rss-detected" : "google-news-fallback";
  sources.push(candidate);
  try { saveSources(); } catch { sources = sources.filter(s => s.domain !== candidate.domain); return res.status(500).json({ error: "Não foi possível salvar o portal no banco local." }); }
  res.status(201).json({ source: candidate, sources, message: candidate.feedUrl ? "Feed RSS/Atom encontrado." : "Portal cadastrado. Nenhum feed foi detectado; será usada a busca alternativa." });
});


app.delete("/api/sources/:domain", (req, res) => {
  const domain = String(req.params.domain || "").toLowerCase();
  const existing = sources.find(source => source.domain === domain);
  if (!existing) return res.status(404).json({ error: "Portal não encontrado." });
  const previous = sources;
  sources = sources.filter(source => source.domain !== domain);
  try { saveSources(); }
  catch { sources = previous; return res.status(500).json({ error: "Não foi possível salvar a remoção do portal." }); }
  return res.json({ removed: existing, sources });
});

app.get("/api/news", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const results = [];
  const errors = [];
  await Promise.all(sources.map(async source => {
    const portalResults = [];
    const sourceErrors = [];
    // 1) Consulta o feed oficial detectado/salvo no cadastro.
    let feedUrl = source.feedUrl || null;
    if (!feedUrl) {
      feedUrl = await discoverFeed(source.domain);
      if (feedUrl) {
        source.feedUrl = feedUrl;
        source.feedStatus = "rss-detected";
        try { saveSources(); } catch (_) {}
      }
    }
    if (feedUrl) {
      const direct = await tryParseFeed(feedUrl);
      if (direct) {
        for (const item of (direct.feed.items || []).slice(0, 60)) {
          const title = String(item.title || "").replace(/\s+-\s+[^-]{1,80}$/i, "").trim();
          const link = item.link || item.guid || "";
          const text = `${title} ${item.contentSnippet || ""} ${(item.categories || []).join(" ")}`;
          if (title && link) portalResults.push({
            id: `${source.domain}-${Buffer.from(title).toString("base64").slice(0, 18)}`,
            title, source: source.name, link,
            date: item.isoDate || item.pubDate || "",
            summary: String(item.contentSnippet || item.summary || "").replace(/<[^>]*>/g, "").slice(0, 280),
            category: classify(text)
          });
        }
      } else {
        sourceErrors.push("o feed detectado não respondeu corretamente");
        source.feedUrl = null;
        source.feedStatus = "google-news-fallback";
        try { saveSources(); } catch (_) {}
      }
    }
    // 2) Complementa/usa fallback do Google News em pt-BR. Sem filtro temporal no segundo passe,
    // para portais menores que não têm muitas matérias indexadas nos últimos sete dias.
    for (const recentOnly of [true, false]) {
      if (!recentOnly && portalResults.length >= 15) break;
      try {
        const feed = await parser.parseURL(googleNewsRss(source.domain, recentOnly));
        for (const item of (feed.items || []).slice(0, recentOnly ? 40 : 20)) {
          const title = String(item.title || "").replace(/\s+-\s+[^-]{1,100}$/i, "").trim();
          const link = item.link || "";
          const text = `${title} ${item.contentSnippet || ""} ${(item.categories || []).join(" ")}`;
          if (title && link) portalResults.push({
            id: `${source.domain}-${Buffer.from(title).toString("base64").slice(0, 18)}`,
            title, source: source.name, link,
            date: item.isoDate || item.pubDate || "",
            summary: String(item.contentSnippet || "").replace(/<[^>]*>/g, "").slice(0, 280),
            category: classify(text)
          });
        }
      } catch (e) {
        sourceErrors.push("Google News não respondeu à consulta");
      }
    }
    results.push(...portalResults);
    if (!portalResults.length) {
      const detail = sourceErrors.length ? [...new Set(sourceErrors)].join("; ") : "nenhuma notícia encontrada no RSS ou no Google News";
      errors.push(`${source.name}: ${detail}.`);
    }
  }));
  const unique = [...new Map(results.filter(x => x.title && x.link).map(x => [x.link, x])).values()]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  res.json({ updatedAt: new Date().toISOString(), articles: unique, errors, sourceDiagnostics: sources.map(s => ({ name: s.name, domain: s.domain, feedStatus: s.feedStatus || (s.feedUrl ? "rss-detected" : "google-news-fallback"), feedUrl: s.feedUrl || null })) });
});


function isAllowedArticleUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // Bloqueia nomes locais e endereços IP literais; aceita links HTTPS de portais públicos,
    // inclusive os que ainda não foram cadastrados na Central Geek.
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test")) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
    return host.includes(".");
  } catch { return false; }
}

// Baixa somente o HTML da página individual, sem copiar o site inteiro nem os arquivos de mídia.
app.post("/api/download-page", async (req, res) => {
  const { link } = req.body || {};
  if (!link || !isAllowedArticleUrl(link)) {
    return res.status(400).json({ error: "Informe um link HTTPS público válido de uma matéria." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const pageResponse = await fetch(link, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CentralGeekResearch/1.0; +https://hqcerol.com.br)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    if (!pageResponse.ok) throw new Error(`A fonte respondeu com status ${pageResponse.status}.`);

    const finalUrl = pageResponse.url || link;
    if (!isAllowedArticleUrl(finalUrl)) {
      throw new Error("O link redirecionou para um endereço que não pode ser acessado com segurança.");
    }
    const contentType = pageResponse.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("O link não retornou uma página HTML.");
    }

    let html = await pageResponse.text();
    if (!html || html.length < 100) throw new Error("A página retornou conteúdo vazio ou incompleto.");
    if (html.length > 12 * 1024 * 1024) throw new Error("A página é muito grande para baixar por esta ferramenta.");

    // Mantém a página original em um único arquivo e permite que imagens/CSS remotos
    // continuem sendo referenciados pela URL original quando o HTML for aberto.
    const baseTag = `<base href="${finalUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b[^>]*>/i, match => `${match}\n${baseTag}`);
    } else {
      html = `<!doctype html><html><head><meta charset="utf-8">${baseTag}</head><body>${html}</body></html>`;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.json({ html, finalUrl });
  } catch (error) {
    const message = error.name === "AbortError"
      ? "A página demorou demais para responder. Tente novamente."
      : error.message || "Não foi possível baixar o HTML da página.";
    res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
});


// Usa um navegador já instalado para evitar falhas no download automático do Chromium.
function findBrowserExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

// Renderiza a página original em PDF usando Chromium headless.
app.post("/api/download-page-pdf", async (req, res) => {
  const { link, title } = req.body || {};
  if (!link || !isAllowedArticleUrl(link)) {
    return res.status(400).json({ error: "Informe um link HTTPS público válido de uma matéria." });
  }

  let browser;
  try {
    const browserPath = findBrowserExecutable();
    if (!browserPath) {
      throw new Error("Não encontrei o Google Chrome ou o Microsoft Edge instalado. Instale um deles ou configure PUPPETEER_EXECUTABLE_PATH no arquivo .env.");
    }
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(35000);
    await page.goto(link, { waitUntil: "networkidle2", timeout: 35000 });

    const finalUrl = page.url();
    if (!isAllowedArticleUrl(finalUrl)) {
      throw new Error("O link redirecionou para um endereço que não pode ser acessado com segurança.");
    }

    // Tenta carregar imagens e conteúdo lazy-loaded antes de imprimir.
    await page.evaluate(async () => {
      const images = Array.from(document.images);
      await Promise.all(images.map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 4000);
        });
      }));
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(resolve => setTimeout(resolve, 700));
      window.scrollTo(0, 0);
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div style="font-size:8px;width:100%;margin:0 12mm;color:#777;"></div>',
      footerTemplate: '<div style="font-size:8px;width:100%;margin:0 12mm;color:#777;display:flex;justify-content:space-between;"><span>Fonte: ' + finalUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</span><span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>',
      margin: { top: "15mm", right: "12mm", bottom: "18mm", left: "12mm" },
      timeout: 35000
    });

    const safeTitle = String(title || "materia-geek")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "materia-geek";
    const pdfBuffer = Buffer.from(pdf);
    const fileName = `${safeTitle}-original.pdf`;
    // Guarda uma cópia na pasta monitorada pela página Leitora de PDFs.
    await fs.promises.writeFile(path.join(PDF_MATERIA_DIR, fileName), pdfBuffer);
    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(pdfBuffer);
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "A página demorou demais para carregar. Tente novamente."
      : error.message || "Não foi possível gerar o PDF da página.";
    if (!res.headersSent) res.status(502).json({ error: message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post("/api/extract-article", async (req, res) => {
  const { link, title, source, date } = req.body || {};
  if (!link || !isAllowedArticleUrl(link)) {
    return res.status(400).json({ error: "Informe um link HTTPS público válido de uma matéria." });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let pageResponse;
    try {
      pageResponse = await fetch(link, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CentralGeekResearch/1.0; +https://hqcerol.com.br)",
          "Accept": "text/html,application/xhtml+xml"
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!pageResponse.ok) throw new Error(`A fonte respondeu com status ${pageResponse.status}.`);
    const finalUrl = pageResponse.url || link;
    if (!isAllowedArticleUrl(finalUrl)) {
      throw new Error("O link redirecionou para um endereço que não pode ser acessado com segurança.");
    }
    const contentType = pageResponse.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("A página original não retornou um documento HTML legível.");
    }

    const html = await pageResponse.text();
    const dom = new JSDOM(html, { url: finalUrl });
    const parsed = new Readability(dom.window.document).parse();
    dom.window.close();
    const articleText = (parsed?.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!articleText || articleText.length < 200) {
      throw new Error("Não foi possível extrair texto suficiente. O portal pode bloquear a leitura automática; use a aba aberta para ler a matéria.");
    }

    res.json({
      title: parsed.title || title || "Matéria original",
      source: source || parsed.siteName || "Fonte original",
      date: date || "",
      sourceUrl: finalUrl,
      text: articleText,
      extractedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = error.name === "AbortError"
      ? "A página demorou demais para responder. A matéria foi aberta em outra aba; tente novamente para baixar o texto."
      : error.message || "Não foi possível extrair o texto da matéria.";
    res.status(502).json({ error: message });
  }
});

// Lista somente os PDFs colocados na pasta local pdf-materia.
app.get("/api/pdfs", async (req, res) => {
  try {
    const entries = await fs.promises.readdir(PDF_MATERIA_DIR, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map(async entry => {
        const stat = await fs.promises.stat(path.join(PDF_MATERIA_DIR, entry.name));
        return { name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      }));
    files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: "Não foi possível listar os PDFs da pasta pdf-materia." });
  }
});

// Extrai o texto de um PDF selecionado. O nome é reduzido a basename para impedir caminhos externos.
app.post("/api/read-pdf", async (req, res) => {
  const requestedName = String(req.body?.filename || "");
  const filename = path.basename(requestedName);
  if (!filename || filename !== requestedName || !filename.toLowerCase().endsWith(".pdf")) {
    return res.status(400).json({ error: "Selecione um arquivo PDF válido da pasta pdf-materia." });
  }

  const filePath = path.join(PDF_MATERIA_DIR, filename);
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) {
      return res.status(400).json({ error: "O arquivo não é válido ou ultrapassa o limite de 50 MB." });
    }
    const buffer = await fs.promises.readFile(filePath);
    const parsed = await pdfParse(buffer);
    const text = String(parsed.text || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) {
      return res.status(422).json({ error: "Não encontrei texto selecionável neste PDF. Se ele for apenas um escaneamento/imagem, será necessário aplicar OCR." });
    }
    res.json({ filename, text, pages: parsed.numpages || null, characters: text.length });
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).json({ error: "Esse PDF não foi encontrado na pasta pdf-materia." });
    res.status(422).json({ error: "Não consegui ler esse PDF. Ele pode estar corrompido, protegido por senha ou ser incompatível." });
  }
});

// Mostra qual provedor de IA está ativo (Ollama local ou OpenAI) e se está pronto para uso.
app.get("/api/scarlet/status", async (req, res) => res.json(await llm.status()));

function dedupeArticleParagraphs(paragraphs, standfirst = "") {
  const seen = [];
  const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = value => new Set(normalize(value).split(" ").filter(word => word.length > 3));
  const tooSimilar = (a, b) => {
    const aa = tokens(a), bb = tokens(b);
    if (aa.size < 6 || bb.size < 6) return normalize(a) === normalize(b);
    const overlap = [...aa].filter(word => bb.has(word)).length;
    return overlap / new Set([...aa, ...bb]).size >= 0.76;
  };
  if (standfirst) seen.push(standfirst);
  const output = [];
  for (const paragraph of Array.isArray(paragraphs) ? paragraphs : []) {
    const sentences = String(paragraph || "").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [String(paragraph || "")];
    const kept = [];
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      if (seen.some(previous => tooSimilar(trimmed, previous))) continue;
      kept.push(trimmed);
      seen.push(trimmed);
    }
    if (kept.length) output.push(kept.join(" "));
  }
  return output.slice(0, 3);
}

// Scarlet: faz uma limpeza objetiva do texto extraído, sem acrescentar opinião editorial.
app.post("/api/scarlet", async (req, res) => {
  const requestedName = String(req.body?.filename || "");
  const filename = requestedName ? path.basename(requestedName) : "";
  const submittedText = typeof req.body?.text === "string" ? req.body.text : "";
  if ((filename && (filename !== requestedName || !filename.toLowerCase().endsWith(".pdf"))) || (!filename && submittedText.trim().length < 100)) {
    return res.status(400).json({ error: "Envie um PDF válido ou o texto completo da matéria (mínimo de 100 caracteres)." });
  }

  const model = llm.currentModel();

  try {
    const filePath = filename ? path.join(PDF_MATERIA_DIR, filename) : null;
    if (filePath) {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) {
        return res.status(400).json({ error: "O arquivo não é válido ou ultrapassa o limite de 50 MB." });
      }
    }
    // Texto importado por URL/colagem tem prioridade; PDF continua compatível como antes.
    let parsedPdf = null;
    let sourceText = submittedText.trim();
    if (!sourceText && filePath) {
      const buffer = await fs.promises.readFile(filePath);
      parsedPdf = await pdfParse(buffer);
      sourceText = String(parsedPdf.text || "");
    }
    const rawText = sourceText
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 28000);
    if (rawText.length < 100) {
      return res.status(422).json({ error: "O PDF não contém texto suficiente para a Scarlet analisar. Se for uma digitalização, será necessário OCR." });
    }

    const reviewer = String(req.body?.reviewer || "scarlet").toLowerCase() === "brad" ? "Brad" : "Scarlet";
    const defaultPersonality = reviewer === "Brad"
      ? "Editor geek analítico, direto e provocador. Dá ritmo ao texto, destaca o que realmente importa e contextualiza com inteligência, sem inventar fatos, exagerar ou transformar a matéria em resumo."
      : "Jornalista geek perspicaz, atual e dinâmica. Escreve com ritmo, clareza e personalidade, preservando os fatos, a essência e a extensão da matéria original. Remove links, menus e ruídos sem cortar informações importantes.";
    const personality = String(req.body?.personality || defaultPersonality).replace(/[<>]/g, "").trim().slice(0, 500) || defaultPersonality;
    // Revisão por blocos como caminho principal: evita que o modelo tente devolver
    // uma reportagem longa e todos os metadados dentro de um único JSON truncado.
    const sourceTitle = String(req.body?.title || (filename ? path.basename(filename, ".pdf") : "Matéria importada")).replace(/[_-]+/g, " ").trim();
    const paragraphs = rawText.split(/\n\s*\n+/).map(x => x.trim()).filter(Boolean);
    const chunks = [];
    let current = "";
    const addPiece = piece => {
      const value = String(piece || "").trim();
      if (!value) return;
      if (current && current.length + value.length + 2 > 2200) { chunks.push(current); current = ""; }
      current += (current ? "\n\n" : "") + value;
    };
    for (const paragraph of paragraphs.length ? paragraphs : [rawText]) {
      if (paragraph.length <= 2200) { addPiece(paragraph); continue; }
      // Divide parágrafos longos em pontos seguros, preferindo limites entre palavras.
      let rest = paragraph;
      while (rest.length > 2200) {
        let cut = rest.lastIndexOf(" ", 2200);
        if (cut < 1200) cut = 2200;
        addPiece(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
      }
      addPiece(rest);
    }
    if (current) chunks.push(current);
    if (!chunks.length) throw new Error("Não encontrei texto para revisar.");

    const revisedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkPrompt = `Você é ${reviewer}, editor do SUPERANIMEHERO. PERSONALIDADE: ${personality}. Revise e reescreva somente o trecho fornecido, mantendo o mesmo idioma do texto original. NÃO traduza o conteúdo, mesmo que esteja em inglês ou espanhol. Preserve todos os fatos, nomes, datas, números, citações, atribuições, exemplos e detalhes. Não faça resumo, não encurte deliberadamente e não acrescente fatos. Remova URLs, menus, anúncios, botões, chamadas de compartilhamento e ruído de navegação. Mantenha o sentido e os parágrafos, com escrita jornalística atual, clara e dinâmica. Devolva apenas o texto final, sem explicações ou aspas. Este é o bloco ${i + 1} de ${chunks.length}; não encerre a matéria antes do fim do trecho.

TÍTULO: ${sourceTitle}

TEXTO ORIGINAL DO BLOCO:
<<<
${chunks[i]}
>>>`;
      let output = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const retryPrompt = attempt === 0 ? chunkPrompt : `REVISE integralmente o texto abaixo, mantendo o mesmo idioma do original. NÃO TRADUZA. NÃO RESUMA. Preserve todos os detalhes e devolva somente o texto revisado, em extensão semelhante ao original. Personalidade editorial: ${personality}.\n\n${chunks[i]}`;
        try {
          output = await llm.generate(retryPrompt, { temperature: 0.1, topP: 0.85, repeatPenalty: 1.03, numCtx: 8192, maxTokens: 4500, timeout: 180000 });
        } catch (err) { throw new Error(`Falha ao revisar o bloco ${i + 1} de ${chunks.length}: ${String(err.message).replace(/\.$/, "")}.`); }
        if (output.length >= Math.min(chunks[i].length * 0.48, 350) || attempt === 1) break;
      }
      if (!output) throw new Error(`O revisor não retornou texto para o bloco ${i + 1}. Confira se o provedor de IA está funcionando e tente novamente.`);
      revisedChunks.push(output);
    }
    const fullCleanedText = revisedChunks.join("\n\n")
      .replace(/https?:\/\/[^\s<>"'\])}]+/gi, "")
      .replace(/\bwww\.[^\s<>"'\])}]+/gi, "")
      .replace(/\n{3,}/g, "\n\n").trim();
    if (!fullCleanedText) throw new Error("O revisor não retornou uma matéria revisada. Tente novamente.");

    const metadataPrompt = `Retorne APENAS JSON válido com as chaves title, standfirst, category, metaDescription, slug, focusKeyphrase, seoTitle e tags. Gere os campos editoriais no mesmo idioma do texto revisado, com base apenas no texto revisado. title: título fiel e claro. standfirst: OBRIGATÓRIO, 1 ou 2 frases com 120 a 200 caracteres. metaDescription: resumo SEO de até 160 caracteres. slug: curta, minúscula, sem acentos e com hífens. focusKeyphrase: termo principal que alguém pesquisaria. seoTitle: título SEO objetivo. tags: array com 5 a 8 tags específicas de pessoas, franquias, obras, empresas, jogos, filmes, séries ou assuntos que realmente apareçam no texto; sem hashtags e sem nome do portal. Não deixe campos vazios. Não invente fatos.
Título da fonte: ${sourceTitle}
Texto revisado:
${fullCleanedText.slice(0, 10000)}`;
    let metadata = {};
    try {
      const metaJson = await llm.generate(metadataPrompt, { json: true, temperature: 0.1, numCtx: 12288, maxTokens: 1800, timeout: 90000 });
      try { metadata = JSON.parse(metaJson); } catch { metadata = {}; }
    } catch (e) { console.warn("Metadados não gerados pela IA; usando alternativas locais:", e.message); }
    const fallbackTitle = sourceTitle || "Matéria revisada";
    const firstSentences = fullCleanedText.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    const makeSlug = value => String(value || "materia-revisada").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
    const localTags = [...new Set((`${fallbackTitle} ${fullCleanedText.slice(0, 1800)}`.match(/[A-ZÀ-Ý][\wÀ-ÿ-]{2,}(?:\s+[A-ZÀ-Ý][\wÀ-ÿ-]{2,}){0,2}/g) || []).map(x => x.trim()).filter(x => x.length > 3))].slice(0, 8);
    result = {
      title: String(metadata.title || fallbackTitle),
      standfirst: String(metadata.standfirst || firstSentences.slice(0, 220) || fallbackTitle),
      category: String(metadata.category || "Cultura geek"),
      metaDescription: String(metadata.metaDescription || firstSentences.slice(0, 160) || fallbackTitle),
      slug: String(metadata.slug || makeSlug(metadata.title || fallbackTitle)),
      focusKeyphrase: String(metadata.focusKeyphrase || fallbackTitle),
      seoTitle: String(metadata.seoTitle || metadata.title || fallbackTitle),
      tags: Array.isArray(metadata.tags) && metadata.tags.length ? metadata.tags : localTags,
      summaryParagraphs: revisedChunks,
      cleanedText: fullCleanedText
    };

    const cleanedText = result.cleanedText.trim()
      .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/gi, "$1")
      .replace(/https?:\/\/[^\s<>"'\])}]+/gi, "")
      .replace(/\bwww\.[^\s<>"'\])}]+/gi, "")
      .replace(/[ \t]+([,.;!?])/g, "$1")
      .replace(/\n{3,}/g, "\n\n");
    // A revisão é gerada em blocos para reduzir truncamentos. Não bloquear a entrega por diferença de tamanho:
    // traduções e remoção de ruídos podem alterar a contagem de caracteres sem perder a matéria.
    const summaryParagraphs = cleanedText
      .split(/\n\s*\n+/)
      .map(paragraph => paragraph.replace(/\s*\n\s*/g, " ").trim())
      .filter(Boolean);
    if (!summaryParagraphs.length) throw new Error("Não foi possível separar os parágrafos do texto limpo.");
    res.json({
      filename,
      model,
      pages: parsedPdf?.numpages || null,
      title: String(result.title).slice(0, 240),
      seoTitle: String(result.seoTitle || result.title || "").slice(0, 240),
      tags: (Array.isArray(result.tags) ? result.tags : [])
        .filter(x => typeof x === "string").map(x => x.trim().replace(/^#/, "")).filter(Boolean).slice(0, 10),
      standfirst: String(result.standfirst || "").trim() || (() => {
        const first = cleanedText.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
        return first.slice(0, 220);
      })(),
      category: String(result.category || "Cultura geek"),
      summaryParagraphs,
      keyPoints: [],
      scarletAnalysis: String(result.scarletAnalysis || ""),
      metaDescription: String(result.metaDescription || "").slice(0, 200),
      slug: String(result.slug || result.title || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90),
      focusKeyphrase: String(result.focusKeyphrase || "").slice(0, 100),
      verify: Array.isArray(result.verify) ? result.verify.filter(x => typeof x === "string").slice(0, 8) : [],
      imageQueries: Array.isArray(result.imageQueries) ? result.imageQueries.filter(x => typeof x === "string").slice(0, 3) : [],
      cleanedText: cleanedText.slice(0, 50000),
      generatedAt: new Date().toISOString(),
      note: "Confira os fatos e as fontes antes de publicar. Verifique a licença e a atribuição de cada imagem."
    });
  } catch (error) {
    const message = error.name === "AbortError"
      ? "A análise da Scarlet demorou demais. Tente novamente."
      : error.message || "Não foi possível analisar este PDF.";
    res.status(502).json({ error: message });
  }
});

// Reescreve a matéria com a personalidade editorial escolhida, sem transformar o texto em resumo.
app.post("/api/metadata/rebuild", async (req, res) => {
  const model = llm.currentModel();
  const sourceText = String(req.body?.text || "").replace(/\r/g, "").trim();
  const referenceTitle = String(req.body?.title || "Matéria").trim().slice(0, 240);
  const sourcePortal = String(req.body?.sourceName || "").trim().slice(0, 160);
  if (sourceText.length < 80) return res.status(422).json({ error: "Cole uma matéria com pelo menos 80 caracteres na Versão revisada." });
  const makeSlug = value => String(value || "materia").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
  const firstSentences = sourceText.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 2).join(" ");
  const fallbackTitle = (firstSentences.split(/(?<=[.!?])\s+/)[0] || referenceTitle || "Matéria").slice(0, 120);
  let metadata = {};
  try {
    const prompt = `Retorne APENAS JSON válido com as chaves title, standfirst, metaDescription, slug, focusKeyphrase, seoTitle e tags. Gere os metadados novamente usando EXCLUSIVAMENTE o texto atualizado abaixo; não reutilize automaticamente os metadados anteriores. Preserve o idioma do texto. Não invente fatos e não inclua o nome do portal de origem${sourcePortal ? ` (${sourcePortal})` : ""}. title: título jornalístico claro e fiel. standfirst: linha fina de 1 ou 2 frases, entre 120 e 220 caracteres. metaDescription: até 160 caracteres. slug: curta, minúscula, sem acentos e com hífens. focusKeyphrase: principal termo de busca. seoTitle: título SEO objetivo. tags: array com 5 a 8 tags específicas e realmente relacionadas ao texto, sem hashtags e sem nome do portal. Não deixe campos vazios.\n\nTÍTULO ANTERIOR (use apenas como contexto, não o reutilize se não representar o texto): ${referenceTitle || "não informado"}\n\nTEXTO ATUALIZADO:\n${sourceText.slice(0, 14000)}`;
    const metaJson = await llm.generate(prompt, { json: true, temperature: 0.15, numCtx: 16384, maxTokens: 1800, timeout: 90000 });
    metadata = JSON.parse(metaJson);
  } catch (error) { console.warn("Atualização de metadados: usando alternativas locais.", error.message); }
  const title = String(metadata.title || fallbackTitle).slice(0, 240);
  const localTags = [...new Set((`${title} ${sourceText.slice(0, 1800)}`.match(/[A-ZÀ-Ý][\wÀ-ÿ-]{2,}(?:\s+[A-ZÀ-Ý][\wÀ-ÿ-]{2,}){0,2}/g) || []).map(x => x.trim()).filter(x => x.length > 3 && (!sourcePortal || x.toLowerCase() !== sourcePortal.toLowerCase())))].slice(0, 8);
  res.json({
    model: metadata.title ? model : "metadados locais (fallback)",
    title,
    standfirst: String(metadata.standfirst || firstSentences.slice(0, 220) || title).slice(0, 240),
    seoTitle: String(metadata.seoTitle || title).slice(0, 240),
    metaDescription: String(metadata.metaDescription || firstSentences.slice(0, 160) || title).slice(0, 200),
    slug: makeSlug(metadata.slug || title),
    focusKeyphrase: String(metadata.focusKeyphrase || title).slice(0, 100),
    tags: Array.isArray(metadata.tags) && metadata.tags.length ? metadata.tags.filter(x => typeof x === "string").map(x => x.trim().replace(/^#/, "")).filter(x => x && (!sourcePortal || x.toLowerCase() !== sourcePortal.toLowerCase())).slice(0, 10) : localTags
  });
});

app.post("/api/scarlet/reduce", async (req, res) => {
  const model = llm.currentModel();
  const sourceText = String(req.body?.text || "").replace(/\r/g, "").trim();
  const title = String(req.body?.title || "Matéria").trim().slice(0, 240);
  const sourcePortal = String(req.body?.sourceName || "").trim().slice(0, 160);
  const targetCharacters = Number(req.body?.targetCharacters);
  const reviewer = String(req.body?.reviewer || "scarlet").toLowerCase() === "brad" ? "Brad" : "Scarlet";
  const defaultPersonality = reviewer === "Brad"
    ? "Editor geek analítico, direto e provocador. Dá ritmo ao texto sem inventar fatos nem transformar a matéria em resumo."
    : "Jornalista geek perspicaz, atual e dinâmica. Preserva fatos, essência e detalhes importantes, com escrita clara e dinâmica.";
  const personality = String(req.body?.personality || defaultPersonality).replace(/[<>]/g, "").trim().slice(0, 500) || defaultPersonality;
  if (sourceText.length < 100) return res.status(422).json({ error: "Não há texto suficiente para reescrever. Primeiro clique em LIMPAR TEXTO." });
  if (!Number.isInteger(targetCharacters) || targetCharacters < 100 || targetCharacters > 50000) {
    return res.status(400).json({ error: "Informe uma quantidade de caracteres entre 100 e 50.000." });
  }
  try {
    const languageRule = "Mantenha exatamente o idioma do texto de entrada. NÃO traduza, mesmo que esteja em inglês ou espanhol.";
    const cleanOutput = value => String(value || "").replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/, "").replace(/^TEXTO (?:FINAL|REESCRITO):\s*/i, "").replace(/https?:\/\/[^\s<>\"'\])}]+/gi, "").replace(/\bwww\.[^\s<>\"'\])}]+/gi, "").replace(/[ \t]+([,.;!?])/g, "$1").replace(/\n{3,}/g, "\n\n").trim();
    async function generate(prompt, numPredict = 10000, timeout = 240000) {
      return llm.generate(prompt, { temperature: 0.25, topP: 0.9, repeatPenalty: 1.05, numCtx: 24576, maxTokens: numPredict, timeout });
    }
    // Trabalha em blocos para não perder o final de matérias longas nem depender de uma resposta enorme.
    const paragraphs = sourceText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const units = [];
    for (const paragraph of paragraphs) {
      if (paragraph.length <= 4800) { units.push(paragraph); continue; }
      // Divide parágrafos excepcionalmente longos por frases, sem descartar conteúdo.
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      let sentenceBuffer = "";
      for (const sentence of sentences) {
        const candidate = sentenceBuffer ? `${sentenceBuffer} ${sentence}` : sentence;
        if (candidate.length > 4800 && sentenceBuffer) { units.push(sentenceBuffer); sentenceBuffer = sentence; }
        else sentenceBuffer = candidate;
      }
      if (sentenceBuffer) units.push(sentenceBuffer);
    }
    const chunks = [];
    let buffer = "";
    for (const unit of units) {
      const candidate = buffer ? `${buffer}\n\n${unit}` : unit;
      if (candidate.length > 5200 && buffer) { chunks.push(buffer); buffer = unit; }
      else buffer = candidate;
    }
    if (buffer) chunks.push(buffer);
    const rewrittenChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const minimumLength = Math.min(chunk.length * 0.78, Math.max(180, chunk.length - 80));
      const prompt = `Você é ${reviewer}, redator e editor independente. PERSONALIDADE EDITORIAL DEFINIDA PELO USUÁRIO: ${personality}\n\nTAREFA: REESCREVER ORIGINALMENTE a matéria abaixo, como um texto próprio do redator, mantendo o foco e a essência da pauta. Isto NÃO é um resumo, NÃO é uma redução mecânica e NÃO é uma limpeza superficial. Reorganize frases e parágrafos, mude a construção e dê ritmo e voz autoral de acordo com a personalidade editorial, sem copiar o estilo promocional do portal de origem.\n\nREGRAS OBRIGATÓRIAS:\n- ${languageRule}\n- Preserve todos os fatos, acontecimentos, nomes de pessoas/personagens/obras/empresas, datas, números, contexto, citações e informações relevantes. Não apague partes importantes e não transforme em texto de 200 ou 300 caracteres.\n- O tamanho de referência informado pelo usuário é ${targetCharacters} caracteres para a matéria completa; use-o como orientação de extensão, NUNCA como limite rígido que obrigue a cortar fatos. Priorize a cobertura completa. Se a meta for incompatível com a quantidade de informações, preserve as informações e entregue o texto completo.\n- Para este bloco, mantenha extensão próxima à fonte (idealmente entre 85% e 120% do tamanho), retirando apenas repetições literais, anúncios, menus, comandos de navegação e ruído claramente alheio à matéria.\n- Não cite nem promova o portal de origem${sourcePortal ? ` (portal: ${sourcePortal})` : ""}; remova referências à publicação como fonte/veículo e não reproduza seus links, URLs, nome de site, chamadas de navegação ou linguagem institucional. Preserve nomes de pessoas, marcas e obras que façam parte da notícia. Não remova atribuições jornalísticas necessárias para entender quem fez uma declaração.\n- Não invente fatos, declarações, opiniões, análises, contexto ou conclusões. A personalidade afeta a escrita, não autoriza inventar opinião.\n- Não inclua título separado, observações, contagem de caracteres, explicações ou frases sobre o processo de reescrita. Devolva somente o texto final do bloco.\n- Este é o bloco ${i + 1} de ${chunks.length}. Reescreva-o como parte de uma matéria contínua; não crie introdução ou conclusão nova só por ser um bloco.\n\nTÍTULO DE REFERÊNCIA: ${title}\n\nTEXTO DE ORIGEM:\n<<<\n${chunk}\n>>>`;
      let rewritten = cleanOutput(await generate(prompt, Math.max(2500, Math.ceil(chunk.length * 1.8)), 240000));
      if (rewritten.length < minimumLength) {
        const retryPrompt = `A resposta anterior ficou curta demais e perdeu conteúdo. Refaça a reescrita do bloco abaixo com extensão próxima à original, preservando todos os fatos e detalhes, sem resumir nem omitir parágrafos. Personalidade editorial: ${personality}. ${languageRule} Não cite o portal de origem${sourcePortal ? ` ${sourcePortal}` : ""}, não inclua URLs e não invente nada. Devolva apenas o texto reescrito.\n\nTEXTO COMPLETO DO BLOCO ORIGINAL:\n<<<\n${chunk}\n>>>`;
        const retry = cleanOutput(await generate(retryPrompt, Math.max(3000, Math.ceil(chunk.length * 2)), 240000));
        if (retry.length > rewritten.length) rewritten = retry;
      }
      if (rewritten.length < Math.min(chunk.length * 0.58, 160)) {
        throw new Error(`O revisor devolveu um trecho muito curto no bloco ${i + 1}. Nenhuma versão foi substituída; tente novamente ou use um modelo maior.`);
      }
      rewrittenChunks.push(rewritten);
    }
    let rewrittenText = cleanOutput(rewrittenChunks.join("\n\n"));
    if (rewrittenText.length < sourceText.length * 0.65 && sourceText.length > 600) {
      throw new Error("A versão gerada ficou muito menor que a matéria de origem. Para não perder informações, o resultado foi bloqueado. Tente novamente com um modelo maior.");
    }
    const fallbackTitle = title || "Matéria reescrita";
    const firstSentences = rewrittenText.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
    const makeSlug = value => String(value || "materia-reescrita").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
    const metadataPrompt = `Retorne APENAS JSON válido com title, standfirst, metaDescription, slug, focusKeyphrase, seoTitle e tags. Crie campos editoriais originais, fiéis ao texto reescrito, no mesmo idioma da matéria. Não traduza, não invente fatos e não mencione nem inclua o nome do portal de origem${sourcePortal ? ` (${sourcePortal})` : ""}. title: título jornalístico próprio e fiel. standfirst: 1 ou 2 frases, até 220 caracteres. metaDescription: até 160 caracteres. slug: minúscula, sem acentos e com hífens. focusKeyphrase: termo de busca principal. seoTitle: título SEO objetivo. tags: array de 5 a 8 tags relevantes, sem nome do portal.\n\nTÍTULO DE REFERÊNCIA: ${fallbackTitle}\nMATÉRIA REESCRITA:\n${rewrittenText.slice(0, 14000)}`;
    let metadata = {};
    try {
      const metaJson = await llm.generate(metadataPrompt, { json: true, temperature: 0.15, numCtx: 16384, maxTokens: 1800, timeout: 90000 });
      metadata = JSON.parse(metaJson);
    } catch (error) { console.warn("Metadados da matéria reescrita: usando alternativas locais.", error.message); }
    const metaTitle = String(metadata.title || fallbackTitle).slice(0, 240);
    const localTags = [...new Set((`${metaTitle} ${rewrittenText.slice(0, 1800)}`.match(/[A-ZÀ-Ý][\wÀ-ÿ-]{2,}(?:\s+[A-ZÀ-Ý][\wÀ-ÿ-]{2,}){0,2}/g) || []).map(x => x.trim()).filter(x => x.length > 3 && (!sourcePortal || x.toLowerCase() !== sourcePortal.toLowerCase())))].slice(0, 8);
    res.json({
      model, title: metaTitle,
      standfirst: String(metadata.standfirst || firstSentences.slice(0, 220) || metaTitle).slice(0, 240),
      seoTitle: String(metadata.seoTitle || metaTitle).slice(0, 240),
      metaDescription: String(metadata.metaDescription || firstSentences.slice(0, 160) || metaTitle).slice(0, 200),
      slug: makeSlug(metadata.slug || metaTitle),
      focusKeyphrase: String(metadata.focusKeyphrase || metaTitle).slice(0, 100),
      tags: Array.isArray(metadata.tags) && metadata.tags.length ? metadata.tags.filter(x => typeof x === "string").map(x => x.trim().replace(/^#/, "")).filter(x => x && (!sourcePortal || x.toLowerCase() !== sourcePortal.toLowerCase())).slice(0, 10) : localTags,
      cleanedText: rewrittenText, targetCharacters, actualCharacters: rewrittenText.length,
      note: "Matéria reescrita com a personalidade selecionada. Confira os fatos e os campos editoriais antes de publicar."
    });
  } catch (error) {
    const message = error.name === "AbortError" ? "A reescrita demorou demais. Tente novamente ou use um modelo maior." : error.message || "Não foi possível reescrever a matéria.";
    res.status(502).json({ error: message });
  }
});

app.get("/api/image-proxy", async (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || "")); } catch { return res.status(400).end(); }
  if (!["https:", "http:"].includes(url.protocol) || url.hostname === "localhost" || /^127\./.test(url.hostname) || /^10\./.test(url.hostname) || /^192\.168\./.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) return res.status(400).end();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 CentralGeek/1.0", "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" } });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.toLowerCase().startsWith("image/")) return res.status(502).end();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 20 * 1024 * 1024) return res.status(413).end();
    res.setHeader("Content-Type", type.split(";")[0]); res.setHeader("Cache-Control", "public, max-age=300"); res.setHeader("X-Content-Type-Options", "nosniff"); res.send(buffer);
  } catch { res.status(502).end(); }
});

app.get("/api/download-image", async (req, res) => {
  const raw = String(req.query.url || "");
  let url;
  try { url = new URL(raw); } catch { return res.status(400).json({ error: "Endereço de imagem inválido." }); }
  if (!["https:", "http:"].includes(url.protocol) || url.hostname === "localhost" || /^127\./.test(url.hostname) || /^10\./.test(url.hostname) || /^192\.168\./.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) return res.status(400).json({ error: "Este endereço de imagem não é permitido." });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 CentralGeek/1.0", "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" } });
    if (!response.ok) throw new Error(`A origem respondeu ${response.status}.`);
    const type = response.headers.get("content-type") || "";
    if (!type.toLowerCase().startsWith("image/")) throw new Error("O endereço não retornou um arquivo de imagem.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 20 * 1024 * 1024) throw new Error("A imagem ultrapassa o limite de 20 MB.");
    const ext = ({"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","image/avif":"avif"})[type.split(";")[0]] || "img";
    const name = String(req.query.name || "imagem-geek").replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "imagem-geek";
    res.setHeader("Content-Type", type.split(";")[0]);
    res.setHeader("Content-Disposition", `attachment; filename="${name}.${ext}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (error) { res.status(502).json({ error: error.message || "Não foi possível baixar a imagem." }); }
});

const IMAGE_SOURCES = [
  { id: "pinterest", name: "Pinterest", search: q => `https://br.pinterest.com/search/pins/?q=${encodeURIComponent(q)}` },
  { id: "tudum", name: "Tudum", search: q => `https://www.netflix.com/tudum/search?q=${encodeURIComponent(q)}` },
  { id: "imdb", name: "IMDb", search: q => `https://www.imdb.com/find/?q=${encodeURIComponent(q)}` },
  { id: "flim", name: "Flim", search: q => `https://app.flim.ai/search?query=${encodeURIComponent(q)}` }
];

function imageTokens(value) {
  const stop = new Set(["para", "sobre", "com", "uma", "por", "dos", "das", "the", "and", "official", "imagem", "images", "image", "foto", "poster", "still", "promocional", "oficial"]);
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(word => word.length > 2 && !stop.has(word));
}

app.get("/api/images", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 160);
  if (!query) return res.json({ images: [], sources: [] });
  const sources = IMAGE_SOURCES.map(source => ({ id: source.id, name: source.name, url: source.search(query) }));
  try {
    // Pesquisa imagens pelo assunto em geral, em vez de limitar resultados a sites que nem sempre indexam imagens relevantes.
    // Os quatro sites pedidos continuam disponíveis como pesquisas diretas para encontrar material original.
    const searchQuery = query;
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(searchQuery)}&form=HDRSC3`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`Busca de imagens respondeu ${response.status}`);
    const html = await response.text();
    const dom = new JSDOM(html);
    const anchors = [...dom.window.document.querySelectorAll("a.iusc")];
    const tokens = [...new Set(imageTokens(query))];
    const results = [];
    for (const anchor of anchors) {
      try {
        const meta = JSON.parse(anchor.getAttribute("m") || "{}");
        const page = String(meta.purl || "");
        const thumb = String(meta.turl || "");
        const original = String(meta.murl || "");
        const title = String(meta.t || "Imagem relacionada").slice(0, 180);
        const description = String(meta.desc || "").slice(0, 300);
        if (!/^https?:\/\//i.test(page) || !/^https?:\/\//i.test(thumb)) continue;
        let host;
        try { host = new URL(page).hostname.toLowerCase(); } catch { continue; }
        if (["bing.com", "microsoft.com"].some(domain => host === domain || host.endsWith(`.${domain}`))) continue;
        const haystack = imageTokens(`${title} ${description} ${page}`).join(" ");
        const matches = tokens.filter(token => haystack.includes(token)).length;
        const score = tokens.length ? matches / Math.min(tokens.length, 5) : 0;
        // Descartar resultados sem nenhum vínculo textual com o assunto pesquisado.
        if (tokens.length >= 2 && matches === 0) continue;
        results.push({
          title, thumb, original, page, source: host.replace(/^www\./, ""),
          sourceId: "web", license: "Consulte os direitos de uso na fonte", artist: "Verificar na página original", credit: "",
          description, relevance: score
        });
      } catch {}
    }
    const unique = [...new Map(results.sort((a, b) => b.relevance - a.relevance).map(image => [image.page, image])).values()].slice(0, 12);
    dom.window.close();
    res.json({ images: unique, sources, note: "Resultados de busca geral ordenados por correspondência textual. Abra a página original, confira se a imagem corresponde à notícia e confirme os direitos de uso antes de publicar." });
  } catch {
    res.json({ images: [], sources, note: "Não foi possível carregar miniaturas agora. Use os links de busca das fontes abaixo." });
  }
});

app.listen(PORT, async () => {
  console.log(`Central Geek disponível em http://localhost:${PORT}`);
  const llmInfo = await llm.status();
  if (llmInfo.provider === "openai") {
    console.log(llmInfo.connected ? `Scarlet IA: OpenAI configurada; modelo ${llmInfo.model}.` : "Scarlet IA: OPENAI_API_KEY não encontrada. Defina a chave no arquivo .env.");
  } else {
    console.log(llmInfo.connected ? `Scarlet IA: Ollama conectado; modelo ${llmInfo.modelAvailable ? "disponível" : "ainda não baixado"} (${llmInfo.model}).` : "Scarlet IA: Ollama não detectado. Abra o Ollama e confira http://localhost:11434.");
    if (llmInfo.connected && !llmInfo.modelAvailable) console.log(`Baixe o modelo com: ollama run ${llmInfo.model}`);
  }
});
