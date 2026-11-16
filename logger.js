'use strict';

// Formatação padrão dos logs do pm2 para os serviços (sistema-mobile-3004, whatsapp-bot, bridge).
//   require('./logger').install();   // primeira linha do arquivo de entrada
//
// O que faz:
//  1. Prefixa cada linha com data/hora (America/Sao_Paulo) — o pm2 não coloca timestamp por padrão.
//  2. Mascara segredos que aparecem em mensagens de erro (token do bot Telegram na URL do FetchError, chaves gsk_, Bearer…).
//  3. Silencia o ruído do libsignal (Baileys): ele despeja a sessão inteira — incluindo `privKey` — via console.info
//     e imprime um "Bad MAC" com stack a cada mensagem que não consegue decifrar. Em vez disso conta os eventos
//     e imprime um resumo a cada 10 minutos.
//  4. Exporta `throttled()` para logs que se repetem em rajada (ex.: "WhatsApp não conectado").

const util = require('util');
const path = require('path');

const TIMEZONE = 'America/Sao_Paulo';
const stampFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
const stamp = () => stampFormat.format(new Date()); // "2026-09-18 16:41:03"

const REDACTIONS = [
  [/\bbot(\d{6,}):[\w-]{30,}/g, 'bot$1:***'],                  // token do Telegram (URL da API)
  [/\bgsk_[A-Za-z0-9]{20,}/g, 'gsk_***'],                       // chave Groq
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}/gi, '$1***'],             // Authorization: Bearer …
  [/(x-api-key['"]?\s*[:=]\s*['"]?)[A-Za-z0-9._-]{20,}/gi, '$1***'] // chave Pluggy etc.
];
const redact = (text) => REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);

// Mensagens do libsignal (primeiro argumento do console.*) -> rótulo do contador.
const SIGNAL_NOISE = [
  [/^Session error:.*Bad MAC/s, 'erro(s) Bad MAC'],
  [/^Session error:/, 'outro(s) erro(s) de sessão'],
  [/^Failed to decrypt message with any known session/, 'mensagem(ns) não decifrada(s)'],
  [/^Closing session:/, 'sessão(ões) fechada(s)'],
  [/^Opening session:/, 'sessão(ões) aberta(s)'],
  [/^Removing old closed session:/, 'sessão(ões) antiga(s) removida(s)'],
  [/^Migrating session to:/, 'sessão(ões) migrada(s)'],
  [/^Session already (closed|open)/, 'aviso(s) de sessão já fechada/aberta'],
  [/^Closing open session in favor of incoming prekey bundle/, 'sessão(ões) substituída(s) por prekey']
];
const SIGNAL_SUMMARY_MS = 10 * 60 * 1000;
const signalCounts = new Map();

const throttleState = new Map();
// Executa fn(suprimidas) no máximo 1x por janela; nas outras chamadas só conta.
function throttled(key, windowMs, fn) {
  const now = Date.now();
  const st = throttleState.get(key) || { last: 0, suppressed: 0 };
  if (now - st.last >= windowMs) {
    const suppressed = st.suppressed;
    st.last = now;
    st.suppressed = 0;
    throttleState.set(key, st);
    fn(suppressed);
  } else {
    st.suppressed += 1;
    throttleState.set(key, st);
  }
}

function install(opts = {}) {
  if (global.__pm2LoggerInstalled) return;
  global.__pm2LoggerInstalled = true;

  const service = opts.service || process.env.name || path.basename(process.argv[1] || 'app', '.js');
  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  const orig = {};
  for (const level of levels) orig[level] = console[level].bind(console);

  for (const level of levels) {
    console[level] = (...args) => {
      try {
        const first = args[0];
        if (typeof first === 'string') {
          const noise = SIGNAL_NOISE.find(([re]) => re.test(first));
          if (noise) {
            signalCounts.set(noise[1], (signalCounts.get(noise[1]) || 0) + 1);
            return;
          }
        }
        const text = util.format(...args);
        if (!text.trim()) return orig[level](text);
        const clean = redact(text);
        const lead = clean.match(/^\n*/)[0]; // mantém linhas em branco iniciais antes do carimbo
        orig[level](`${lead}[${stamp()}] ${clean.slice(lead.length)}`);
      } catch (e) {
        orig[level](...args);
      }
    };
  }

  const timer = setInterval(() => {
    if (signalCounts.size === 0) return;
    const partes = [...signalCounts.entries()].map(([k, n]) => `${n} ${k}`).join(' · ');
    signalCounts.clear();
    console.warn(`🔐 [${service}] Signal/libsignal nos últimos ${SIGNAL_SUMMARY_MS / 60000} min: ${partes}. `
      + '(Bad MAC recorrente = sessão criptográfica dessincronizada com algum contato; detalhes suprimidos por conterem chaves.)');
  }, SIGNAL_SUMMARY_MS);
  timer.unref();

  console.log(`🧾 [${service}] logger ativo — PID ${process.pid} · Node ${process.version} · TZ ${TIMEZONE}`);
}

module.exports = { install, throttled, redact };
