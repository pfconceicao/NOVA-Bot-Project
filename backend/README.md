# NOVA.Bot Backend

Backend do chatbot institucional da NOVA. O projeto segue uma arquitetura híbrida: combina lógica determinística, conteúdo curado em JSON, pesquisa semântica sobre documentos indexados e geração por LLM local via Ollama.

A filosofia dominante é simples: determinismo primeiro, geração depois. Quando o tema é sensível, recorrente ou já foi modelado de forma explícita, o servidor tenta responder sem depender do LLM.

Para uma explicação mais detalhada da arquitetura e das decisões de desenho, ver [TECHNICAL-OVERVIEW.md](TECHNICAL-OVERVIEW.md).

## Componentes principais

- `nova-bot-server.js`: runtime principal do chatbot e endpoint `POST /ask` em `http://localhost:3000`
- `indexdocs.mjs`: indexação de PDFs em `docs/` para NDJSON com embeddings em `index_docs/`
- `data/recognition-content.json`: conteúdo curado para reconhecimento académico
- `data/equality-inclusion-content.json`: conteúdo curado para igualdade e inclusão
- `generate-faqs-from-doc.mjs`: geração assistida de FAQs candidatas a partir dos índices documentais
- `approve-generated-faqs.mjs`: aprovação de FAQs geradas
- `compare-doc-versions.mjs`: comparação de versões de documentos com apoio do modelo de suporte
- `../frontend/index.html`, `../frontend/nova-bot.js`, `../frontend/style.css`: interface atual sem framework

## Stack

- Node.js com módulos ESM
- Express, `cors` e `body-parser` para a API HTTP
- `@xenova/transformers` para embeddings locais
- `pdfjs-dist` para extração de texto e links de PDFs
- Ollama como runtime local de modelos generativos

## Modelos Ollama

O projeto usa dois níveis de configuração:

- `OLLAMA_MODEL`: modelo principal usado pelo chatbot em runtime
- `OLLAMA_SUPPORT_MODEL`: modelo usado apenas nas tarefas de suporte, como geração de FAQs e comparação de documentos

Se `OLLAMA_SUPPORT_MODEL` não estiver definido, os scripts de suporte usam `OLLAMA_MODEL` como fallback.

## Como arrancar

Instalar dependências:

```powershell
npm install
```

Arrancar o runtime principal:

```powershell
$env:OLLAMA_MODEL = "mistral"
node nova-bot-server.js
```

O frontend comunica com `http://localhost:3000/ask`, configurado em `../frontend/nova-bot.js`.

## Pipeline de resposta

Em termos práticos, o servidor segue este fluxo:

1. Recebe a pergunta e o contexto de sessão.
2. Tenta inferir domínio, intenção e follow-up.
3. Se o caso estiver coberto por lógica determinística, responde sem passar pelo LLM.
4. Caso contrário, procura chunks relevantes nos índices em `index_docs/`.
5. Envia contexto selecionado ao Ollama para gerar uma resposta estruturada.
6. Valida o resultado e, se necessário, usa fallbacks determinísticos ou extrativos.

Isto faz do projeto um sistema RAG com guardrails, não um chatbot generativo puro.

## Base de conhecimento

Existem duas camadas principais:

- Conteúdo curado em JSON, para temas onde a estabilidade e o controlo institucional são prioritários.
- Conteúdo documental indexado, extraído de PDFs em `docs/` e transformado em embeddings em `index_docs/`.

Atualmente, as áreas mais robustas são:

- reconhecimento académico
- igualdade e inclusão
- contactos, horários, alojamento e localização de serviços

## Indexação documental

Para indexar os PDFs em `docs/`:

```powershell
npm run index
```

O script `indexdocs.mjs` percorre os PDFs recursivamente, extrai texto e hyperlinks por página, faz chunking com overlap, gera embeddings locais e guarda tudo em `.ndjson` com metadados como `pageNumber`, `relativePath`, `category` e URLs.

## FAQs e manutenção assistida por IA

Gerar FAQs candidatas a partir de um documento indexado:

```powershell
$env:OLLAMA_SUPPORT_MODEL = "phi3:mini"
npm run faqs:generate -- reconhecimento 3
```

As FAQs candidatas são guardadas em:

- `data/generated-faqs/review/`

Aprovar FAQs revistas:

```powershell
npm run faqs:approve -- reconhecimento
```

As FAQs aprovadas são guardadas em:

- `data/generated-faqs/approved/`

Comparar versões de documentos:

```powershell
$env:OLLAMA_SUPPORT_MODEL = "phi3:mini"
npm run docs:compare -- caminho-antigo.pdf caminho-novo.pdf
```

Os resultados são guardados em:

- `data/doc-diffs/`

## Estado atual e limitações

- O runtime principal continua centrado em determinismo, conteúdo curado e RAG local.
- As FAQs aprovadas ainda não são consumidas automaticamente pelo servidor principal.
- O backend principal já concentra bastante lógica e deverá beneficiar de modularização futura.
- O frontend atual é leve e funcional, mas continua a ser uma camada de demonstração sem framework.
- O histórico PT/EN no frontend segue localização determinística; o projeto já não depende de tradução runtime para reconstruir conversas antigas.
