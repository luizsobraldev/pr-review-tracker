# PR Review Tracker

Controle diário das revisões de PR da equipe de QA, com relatório pronto para enviar à gestão (imagem, texto ou print).

- **Hoje**: registra PRs aprovados/rejeitados em segundos, com pendentes na fila, observações do dia e fechamento.
- **Histórico**: todos os dias, gráfico por dia/semana, filtros por período e pessoa, busca por PR, exportação CSV.
- **Relatório**: diário, semanal, mensal ou personalizado. Dá para copiar como imagem, baixar PNG, copiar texto (Teams/WhatsApp) ou abrir em modo print.
- **Equipe**: analistas, nome da equipe e endereço para compartilhar.
- Sincroniza em tempo real: o que um analista registra aparece na hora para os outros.

Roda de dois jeitos, com o mesmo código:

| Onde | Banco | Sincronização |
|------|-------|---------------|
| No seu computador (`npm start`) | SQLite em `data/pr-tracker.db` | instantânea (SSE) |
| Na Vercel | Postgres (Neon) via `DATABASE_URL` | a cada ~6 s, só com a aba aberta e em uso |

## Como rodar

Requisito: **Node.js 22.13 ou mais novo** (`node --version`).

```bash
npm start
```

Ou dê dois cliques em **`iniciar.bat`** no Windows.

Depois abra <http://localhost:3000>. No primeiro acesso, o sistema pede o nome da equipe e o seu nome. Das próximas vezes ele já sabe quem é você (fica gravado no navegador).

### Compartilhar com a equipe

Ao iniciar, o terminal mostra um endereço do tipo `http://10.x.x.x:3000`, que também fica na aba **Equipe**. Quem estiver na mesma rede abre esse endereço no navegador e escolhe o próprio nome.

> No primeiro start o Windows pode perguntar se o Node pode usar a rede. Permita em **redes privadas**, senão os colegas não conseguem acessar.

O computador que roda o servidor precisa ficar ligado. Para uso contínuo, o ideal é rodar numa máquina ou servidor interno que fica sempre ligado (veja "Rodar como serviço" abaixo).

### Ver com dados de exemplo

```bash
npm run demo
```

Sobe em <http://localhost:3001> com um banco separado (`data/demo.db`) cheio de dados fictícios. Seu banco real não é alterado.

## Uso diário

1. Cole o ID do PR (`AUTOTST-43784`), a branch ou o link do Jira no campo e:
   - **↵ Enter** registra como aprovado;
   - **⇧ Shift + Enter** registra como rejeitado (pede um motivo opcional, que aparece no relatório).
2. Dá para colar vários IDs de uma vez (`AUTOTST-1 AUTOTST-2, AUTOTST-3`): todos são registrados juntos.
3. Se o PR já foi revisado antes, o sistema avisa embaixo do campo e marca o registro como "2ª análise".
4. Errou? Use **Desfazer** no aviso que aparece embaixo, ou o menu `···` da linha (editar, trocar status, excluir).
5. Atualize **Pendentes** (− / +) e escreva as **Observações do dia** se houver contexto para a gestão.
6. No fim do dia: **Fechar dia** → informe os pendentes → **Fechar e gerar relatório**.
7. No relatório: **Copiar imagem** e cole (Ctrl+V) no Teams, WhatsApp ou e-mail.

Atalhos: `/` foca o campo · `[` `]` dia anterior/próximo · `T` volta para hoje · `R` abre o relatório do dia.

### Sobre "Copiar imagem"

Navegadores só deixam copiar imagens para a área de transferência em **localhost** ou **HTTPS**. Quem acessa pelo IP (`http://10.x.x.x:3000`) recebe o PNG baixado automaticamente. Alternativas:

- usar **Modo print (tela cheia)** e recortar com `Win + Shift + S`;
- usar **Copiar texto**, que funciona em qualquer endereço;
- no Chrome/Edge, liberar o endereço em `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (ou `edge://flags/...`) adicionando `http://10.x.x.x:3000`.

## Dados e backup

- Local: tudo fica em `data/pr-tracker.db` (SQLite). Para fazer backup, copie esse arquivo com o servidor parado.
- Vercel: os dados ficam no Postgres do Neon (com histórico de restauração do próprio Neon).
- **Histórico → Tudo → Exportar CSV** gera uma planilha com todos os registros, que abre direto no Excel.

## Deploy na Vercel

1. Importe o repositório em <https://vercel.com/new> (Framework: **Other**, sem build). O `vercel.json` já serve `public/` e manda `/api/*` para `api/index.js`.
2. No projeto, aba **Storage → Create Database → Neon (Postgres)** → conecte ao projeto. Isso cria `DATABASE_URL` automaticamente. As tabelas são criadas no primeiro acesso.
3. (Opcional) Em **Settings → Environment Variables**, crie `TEAM_CODE` se quiser exigir um código de acesso da equipe.
4. Faça um novo deploy. Cada `git push` na `main` publica sozinho.

Na Vercel o endereço é HTTPS, então **Copiar imagem** funciona para todo mundo.

## Configuração

Variáveis de ambiente (opcionais):

| Variável       | Padrão                 | Para quê                                                   |
|----------------|------------------------|------------------------------------------------------------|
| `PORT`         | `3000`                 | Porta HTTP (servidor local)                                |
| `HOST`         | `0.0.0.0`              | Interface de rede (servidor local)                         |
| `DB_FILE`      | `data/pr-tracker.db`   | Caminho do banco SQLite (servidor local)                   |
| `DATABASE_URL` | —                      | Postgres (Neon). Se existir, é usado no lugar do SQLite    |
| `TEAM_CODE`    | —                      | Código de acesso da equipe. Sem ele, o acesso é livre      |
| `AUTH_SECRET`  | `TEAM_CODE`            | Chave para assinar o cookie de acesso (opcional)           |

PowerShell: `$env:PORT=8080; npm start`

### Rodar como serviço (sempre ligado)

Numa máquina Windows que fica ligada, uma opção simples é o [NSSM](https://nssm.cc/):

```powershell
nssm install PRReviewTracker "C:\Program Files\nodejs\node.exe" "--disable-warning=ExperimentalWarning server.js"
nssm set PRReviewTracker AppDirectory "C:\caminho\para\projeto-PRs"
nssm start PRReviewTracker
```

Ou com [pm2](https://pm2.keymetrics.io/): `pm2 start server.js --node-args="--disable-warning=ExperimentalWarning" --name pr-tracker`.

> Sem `TEAM_CODE`, qualquer pessoa com acesso ao endereço consegue registrar. Na rede interna isso costuma bastar; na internet, defina o código.

## Estrutura

```
server.js              Servidor local (estáticos + API + SSE)
api/index.js           Função serverless da Vercel (mesma API)
lib/app.js             Rotas, validação e código de acesso
lib/db.js              SQLite local ou Postgres (Neon), mesma interface
vercel.json            Configuração do deploy
public/
  index.html           Shell da aplicação
  css/app.css          Interface (tokens Geist, claro/escuro)
  css/report.css       Relatório (também embutido no PNG exportado)
  js/app.js            Telas, interações e atalhos
  js/report.js         Modelo, layout e texto do relatório + gráfico
  js/export-image.js   Exportação do relatório para PNG (sem bibliotecas)
  js/utils.js          Datas, parsing de PR, ícones, avatares
  js/api.js            Cliente da API
  fonts/               Geist Sans e Geist Mono (OFL)
scripts/seed-demo.js   Dados de demonstração
iniciar.bat            Atalho para Windows
```
