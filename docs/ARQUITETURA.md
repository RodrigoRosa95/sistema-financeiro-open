# Arquitetura

```
 Celular / navegador (PWA) ─┐
 Telegram ──────────────────┤                 ┌── SQLite (dados-financeiros/finance.db)
 Alexa (skill) ─────────────┼──► sistema-mobile-3004.js ──┤
 Webhooks Pluggy / MP ──────┘     (Express, :3004)        └── comprovantes (imagens)
                                       │   ▲
                          HTTP :8082   ▼   │ /api/...
                                  whatsapp-bot.js (Baileys)
```

## Arquivos
| Arquivo | Papel |
|---|---|
| `sistema-mobile-3004.js` | Servidor principal: interface web (PWA), API, bot do Telegram, webhooks, tarefas agendadas (cron), banco SQLite. |
| `whatsapp-bot.js` | Processo separado que mantém a sessão do WhatsApp (Baileys) e expõe `/enviar`, `/apagar` etc. para o servidor principal. |
| `alexa-financeiro.js` | Skill Alexa "financeiro": valida a assinatura da Amazon e transforma a frase em transação com confirmação por voz. |
| `comprovante-pluggy.js` | Gera o comprovante (SVG) de uma transação bancária. |
| `ocr-tesseract.js` | OCR local (Tesseract) para ler valores em imagens de comprovantes. |
| `utils.js` | Formatação de moeda, validação de CPF, helpers. |
| `logger.js` | Log com data e nível; também alimenta o monitor de status. |

## Principais recursos (no código)
- **Lançamentos**: criar, editar e excluir transações; categorias e orçamentos por categoria com alerta; padrões aprendidos por usuário (descrição → categoria).
- **Bancos via Pluggy**: contas, cartões, faturas, investimentos (CDI), FGTS; webhooks transformam movimentações em transações (com categorização por CNPJ).
- **Entrada por voz e texto**: Telegram (`/saldo`, `/extrato`, `/fatura`, `/orcamento`, `/perguntar`, `/status_monitor` …), WhatsApp, Alexa e comprovantes por foto.
- **Notificações**: Telegram, WhatsApp, e-mail, push web e Echo Dot (via Home Assistant).
- **Segurança**: sessão em SQLite, biometria (WebAuthn), limites de tentativas, só ids autorizados no Telegram.
- **Extras**: acompanhamento de ciclo menstrual com lembretes, assinatura por Pix, backups automáticos.

## Banco de dados
Tabelas criadas automaticamente (`CREATE TABLE IF NOT EXISTS`): `users`, `transactions`, `categories`, `category_budgets`, `credit_cards`, `cartoes_alimentacao`, `bank_transactions_*`, `pending_pix_transactions`, `user_patterns`, `push_subscriptions`, `biometric_*`, `menstrual_*`, `cnpj_cache`, `chat_logs` e outras.

## Testes
`npm test` roda os testes em `test/` quando presentes (esta versão aberta não inclui os testes do projeto original, que dependem de dados privados).
