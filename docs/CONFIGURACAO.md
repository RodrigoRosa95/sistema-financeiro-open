# Configuração

Copie `.env.exemplo` para `.env` e preencha. **Nunca envie o `.env` ao Git.** O `.gitignore` já o ignora, junto com `data/`, `*.db` e `*.bak*`.

## Obrigatório
| Variável | Para que serve |
|---|---|
| `SESSION_SECRET` | Chave dos cookies de sessão. Sem ela, uma chave aleatória é gerada a cada início (as sessões caem ao reiniciar). |
| `USER_USER1_PASSWORD`, `USER_USER2_PASSWORD` | Senhas dos usuários padrão (`user1` é admin, `user2` é usuário comum). Nome, papel e tema: `USER_*_NAME`, `_ROLE`, `_THEME`. |
| `PORT` | Porta HTTP (padrão `3004`). |
| `PUBLIC_URL` / `FINANCE_SERVER_URL` | URL pública do sistema (webhooks, links) e URL que o bot de WhatsApp usa para falar com ele. |

## Integrações (todas opcionais)
| Grupo | Variáveis | Observação |
|---|---|---|
| Bancos (Pluggy) | `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_MP_*` | Importa contas, cartões, investimentos e recebe webhooks de transações. |
| Mercado Pago | `MP_ACCESS_TOKEN` | Pagamentos e assinatura por Pix. |
| Telegram | `TELEGRAM_BOT_TOKEN` (ou `TG_TOKEN`), `TG_BOT_USERNAME`, `TG_CHAT_ID(S)`, `ALLOWED_TG_IDS`, `USER_USER*_TGID`, `USER1_TG_IDS` | Só os ids listados em `ALLOWED_TG_IDS` conseguem falar com o bot. Vazio = ninguém. |
| WhatsApp | `WHATSAPP_ENABLED`, `WHATSAPP_API_URL`, `WHATSAPP_NUMBERS`, `WHATSAPP_GRUPO_TRANSACOES`, `WHATSAPP_GRUPO_CICLO`, `USER_USER2_WHATSAPP` | O bot (`whatsapp-bot.js`, Baileys) é um processo separado; faz o pareamento por QR code. |
| IA (Groq) | `GROQ_API_KEY`, `GROQ_VISION_*`, `GROQ_OCR_TEXT_*`, `VISION_*` | Interpreta frases ("paguei 30 no mercado"), lê comprovantes por imagem e transcreve áudios. Há reserva por OCR local (Tesseract) e regras fixas. |
| Whisper local | `WHISPER_LOCAL_PYTHON`, `WHISPER_LOCAL_MODELO` | Transcrição sem enviar o áudio a terceiros. |
| Alexa | `ALEXA_SKILL_ID`, `ALEXA_USUARIOS` | Veja o repositório da skill `alexa-financeiro`. |
| Home Assistant / Echo | `HA_WEBHOOK_URL`, `ECHO_CONTATOS`, `ECHO_FINANCEIRO`, `ECHO_*_AUDIO` | A Echo fala transações novas e mensagens de contatos autorizados. |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AGENDA_*` | Login com Google e Google Agenda. |
| E-mail | `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM`, `ADMIN_EMAIL` | Avisos por e-mail. |
| Push web / PWA | `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | Notificações no celular. Gere as chaves com `npx web-push generate-vapid-keys`. |
| Assinatura | `SUBSCRIPTION_PLAN_TYPE`, `SUBSCRIPTION_PRICE` | Cobrança por Pix. |
| Outros | `TMDB_API_KEY`, `BACKUP_DIR`, `MAX_BACKUPS`, `TZ`, `LOG_LEVEL`, `TRUST_PROXY`, `SESSION_COOKIE_SECURE` | Atrás de proxy/HTTPS use `TRUST_PROXY` e `SESSION_COOKIE_SECURE=true`. |

## Primeira execução
```bash
npm install
cp .env.exemplo .env      # edite
node sistema-mobile-3004.js   # sistema, porta 3004
node whatsapp-bot.js          # opcional: bot de WhatsApp (porta 8082)
```
O banco SQLite e os comprovantes ficam em `dados-financeiros/`, criada na primeira execução.
