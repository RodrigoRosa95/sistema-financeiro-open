# Sistema financeiro

Sistema financeiro pessoal e familiar em **Node.js/Express** com **SQLite**: lança gastos por texto, voz, foto de comprovante ou automaticamente pelos bancos (Pluggy), acompanha cartões, faturas, orçamentos e investimentos, e avisa por Telegram, WhatsApp, e-mail, push e Echo Dot.

> Versão aberta, sem dados pessoais. Usuários padrão: `user1` (admin) e `user2`. Tudo é configurado por variáveis de ambiente.

## Recursos
- Transações, categorias, orçamentos por categoria com alertas e padrões aprendidos por usuário.
- Bancos via **Pluggy** (webhooks), faturas de cartão, CDI, FGTS, Mercado Pago.
- **Telegram**: `/saldo`, `/extrato`, `/fatura`, `/orcamento`, `/perguntar` (IA) e outros.
- **WhatsApp** (Baileys) e **Alexa** ("pede pro financeiro paguei 30 reais no mercado com pix").
- IA (Groq) para interpretar frases, ler comprovantes e transcrever áudios; OCR local e regras fixas como reserva.
- PWA com biometria (WebAuthn), push web, login com Google e Google Agenda.
- Anúncios na Echo Dot via Home Assistant, backups automáticos, assinatura por Pix.

## Começando
```bash
git clone https://github.com/RodrigoRosa95/sistema-financeiro-open
cd sistema-financeiro-open
npm install
cp .env.exemplo .env     # preencha (veja docs/CONFIGURACAO.md)
node sistema-mobile-3004.js
```
Abra `http://localhost:3004`. Requer Node 20+.

## Documentação
- [Configuração e variáveis de ambiente](docs/CONFIGURACAO.md)
- [Arquitetura e arquivos](docs/ARQUITETURA.md)
- [Rotas HTTP](docs/ROTAS.md)
- Skill da Alexa: repositório [alexa-financeiro](https://github.com/RodrigoRosa95/alexa-financeiro)

## Segurança
Chaves e senhas ficam só no `.env` (ignorado pelo Git). Sem `ALLOWED_TG_IDS` ninguém acessa o bot do Telegram. Em produção use HTTPS e `SESSION_COOKIE_SECURE=true`. Este projeto lida com dados financeiros: revise o código antes de expor à internet.

## Licença
MIT
