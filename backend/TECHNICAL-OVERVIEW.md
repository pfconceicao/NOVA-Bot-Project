# Technical Overview

## Introdução

Este projeto implementa um chatbot institucional da NOVA com arquitetura híbrida. O sistema combina quatro camadas principais:

- regras determinísticas para temas sensíveis ou recorrentes
- conteúdo curado em JSON para domínios institucionais críticos
- pesquisa semântica sobre documentos indexados localmente
- geração por LLM local via Ollama como camada complementar

O runtime real está em `nova-bot-server.js`. A interface atual está em `../frontend/index.html`, `../frontend/nova-bot.js` e `../frontend/style.css`. A pipeline documental está em `indexdocs.mjs`.

O objetivo do projeto não é ser um chatbot generativo puro. A linha dominante é controlo, previsibilidade e rastreabilidade. Quando o tema é conhecido e já foi modelado, o sistema tenta responder primeiro por vias determinísticas. O LLM entra sobretudo na resposta assistida por contexto documental e nas tarefas de suporte à manutenção da base de conhecimento.

## Tecnologia

O backend assenta em Node.js com módulos ESM e usa:

- Express para a API HTTP
- `cors` e `body-parser` para integração web
- `@xenova/transformers` para embeddings locais
- `pdfjs-dist` para extração de texto e hyperlinks de PDFs
- Ollama como runtime local de modelos generativos

Existem dois níveis de configuração de modelo:

- `OLLAMA_MODEL`: modelo principal do chatbot em runtime
- `OLLAMA_SUPPORT_MODEL`: modelo usado apenas em tarefas de suporte, como geração de FAQs e comparação de documentos

No frontend, a implementação é HTML, CSS e JavaScript sem framework. Isso reduz dependências e mantém controlo direto sobre a UI e sobre o comportamento do chat.

## Arquitetura funcional

O endpoint principal é `POST /ask`, exposto por `nova-bot-server.js` em `http://localhost:3000`. O frontend envia perguntas para esse endpoint através de `API_URL` em `../frontend/nova-bot.js`.

O pipeline de resposta, em alto nível, é este:

1. A pergunta chega ao backend.
2. O sistema tenta perceber domínio, intenção e contexto de sessão.
3. Se o caso estiver coberto por lógica determinística, responde diretamente.
4. Se não estiver, gera embeddings da pergunta, compara com os chunks indexados e seleciona contexto relevante.
5. Esse contexto é enviado ao Ollama com instruções para devolver uma resposta estruturada.
6. O resultado é validado. Se falhar, entram cadeias de fallback determinístico ou extrativo.

Isto faz do projeto um sistema RAG com guardrails. Não é apenas retrieval mais prompt: há roteamento por domínio, memória de sessão, heurísticas de follow-up, boosting manual, validação da saída e múltiplos fallbacks.

## Base de conhecimento

A base de conhecimento atual divide-se em duas camadas principais.

### Conteúdo curado

É mantido manualmente em JSON e serve temas onde se quer linguagem institucional controlada e respostas previsíveis:

- `data/recognition-content.json`
- `data/equality-inclusion-content.json`

Esta camada é particularmente forte em:

- reconhecimento académico e respetivos subtópicos
- igualdade e inclusão e respetivos subtópicos
- contactos, horários, alojamento e localização de serviços

### Conteúdo documental indexado

Os documentos de origem vivem em `docs/` e os índices gerados em `index_docs/`.

O script `indexdocs.mjs`:

- percorre PDFs recursivamente
- extrai texto por página
- extrai hyperlinks por página
- divide o texto em chunks com overlap
- cria embeddings locais
- guarda resultados em `.ndjson` com metadados como `pageNumber`, `relativePath`, `category` e URLs

Esta camada permite responder com base em documentos institucionais reais e referenciar a origem de cada resposta.

## Metodologia de resposta

A metodologia central é determinismo primeiro, geração depois. Em vez de confiar no modelo para tudo, o backend aplica várias camadas de decisão:

- deteção de domínio para bloquear perguntas fora do âmbito institucional
- deteção de intenção para temas como definição, custos, documentos, prazo e localização
- contexto de sessão com memória de tema, intenção e estados pendentes
- respostas determinísticas especializadas para reconhecimento, igualdade e inclusão, alojamento e serviços associados
- recuperação semântica por embeddings sobre os índices documentais
- boosting heurístico para privilegiar chunks mais prováveis para certos intents
- validação pós-geração e fallbacks quando o resultado do LLM não é aceitável

## Áreas funcionais mais robustas

### Reconhecimento académico

É a área mais trabalhada do sistema. O backend implementa helpers e fluxos especializados para distinguir reconhecimento automático, de nível e específico, além de follow-ups como custos, documentos, prazo e onde solicitar.

Na prática, esta parte funciona como um mini-assistente especializado dentro do bot principal. É aqui que a arquitetura híbrida se torna mais clara: a conversa parece inteligente porque o domínio foi modelado, não porque o LLM improvisa livremente.

### Igualdade e inclusão

É outra área já institucionalizada por conteúdo curado. O ficheiro `data/equality-inclusion-content.json` organiza links oficiais, overview, prompts sugeridos, contactos e subtópicos como política, plano, linguagem inclusiva, assédio, discriminação, necessidades educativas especiais e isenções de propinas.

## RAG e recuperação documental

A camada RAG está implementada sobretudo no runtime principal e no indexador. O processo inclui:

- extração de texto de PDFs
- chunking com overlap
- embeddings locais
- scoring por similaridade
- construção de contexto limitado por tamanho
- prompt ao Ollama
- validação da saída

Existem ainda heurísticas adicionais, incluindo:

- pré-filtragem temática de chunks
- boosts por tipo de pergunta
- resgate lexical por assunto
- atalhos determinísticos para alguns temas

## IA de suporte

Uma das evoluções recentes do projeto é o uso do modelo não só para runtime, mas também para apoiar a manutenção da base de conhecimento. Essa camada está implementada em:

- `generate-faqs-from-doc.mjs`
- `approve-generated-faqs.mjs`
- `compare-doc-versions.mjs`

Esta camada permite:

- gerar FAQs candidatas a partir de documentos indexados
- rever e aprovar FAQs geradas
- comparar versões de documentos para identificar alterações com impacto potencial no bot

Metodologicamente, isto permite acelerar a curadoria humana e a expansão controlada do sistema sem delegar tudo no modelo em runtime.

## Fluxo de curadoria de FAQs

O fluxo atual é:

1. Indexar PDFs com `indexdocs.mjs`.
2. Gerar FAQs candidatas com `generate-faqs-from-doc.mjs`.
3. Rever o JSON em `data/generated-faqs/review/`.
4. Aprovar com `approve-generated-faqs.mjs`.

Atualmente, o runtime principal ainda não consome automaticamente as FAQs aprovadas. O fluxo de curadoria existe, mas a ligação entre `approved` e o servidor principal ainda não foi implementada.

## Frontend

O frontend atual é de demonstração e integração simples, sem SPA framework. A interface em `../frontend/index.html` e `../frontend/style.css` inclui:

- botão flutuante do bot
- chatbox com contexto de conversa
- seletor de idioma
- reset de conversa
- menu de acessibilidade
- rendering de listas, links e ações

O ficheiro `../frontend/nova-bot.js` gere:

- estado da sessão no browser
- envio para a API
- rendering progressivo das mensagens
- localização PT/EN da interface
- ações clicáveis
- timeouts, erros e estados offline

As decisões recentes de frontend privilegiam i18n determinístico. O histórico da conversa já não é regenerado por tradução runtime quando o utilizador muda de idioma; em vez disso, o chat usa mapeamentos PT/EN exatos apenas quando a relocalização é segura.

## Boas práticas presentes no projeto

Do ponto de vista de engenharia, o projeto já incorpora várias práticas sólidas:

- uso de conteúdo curado para domínios críticos
- guardrails de domínio
- validação do output do LLM
- respostas com origem documental verificável
- recuperação documental local
- separação entre modelo de runtime e modelo de suporte
- cache de respostas e deduplicação de pedidos em voo
- memória de sessão para follow-ups
- pipeline local sem dependência de APIs cloud externas
- human in the loop para expansão do conhecimento

## Limitações atuais

As principais limitações, hoje, são estas:

- as FAQs aprovadas ainda não entram automaticamente no runtime principal
- a qualidade da camada documental continua dependente da extração de texto dos PDFs e do desempenho do modelo local
- o backend principal acumulou bastante lógica e beneficia de modularização futura
- o frontend é funcional, mas continua a ser uma camada de demo e não uma aplicação frontend mais estruturada