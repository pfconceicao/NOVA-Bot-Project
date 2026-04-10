# NOVA.Bot Backend

## Modelos Ollama

O projeto usa dois níveis de configuração para modelos Ollama:

- `OLLAMA_MODEL`: modelo principal do chatbot em runtime
- `OLLAMA_SUPPORT_MODEL`: modelo usado apenas nas tarefas de suporte, como geração de FAQs e comparação de documentos

Se `OLLAMA_SUPPORT_MODEL` não estiver definido, os scripts de suporte usam `OLLAMA_MODEL` como fallback.

## Runtime do chatbot

O backend principal usa:

```powershell
$env:OLLAMA_MODEL = "mistral"
node nova-bot-server.js
```

## Geração de FAQs com modelo de suporte

Exemplo com um modelo mais leve apenas para suporte:

```powershell
$env:OLLAMA_SUPPORT_MODEL = "phi3:mini"
npm run faqs:generate -- reconhecimento 3
```

As FAQs candidatas são guardadas em:

- `data/generated-faqs/review/`

Depois de revistas, podem ser aprovadas com:

```powershell
npm run faqs:approve -- reconhecimento
```

As FAQs aprovadas são guardadas em:

- `data/generated-faqs/approved/`

## Comparação de versões de documentos

Para comparar duas versões de um documento com apoio do modelo de suporte:

```powershell
$env:OLLAMA_SUPPORT_MODEL = "phi3:mini"
npm run docs:compare -- caminho-antigo.pdf caminho-novo.pdf
```

Os resultados são guardados em:

- `data/doc-diffs/`

## Nota

A extração e indexação dos documentos continuam a ser feitas por código e embeddings locais. Os modelos generativos são usados aqui como apoio para tarefas de manutenção e expansão do conhecimento do bot, não como substituição da lógica determinística principal.
