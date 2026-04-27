# NOVA.Bot

NOVA.Bot é um chatbot institucional da NOVA concebido para responder de forma controlada, previsível e rastreável a perguntas sobre temas académicos e administrativos. O projeto foi desenhado com uma arquitetura híbrida que combina lógica determinística, conteúdo institucional curado, recuperação documental com embeddings locais e geração por LLM local via Ollama.

O objetivo do sistema não é funcionar como um chatbot generativo puro. Pelo contrário, a prioridade é garantir rigor institucional, consistência de resposta e transparência na origem da informação. Sempre que possível, o sistema responde por vias determinísticas. A camada generativa é usada como complemento, sobretudo quando é necessário apoiar respostas com base em documentação indexada ou acelerar tarefas de manutenção da base de conhecimento.

## Proposta de valor

O projeto procura responder a um problema comum nos assistentes conversacionais institucionais: como oferecer uma experiência de pergunta e resposta natural sem perder controlo sobre o conteúdo devolvido ao utilizador.

Em vez de depender apenas de um modelo generativo, o NOVA.Bot organiza a resposta em várias camadas. Temas mais sensíveis ou recorrentes são tratados por conteúdo curado e regras específicas. Temas documentais passam por recuperação semântica e validação. O modelo local entra apenas quando faz sentido, dentro de guardrails definidos pelo sistema.

Isto torna a solução particularmente adequada para contextos universitários, onde a precisão, a atualização e a auditabilidade são mais importantes do que a criatividade do modelo.

## Características principais

- Arquitetura híbrida com determinismo primeiro e geração depois
- Respostas especializadas para reconhecimento académico
- Suporte institucional para igualdade e inclusão
- Resposta com base em documentos indexados localmente
- Funcionamento com modelos locais via Ollama, sem dependência de APIs cloud externas
- Curadoria assistida por IA para expansão controlada da base de conhecimento
- Interface web leve, bilingue e com opções de acessibilidade

## Arquitetura resumida

O sistema é composto por quatro blocos principais.

### 1. Runtime do chatbot

O núcleo do sistema vive em `backend/nova-bot-server.js`. É aqui que o projeto recebe perguntas, gere contexto de sessão, decide quando responder de forma determinística, quando recorrer à recuperação documental e quando usar o modelo local.

### 2. Conteúdo curado

O projeto usa ficheiros JSON mantidos manualmente para os temas mais críticos, em particular:

- `backend/data/recognition-content.json`
- `backend/data/equality-inclusion-content.json`

Esta camada permite garantir linguagem institucional controlada, respostas estáveis e tratamento rigoroso de subtópicos e follow-ups.

### 3. Recuperação documental

Os documentos institucionais em PDF são indexados por `backend/indexdocs.mjs`. O processo extrai texto e hyperlinks, divide o conteúdo em chunks, cria embeddings locais e guarda índices em `backend/index_docs/`.

Isto permite responder com base em documentação real, em vez de depender apenas de texto gerado.

### 4. IA de suporte à manutenção

O projeto usa o modelo local também em tarefas de apoio, através de scripts como:

- `backend/generate-faqs-from-doc.mjs`
- `backend/approve-generated-faqs.mjs`
- `backend/compare-doc-versions.mjs`

Esta camada não serve o utilizador final diretamente. Serve antes para acelerar curadoria humana, geração de FAQs candidatas e análise de alterações documentais.

## Metodologia de resposta

O princípio metodológico central do NOVA.Bot é: determinismo primeiro, geração depois.

Na prática, o sistema segue uma cadeia de decisão deste tipo:

1. Recebe a pergunta e o contexto da sessão.
2. Tenta inferir domínio, intenção e follow-up.
3. Se existir um fluxo determinístico adequado, responde sem passar pelo modelo.
4. Se não existir, procura contexto relevante nos índices documentais.
5. Envia esse contexto ao modelo Ollama com instruções restritivas.
6. Valida a saída e aplica fallbacks quando necessário.

Isto faz do projeto uma solução RAG com guardrails, e não apenas um chatbot baseado em prompt.

## Áreas mais robustas do sistema

### Reconhecimento académico

É a área mais trabalhada do projeto. O sistema distingue reconhecimento automático, de nível e específico, e consegue tratar follow-ups contextuais como custos, documentos, prazo e onde solicitar.

### Igualdade e inclusão

Esta área já está estruturada por conteúdo curado, com foco em links oficiais, contactos, política institucional, linguagem inclusiva, assédio e discriminação, necessidades educativas especiais e isenções de propinas.

### Serviços, contactos e localização

O projeto também inclui respostas determinísticas para contactos, horários, alojamento e localização de alguns serviços institucionais.

## Frontend

A interface atual está em:

- `frontend/index.html`
- `frontend/nova-bot.js`
- `frontend/style.css`

É uma interface web leve, sem framework, pensada para demonstração funcional e integração simples. Inclui seletor de idioma PT/EN, reset de conversa, ações rápidas e opções de acessibilidade, como ajuste de tamanho de letra e alteração de contraste.

## Estado atual

O projeto encontra-se funcional e já demonstra uma abordagem sólida para assistentes institucionais locais com forte controlo de qualidade. As áreas de reconhecimento académico e igualdade e inclusão são as mais robustas. A pipeline de indexação documental e os scripts de suporte já estão operacionais.

## Limitações atuais

- As FAQs aprovadas ainda não são ingeridas automaticamente no runtime principal.
- A qualidade da camada documental continua dependente da qualidade de extração dos PDFs e do desempenho do modelo local.
- O backend principal já concentra bastante lógica e beneficiará de modularização futura.
- O frontend atual é funcional, mas ainda corresponde a uma camada de demonstração, não a uma aplicação frontend mais estruturada.

## Documentação adicional

Para consulta mais técnica e detalhada:

- [backend/README.md](backend/README.md): documentação operacional do backend
- [backend/TECHNICAL-OVERVIEW.md](backend/TECHNICAL-OVERVIEW.md): visão técnica detalhada da arquitetura e da metodologia