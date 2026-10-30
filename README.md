# Central Geek — Central, Redator e Designer

Aplicação local em Node.js para organizar notícias, revisar texto com Scarlet/Ollama e preparar imagens em formatos editoriais.

## Menu principal
- **Central Geek:** busca manchetes recentes nos domínios cadastrados, priorizando feeds RSS/Atom oficiais detectados automaticamente e usando Google News RSS em português como alternativa; separa por Anime, Manga, Cinema e TV, Quadrinhos, Games, Tech, Mundo Pop, Esporte e Listas.
- **Cadastrar portal:** informe a URL principal do portal. O sistema tenta detectar o feed RSS/Atom do próprio site, salva o domínio e o feed em `data/portals.json` e consulta a fonte nas atualizações seguintes. Se não encontrar um feed, tenta o Google News em português; portais sem resultados exibem um aviso.
- **Gerar PDF → Redator:** abre a página original no Chromium/Chrome/Edge headless e arquiva uma cópia do PDF em `pdf-materia/` para leitura. O PDF não é baixado automaticamente para o usuário.
- **Redator:** lista as pautas da Central. Ao revisar, extrai o texto bruto da matéria e o mostra à esquerda; à direita, mostra a versão limpa para comparação e edição. O original fica preservado. A versão revisada aceita edição e colagem de um novo texto; o botão **ATUALIZAR METADADOS**, logo abaixo de Tags, gera novamente título, linha fina, slug, título SEO, metadescrição, frase-chave e tags com base no texto que estiver nesse campo. Exporta TXT, sem criar um novo PDF para download.
- **Designer:** lista as pautas, tenta ler o conteúdo da matéria para refinar a busca e procura imagens relacionadas. É possível abrir a página de origem/licença, baixar o arquivo original quando a origem permite, selecionar uma imagem e recortar manualmente em 1024×423 ou 668×373. Os controles Subir, Descer, Esquerda e Direita ajustam a posição da seleção. O recorte final pode ser baixado em PNG.

## Executar no Windows
1. Instale o Node.js LTS: https://nodejs.org/
2. Extraia o ZIP.
3. Abra o terminal dentro da pasta `central_geek`.
4. Execute `npm install`.
5. Execute `npm start`.
6. Abra `http://localhost:3000`.

## Scarlet com Ollama
1. Instale o Ollama: https://ollama.com/download
2. Baixe o modelo padrão executando `ollama run qwen2.5:7b`.
3. Mantenha o Ollama aberto e execute `npm start` na pasta do projeto.
4. O status da Scarlet aparece no cabeçalho e também pode ser consultado em `http://localhost:3000/api/scarlet/status`.
5. Se quiser trocar o modelo, copie `.env.example` para `.env` e altere `OLLAMA_MODEL`.

## PDF e navegador
O gerador de PDF usa `puppeteer-core` e procura uma instalação existente do Google Chrome ou Microsoft Edge. Se não encontrar, configure `PUPPETEER_EXECUTABLE_PATH` no `.env`. Alguns portais bloqueiam automação ou a impressão; nesses casos a geração pode falhar e será preciso abrir a fonte manualmente. A leitura de PDF funciona com texto selecionável; documentos digitalizados exigem OCR, ainda não incluído.

## Dados e limitações
- Os portais cadastrados ficam em `data/portals.json`, dentro da pasta do projeto. Faça backup desse arquivo se cadastrar muitas fontes.
- As manchetes são buscadas primeiro em feeds RSS/Atom detectados e complementadas pelo Google News RSS em português; disponibilidade, ordenação e trechos dependem de cada portal e da indexação externa.
- A extração de artigos pode falhar quando o portal exige login, bloqueia bots ou usa conteúdo dinâmico.
- As imagens são encontradas por pesquisa na web. Sempre confirme que correspondem à pauta e verifique licença, autoria e autorização antes de publicar.
- O recorte de imagem depende de a origem permitir que o servidor carregue o arquivo. Quando isso falhar, tente baixar o original ou abrir a página da fonte.
- A Scarlet é uma ferramenta de limpeza, não de checagem factual. Revise nomes, datas, números, citações e contexto antes de publicar. O conteúdo original pertence à fonte; use links, atribuição e autorização quando necessário.

**Idioma do Redator:** a revisão automática preserva o idioma original da matéria. A tradução automática de conteúdos em inglês ou espanhol está desativada.


## Designer v31

O menu Designer tem duas ferramentas: (1) Ajustar recorte, com upload de várias imagens locais, escolha da área, formatos de banner/matéria e download em PNG; (2) Criar galeria, com upload múltiplo, legendas editáveis, reordenação, remoção e exportação de uma página HTML independente com as imagens incorporadas. A pesquisa de imagens relacionadas às matérias continua disponível dentro da área de recorte.


## Central Geek v34

A versão 34 procura feeds RSS/Atom oficiais durante o cadastro e também durante a atualização, combina essas fontes com o Google News RSS em português, tenta uma segunda busca sem limite de sete dias e informa quando uma fonte não retorna notícias. O idioma da pesquisa não é mais inferido pelo final do domínio, evitando que portais brasileiros em domínios `.com` sejam pesquisados apenas em inglês. A importação direta de links de matérias continua disponível para sites ainda não cadastrados.

## Central Geek v33

A versão 33 removeu os controles de quantidade de caracteres e o botão Reescrever. O Redator agora atualiza os metadados editoriais e SEO a partir do conteúdo atual do campo Versão revisada, inclusive quando o usuário cola ali uma matéria diferente. No Designer, os botões de posição do recorte permitem mover a seleção para cima, para baixo, para a esquerda e para a direita.
