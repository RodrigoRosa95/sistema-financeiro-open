require('./logger').install({ service: 'whatsapp-bot' });
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, decryptPollVote, jidNormalizedUser } = require('@whiskeysockets/baileys');
const crypto = require('crypto');
const QRCode = require('qrcode-terminal');
const express = require('express');
const P = require('pino');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ================= CONFIGURAÇÕES =================
let sock = null;
let isConnected = false;
let qrCodeAtual = null;
let reconexoes = 0;          // tentativas de reconexão desde a última conexão estável
let desconectadoDesde = null; // quando a conexão caiu (para informar quanto tempo ficou fora)

const FINANCE_SERVER_URL = String(
    process.env.FINANCE_SERVER_URL || process.env.PUBLIC_URL || 'http://localhost:3004'
).trim().replace(/\/+$/, '');

// ================= LEITURA DE MENSAGENS PELA ECHO DOT (via Home Assistant) =================
// Quando um contato AUTORIZADO manda mensagem, avisa um webhook do Home Assistant; é o HA que decide
// como falar (qual Echo, horário silencioso, Não Perturbe, limpeza de links/emoji, corte de tamanho).
// Desligado por padrão: só funciona com as duas variáveis abaixo no .env.
//   HA_WEBHOOK_URL=http://homeassistant.local:8123/api/webhook/<id-secreto>   
//   ECHO_CONTATOS=5551999990000:Nome falado,5551988887777:Outro    (DDI+DDD+número : como a Alexa fala o nome)
// O contato é identificado SÓ pelo número (o nome de perfil do WhatsApp é editável por quem envia, então
// não serve para autorizar). Grupos, status e canais são sempre ignorados. O texto das mensagens nunca é logado.
const HA_WEBHOOK_URL = String(process.env.HA_WEBHOOK_URL || '').trim();
// Áudios são transcritos (Whisper da Groq, mesma GROQ_API_KEY do sistema financeiro) e o texto vai no lugar do
// "enviou um áudio". Atenção: o áudio do contato sai do notebook para a Groq; se preferir que não saia, remova
// GROQ_API_KEY do .env do bot e a Echo só dirá "enviou uma mensagem de voz".
const GROQ_API_KEY = String(process.env.GROQ_API_KEY || '').trim();
const ECHO_MODELO_AUDIO = String(process.env.ECHO_MODELO_AUDIO || 'whisper-large-v3-turbo').trim();
const ECHO_IDIOMA_AUDIO = String(process.env.ECHO_IDIOMA_AUDIO || 'pt').trim();
const ECHO_AUDIO_MAXIMO_S = 120;     // áudio mais longo que isso não é transcrito (só avisa)
const ECHO_IDADE_MAXIMA_S = 90;      // ignora mensagem mais velha que isso (fila acumulada enquanto o notebook estava desligado)
const ECHO_TEXTO_MAXIMO = 1000;      // o HA corta de novo para o que ele achar razoável falar
const echoJaLidas = new Set();       // ids já enviados (o WhatsApp às vezes entrega o mesmo evento duas vezes)

// Chave estável de um número: sem DDI 55 e sem o 9º dígito variável (DDD + 8 últimos dígitos).
function chaveNumero(numero) {
    let d = String(numero || '').replace(/\D/g, '');
    if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
    return (d.length === 10 || d.length === 11) ? d.slice(0, 2) + d.slice(-8) : d;
}

const ECHO_CONTATOS = new Map();     // chave -> nome falado
for (const item of String(process.env.ECHO_CONTATOS || '').split(',')) {
    const [numero, ...resto] = item.split(':');
    const nome = resto.join(':').trim();
    const chave = chaveNumero(numero);
    if (chave && nome) ECHO_CONTATOS.set(chave, nome);
}
const ECHO_ATIVA = Boolean(HA_WEBHOOK_URL) && ECHO_CONTATOS.size > 0;
console.log(ECHO_ATIVA
    ? `🔊 Leitura pela Echo: ativada para ${ECHO_CONTATOS.size} contato(s).`
    : '🔇 Leitura pela Echo: desativada (defina HA_WEBHOOK_URL e ECHO_CONTATOS no .env).');

// ================= JELLYFLIX NOS GRUPOS (comandos, pedidos, enquete) =================
// Mensagens que começam com "/" (e respostas "1"–"9" aos /pedir) dos grupos listados em JELLYFLIX_WHATS_GRUPOS
// vão para o bridge, que responde pela rota /enviar. Votos das enquetes criadas por /enviar também: o Baileys
// 7 não decifra mais os votos sozinho, então a chave (messageSecret) de cada enquete fica em bot-enquetes.json.
const JELLYFLIX_GRUPOS = String(process.env.JELLYFLIX_WHATS_GRUPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const BRIDGE_URL = String(process.env.BRIDGE_URL || `http://localhost:${process.env.BRIDGE_PORT || 3005}`).trim().replace(/\/+$/, '');
const ENQUETES_FILE = path.join(__dirname, 'bot-enquetes.json');
let enquetes = {};
try { enquetes = JSON.parse(fs.readFileSync(ENQUETES_FILE, 'utf8')); } catch (_) {}
function salvarEnquetes() {
    const limite = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [id, e] of Object.entries(enquetes)) if (e.quando < limite) delete enquetes[id];
    try { fs.writeFileSync(ENQUETES_FILE, JSON.stringify(enquetes)); } catch (e) { console.error('❌ Não salvou bot-enquetes.json:', e.message); }
}
const semDispositivo = (jid) => String(jid || '').replace(/:\d+@/, '@');
// O bot é a própria conta do User1 (aparelho vinculado): o que ele digita no grupo chega como fromMe.
// Para não responder às próprias respostas, guarda os ids do que o bot enviou pela rota /enviar.
const enviadasPeloBot = new Set();
function marcarEnviada(id) {
    if (!id) return;
    enviadasPeloBot.add(id);
    if (enviadasPeloBot.size > 500) enviadasPeloBot.delete(enviadasPeloBot.values().next().value);
}

// Quem mandou no grupo, de preferência pelo número (o mesmo para mensagens e votos).
async function autorNoGrupo(key) {
    if (key?.fromMe && sock?.user?.id) return jidNormalizedUser(sock.user.id);
    const p = semDispositivo(key?.participant);
    const alt = semDispositivo(key?.participantAlt);
    if (p.endsWith('@s.whatsapp.net')) return p;
    if (alt.endsWith('@s.whatsapp.net')) return alt;
    if (p.endsWith('@lid')) {
        try { const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(p); if (pn) return semDispositivo(pn); } catch (_) {}
    }
    return p;
}

async function postarNoBridge(caminho, corpo) {
    try {
        await fetch(`${BRIDGE_URL}${caminho}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(10000) });
    } catch (e) {
        console.error(`❌ Jellyflix: bridge não respondeu (${caminho}): ${e.message}`);
    }
}

// Voto cifrado → nomes das opções marcadas. Tenta as combinações de JID (número/LID) do criador e do eleitor.
function decifrarVoto(m, enq) {
    const upd = m.message.pollUpdateMessage;
    const criadores = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j));
    const eleitores = [...new Set([m.key.participant, m.key.participantAlt, ...(m.key.fromMe ? criadores : [])].filter(Boolean).map((j) => jidNormalizedUser(j)))];
    for (const criador of criadores) {
        for (const eleitor of eleitores) {
            try {
                const voto = decryptPollVote(upd.vote, { pollCreatorJid: criador, pollMsgId: upd.pollCreationMessageKey.id, pollEncKey: Buffer.from(enq.secret, 'base64'), voterJid: eleitor });
                const porHash = Object.fromEntries(enq.opcoes.map((o) => [crypto.createHash('sha256').update(Buffer.from(o)).digest('hex'), o]));
                return (voto.selectedOptions || []).map((h) => porHash[Buffer.from(h).toString('hex')]).filter(Boolean);
            } catch (_) { /* próxima combinação */ }
        }
    }
    return null;
}

// ================= GRUPO "AGENDA" (22/10/2026) =================
// Texto ou áudio mandado no grupo AGENDA_WHATS_GRUPO vai para o agenda_whats.py (xoom-assistente), que usa a IA para criar
// o compromisso no Google Agenda e responde no grupo pela rota /enviar.
const AGENDA_GRUPO = String(process.env.AGENDA_WHATS_GRUPO || '').trim();
const AGENDA_URL = String(process.env.AGENDA_WHATS_URL || 'http://127.0.0.1:8799').replace(/\/+$/, '');
const agendaVistas = new Set();     // a mesma mensagem pode vir como notify e como append
async function encaminharAgenda(m) {
    if (!AGENDA_GRUPO || m.key?.remoteJid !== AGENDA_GRUPO || !m.message || enviadasPeloBot.has(m.key.id)) return;
    if (Date.now() / 1000 - Number(m.messageTimestamp || 0) > 120 || agendaVistas.has(m.key.id)) return;
    agendaVistas.add(m.key.id);
    if (agendaVistas.size > 200) agendaVistas.delete(agendaVistas.values().next().value);
    let texto = String(m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
    // Áudio: a Groq transcreve; se ela falhar, o áudio vai junto e o agenda_whats.py usa o Whisper local.
    const audioMsg = m.message.audioMessage;
    let audio = null;
    if (audioMsg) {
        const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        if (GROQ_API_KEY) {
            try { texto = await transcreverAudio(buffer, audioMsg.mimetype); } catch (e) { console.error(`❌ Agenda: Groq não transcreveu (${e.message}); vai o Whisper local.`); }
        }
        if (!texto) audio = buffer.toString('base64');
    }
    if (!texto && !audio) return;
    console.log(`📅 Agenda${audioMsg ? ' (áudio)' : ''}: "${(texto || '[transcrição local]').slice(0, 60)}"`);
    try {
        await fetch(`${AGENDA_URL}/mensagem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grupo: AGENDA_GRUPO, texto, audio, deAudio: Boolean(audioMsg), nome: m.pushName || '' }), signal: AbortSignal.timeout(10000) });
    } catch (e) {
        console.error(`❌ Agenda: agenda_whats.py não respondeu: ${e.message}`);
    }
}

async function encaminharJellyflix(m) {
    const grupo = m.key?.remoteJid;
    if (!JELLYFLIX_GRUPOS.includes(grupo) || !m.message || enviadasPeloBot.has(m.key.id)) return;
    // o que o User1 digita no celular pode chegar como "append"; mensagem velha (sincronização) não conta
    if (Date.now() / 1000 - Number(m.messageTimestamp || 0) > 120) return;
    const upd = m.message.pollUpdateMessage;
    if (upd) {
        const enq = enquetes[upd.pollCreationMessageKey?.id];
        if (!enq) return;
        const opcoes = decifrarVoto(m, enq);
        if (!opcoes) { console.warn(`⚠️ Jellyflix: não consegui decifrar um voto da enquete ${upd.pollCreationMessageKey.id}`); return; }
        await postarNoBridge('/whatsapp/jellyflix/voto', { grupo, enqueteId: upd.pollCreationMessageKey.id, autor: await autorNoGrupo(m.key), opcoes });
        return;
    }
    const texto = String(m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
    if (!/^\/\S/.test(texto) && !/^[1-9]$/.test(texto) && !/^(sim|s|n[aã]o|n)$/i.test(texto)) return;   // respostas do /pedir
    if (texto.startsWith('/')) console.log(`📨 [${grupo}] Jellyflix: "${texto.slice(0, 60)}"`);
    await postarNoBridge('/whatsapp/jellyflix', { grupo, autor: await autorNoGrupo(m.key), nome: m.pushName || '', texto });
}

// Número real do remetente. O WhatsApp está trocando o número por um identificador "@lid".
async function numeroDoRemetente(m) {
    const jid = String(m.key?.remoteJid || '');
    let alvo = null;
    if (jid.endsWith('@s.whatsapp.net')) alvo = jid;
    else if (jid.endsWith('@lid')) {
        alvo = String(m.key?.remoteJidAlt || '').endsWith('@s.whatsapp.net') ? m.key.remoteJidAlt : null;
        if (!alvo) {
            try { alvo = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid); } catch (_) {}
        }
    }
    return alvo ? String(alvo).split('@')[0].split(':')[0] : null;
}

// Classifica o que veio: texto, áudio (a transcrever) ou outra mídia (vira uma frase). null = nada a ler.
// `tipo` também vai no webhook, para o Home Assistant poder montar a frase ("User2 disse: …" x "User2 enviou uma foto").
function conteudoDaMensagem(message) {
    let c = message || {};
    c = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c;
    const texto = String(c.conversation || c.extendedTextMessage?.text || '').trim();
    if (texto) return texto.startsWith('/') ? null : { tipo: 'texto', texto };   // comandos do bot não são lidos
    const legenda = (t) => String(c[t]?.caption || '').trim();
    if (c.audioMessage) return { tipo: 'audio', ptt: Boolean(c.audioMessage.ptt), segundos: Number(c.audioMessage.seconds) || 0 };
    if (c.imageMessage) return { tipo: 'midia', texto: legenda('imageMessage') ? `enviou uma foto: ${legenda('imageMessage')}` : 'enviou uma foto' };
    if (c.videoMessage) return { tipo: 'midia', texto: legenda('videoMessage') ? `enviou um vídeo: ${legenda('videoMessage')}` : 'enviou um vídeo' };
    if (c.stickerMessage) return { tipo: 'midia', texto: 'enviou uma figurinha' };
    if (c.documentMessage) return { tipo: 'midia', texto: 'enviou um documento' };
    return null;   // reações, apagar mensagem, enquete etc.
}

// Whisper da Groq. Lança erro se a API falhar (quem chama decide o que falar nesse caso).
async function transcreverAudio(buffer, mimetype, idioma = ECHO_IDIOMA_AUDIO) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: String(mimetype || 'audio/ogg').split(';')[0] }), 'audio.ogg');
    form.append('model', ECHO_MODELO_AUDIO);
    form.append('language', idioma);
    form.append('temperature', '0');
    form.append('response_format', 'json');
    const resposta = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(20000)
    });
    if (!resposta.ok) throw new Error(`Groq respondeu HTTP ${resposta.status}`);
    const dados = await resposta.json();
    return String(dados.text || '').trim();
}

// Frase para o áudio: transcrição quando possível; senão só avisa que chegou um áudio.
async function fraseDoAudio(m, conteudo) {
    const base = conteudo.ptt ? 'enviou uma mensagem de voz' : 'enviou um áudio';
    if (!GROQ_API_KEY) return base;
    if (conteudo.segundos > ECHO_AUDIO_MAXIMO_S) return `${base} longo`;
    try {
        const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: P({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const texto = await transcreverAudio(buffer, m.message?.audioMessage?.mimetype);
        return texto ? `${base} dizendo: ${texto}` : base;
    } catch (e) {
        console.error(`❌ Erro ao transcrever áudio: ${e.message}`);
        return base;
    }
}

function idadeSegundos(m) {
    const t = m.messageTimestamp;
    const seg = typeof t === 'object' && t !== null && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
    return Number.isFinite(seg) && seg > 0 ? Math.floor(Date.now() / 1000) - seg : 0;
}

async function lerMensagemNaEcho(m) {
    if (!ECHO_ATIVA || !m?.message || m.key?.fromMe) return;
    const jid = String(m.key?.remoteJid || '');
    if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) return;   // só conversa individual
    if (idadeSegundos(m) > ECHO_IDADE_MAXIMA_S) return;
    const id = m.key?.id;
    if (id && echoJaLidas.has(id)) return;

    const numero = await numeroDoRemetente(m);
    const chave = numero ? chaveNumero(numero) : '';
    const contato = chave ? ECHO_CONTATOS.get(chave) : null;
    if (!contato) return;                                                     // não autorizado: nada é enviado
    const conteudo = conteudoDaMensagem(m.message);
    if (!conteudo) return;

    // Marca como lida ANTES de transcrever, para uma segunda entrega do mesmo evento não falar duas vezes.
    if (id) { echoJaLidas.add(id); if (echoJaLidas.size > 300) echoJaLidas.delete(echoJaLidas.values().next().value); }
    let mensagem = conteudo.tipo === 'audio' ? await fraseDoAudio(m, conteudo) : conteudo.texto;


    const resposta = await fetch(HA_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contato, mensagem: mensagem.slice(0, ECHO_TEXTO_MAXIMO), tipo: conteudo.tipo }),
        signal: AbortSignal.timeout(5000)
    });
    if (!resposta.ok) throw new Error(`Home Assistant respondeu HTTP ${resposta.status}`);
    console.log(`🔊 Aviso enviado ao Home Assistant (${contato}, ${conteudo.tipo}, ${mensagem.length} caracteres).`);
}

// ================= FUNÇÃO PRINCIPAL DO BOT =================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 Usando Baileys versão: ${version.join('.')}`);

    sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        version,
        browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeAtual = qr;
            console.log('\n📱 ESCANEIE O QR CODE ABAIXO:');
            QRCode.generate(qr, { small: true });
            try { fs.writeFileSync('/tmp/whatsapp-qr.txt', qr); } catch (e) {}
        }
        if (connection === 'close') {
            // Antes isConnected ficava true para sempre depois da primeira conexão: o /status dizia
            // "conectado" com o socket fechado e o bridge recebia "Connection Closed" em vez de 503.
            isConnected = false;
            if (!desconectadoDesde) desconectadoDesde = Date.now();
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const motivo = Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === statusCode) || 'motivo desconhecido';
            console.log(`❌ Conexão fechada (código: ${statusCode} — ${motivo})`);
            if (statusCode !== DisconnectReason.loggedOut) {
                reconexoes++;
                console.log(`🔄 Reconectando em 3s (tentativa ${reconexoes} desde a última conexão estável)...`);
                setTimeout(startBot, 3000);
            } else {
                console.log('🔒 Deslogado. Remova a pasta auth_info e reinicie.');
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeAtual = null;
            const fora = desconectadoDesde ? ` (ficou ${Math.round((Date.now() - desconectadoDesde) / 1000)}s fora do ar, ${reconexoes} tentativa(s))` : '';
            desconectadoDesde = null;
            reconexoes = 0;
            console.log(`\n✅✅✅ WHATSAPP CONECTADO!${fora} ✅✅✅`);
            console.log('📡 Bot responde somente aos comandos /conectar e /ciclo.\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Log de status de entrega (server ack / delivery ack / read). Serve pra
    // detectar em produção quando uma mensagem "enviada" (sem erro no sendMessage)
    // na verdade nunca chega no aparelho do destinatário — sintoma clássico de
    // sessão Signal (1:1) corrompida/dessincronizada, que não gera exceção no
    // envio, só falha silenciosamente do lado de quem recebe.
    sock.ev.on('messages.update', (updates) => {
        for (const u of updates || []) {
            const status = u?.update?.status;
            if (status === undefined || status === null) continue;
            if (status <= 1) {
                console.warn(`⚠️ Status de entrega baixo (${status}) para mensagem ${u.key?.id || '?'} em ${u.key?.remoteJid || '?'} — pode indicar sessão corrompida com esse contato.`);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Echo Dot: só mensagens novas em tempo real, sem atrasar os comandos abaixo.
      if (type === 'notify') {
        for (const m of messages) {
          lerMensagemNaEcho(m).catch((e) => console.error('❌ Erro ao avisar a Echo:', e.message));
          encaminharJellyflix(m).catch((e) => console.error('❌ Jellyflix:', e.message));
          encaminharAgenda(m).catch((e) => console.error('❌ Agenda:', e.message));
        }
      } else if (type === 'append') {
        for (const m of messages) {
          encaminharJellyflix(m).catch((e) => console.error('❌ Jellyflix:', e.message));
          encaminharAgenda(m).catch((e) => console.error('❌ Agenda:', e.message));
        }
      }

      const msg = messages[0];
      // Ignora mensagens do próprio bot e mensagens sem conteúdo
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      let text = msg.message.conversation ||
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption ||
                 '';
      text = String(text).trim();

      // Atualizações de status não carregam texto e caem no "ignorar" abaixo de qualquer forma.
      if (from === 'status@broadcast') return;
      // Só o texto de comandos é logado (e com o token mascarado) — antes o log guardava o conteúdo de
      // TODAS as mensagens recebidas, inclusive conversas de grupo que não têm relação com o bot.
      if (/^\/(ciclo|conectar)\b/i.test(text)) {
        console.log(`📨 [${from}] comando: "${text.replace(/^(\/conectar\s+)(\S{4})\S*/i, '$1$2…')}"`);
      } else {
        console.log(`📨 [${from}] mensagem ignorada (${text.length} caracteres; o bot só responde a /conectar e /ciclo)`);
      }

      // Trata comandos do ciclo menstrual
      if (text.toLowerCase().startsWith('/ciclo')) {
        const parts = text.split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        // Obter número do remetente
        const number = from.split('@')[0].replace(/\D/g, '');
        try {
          const response = await fetch(`${FINANCE_SERVER_URL}/api/whatsapp/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number, command: 'ciclo', args })
          });
          const data = await response.json();
          if (data.success && data.reply) {
            await sock.sendMessage(from, { text: data.reply });
          } else {
            await sock.sendMessage(from, { text: '❌ ' + (data.error || 'Comando não processado.') });
          }
        } catch (error) {
          console.error('Erro ao processar comando ciclo:', error);
          await sock.sendMessage(from, { text: '❌ Erro interno. Tente novamente.' });
        }
        return;
      }

      // Só processa se começar com /conectar (case-insensitive)
      if (!text.toLowerCase().startsWith('/conectar')) {
        // Não responde a nenhuma outra mensagem
        return;
      }

        const parts = text.split(/\s+/);
        const token = parts.length >= 2 ? parts[1] : '';

        let rawNumber = from.split('@')[0].replace(/\D/g, '');
        if (!rawNumber || rawNumber.length < 10) {
            rawNumber = from; // fallback para IDs não numéricos (como grupos)
        }

        // Se não houver token, não faz nada (não envia erro)
        if (!token) {
            console.log(`⚠️ /conectar sem token recebido de ${rawNumber} – ignorado.`);
            return;
        }

        console.log(`🔗 Processando /conectar para ${rawNumber} com token: ${token.slice(0, 4)}…`);

        try {
            const response = await fetch(`${FINANCE_SERVER_URL}/api/whatsapp/link-complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, number: rawNumber })
            });
            const data = await response.json().catch(() => ({}));

            // SÓ envia mensagem se a vinculação for bem‑sucedida
            if (response.ok && data && data.success) {
                await sock.sendMessage(from, { text: '✅ WhatsApp vinculado com sucesso! Você receberá notificações.' });
                console.log(`✅ Vinculação bem‑sucedida: ${rawNumber}`);
            } else {
                // Falha → não responde ao usuário, apenas loga
                const motivo = data?.error || 'Token inválido ou expirado';
                console.log(`❌ Falha silenciosa para ${rawNumber}: ${motivo}`);
            }
        } catch (error) {
            console.error(`❌ Erro na API para ${rawNumber}:`, error.message);
            // Erro interno → também não responde ao usuário
        }
    });

    return sock;
}

// ================= FUNÇÕES DE ENVIO E API HTTP =================

// Resolve o número de destino pro JID correto antes de enviar.
//
// Antes, todo envio individual montava o JID na mão como "<dígitos>@s.whatsapp.net"
// (formato "PN" - phone number). Isso quebrou silenciosamente pra contatos que o
// WhatsApp já migrou pro novo identificador "@lid": o sendMessage não lança erro
// nenhum (por isso parecia "enviado com sucesso"), mas a mensagem chega
// criptografada com a sessão errada e o destinatário fica preso em
// "carregando mensagens..." porque o aparelho dele não consegue decifrar.
//
// Agora, antes de montar o JID manualmente, perguntamos ao próprio Baileys
// (via onWhatsApp) se o número existe e qual o JID que ele reconhece
// atualmente pra esse contato — isso garante compatibilidade tanto com
// contatos ainda em PN quanto com os já migrados pra LID, e evita mandar
// mensagem às cegas pra um número que nem existe no WhatsApp.
async function resolveJid(numberOrJid) {
    const raw = String(numberOrJid || '').trim();
    if (!raw) throw new Error('Número/JID vazio');

    // Já é um JID conhecido (grupo, broadcast, LID ou PN) — usa direto, sem
    // tentar "resolver" de novo (grupos não passam por onWhatsApp).
    if (raw.match(/@(g\.us|broadcast|lid|s\.whatsapp\.net)$/)) {
        return raw;
    }

    const digits = raw.replace(/\D/g, '');
    if (!digits) throw new Error(`Número inválido: ${numberOrJid}`);
    const pnJid = `${digits}@s.whatsapp.net`;

    if (!sock || typeof sock.onWhatsApp !== 'function') {
        return pnJid;
    }

    try {
        const results = await sock.onWhatsApp(digits);
        const match = Array.isArray(results) ? results.find((r) => r && r.exists) : null;
        if (match && match.jid) {
            if (match.jid !== pnJid) {
                console.log(`🔀 JID resolvido para ${digits}: ${match.jid} (em vez de ${pnJid})`);
            }
            return match.jid;
        }
        console.warn(`⚠️ Número ${digits} não encontrado no WhatsApp via onWhatsApp() — tentando assim mesmo com ${pnJid}.`);
    } catch (err) {
        console.warn(`⚠️ Falha ao resolver JID de ${digits} via onWhatsApp(): ${err.message} — usando fallback ${pnJid}.`);
    }

    return pnJid;
}

async function sendMessage(number, text) {
    if (!sock || !isConnected) throw new Error('WhatsApp não conectado');
    const jid = await resolveJid(number);
    return await sock.sendMessage(jid, { text });
}

const app = express();
app.use(express.json({ limit: '15mb' }));

app.post('/send', async (req, res) => {
    const { number, message } = req.body;
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    try {
        const jid = await resolveJid(number);
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/send-file', async (req, res) => {
    const body = req.body || {};
    const number = body.number;
    const filePath = body.filePath;
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    const fp = String(filePath || '').trim();
    if (!fp) return res.status(400).json({ success: false, error: 'filePath obrigatório' });
    if (!fs.existsSync(fp)) return res.status(404).json({ success: false, error: 'Arquivo não encontrado' });
    try {
        const rawNumber = String(number || '').trim();
        if (!rawNumber) return res.status(400).json({ success: false, error: 'number obrigatório' });
        const jid = await resolveJid(rawNumber);
        const buffer = fs.readFileSync(fp);
        const ext = path.extname(fp).toLowerCase();
        const isImage = ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp';
        const fileName = String(body.fileName || path.basename(fp));
        const caption = body.caption ? String(body.caption) : undefined;

        if (isImage) {
            let detectedMimetype = 'image/jpeg';
            if (ext === '.png') detectedMimetype = 'image/png';
            if (ext === '.webp') detectedMimetype = 'image/webp';
            const mimetype = String(body.mimetype || detectedMimetype);
            await sock.sendMessage(jid, { image: buffer, mimetype, fileName, caption });
        } else {
            let detectedMimetype = 'application/octet-stream';
            if (ext === '.pdf') detectedMimetype = 'application/pdf';
            const mimetype = String(body.mimetype || detectedMimetype);
            await sock.sendMessage(jid, { document: buffer, fileName, mimetype, caption });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Envio geral usado pelo bridge (Jellyflix nos grupos). Body: { para, texto?, imagem? (base64), mencoes? [jid],
// enquete? { nome, opcoes[] } } → { success, id }. Enquete com uma escolha; a chave fica guardada para ler os votos.
app.post('/enviar', async (req, res) => {
    const { para, texto, imagem, mencoes, enquete } = req.body || {};
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    try {
        const jid = await resolveJid(para);
        const extra = Array.isArray(mencoes) && mencoes.length ? { mentions: mencoes } : {};
        let enviada;
        if (enquete) {
            const secret = crypto.randomBytes(32);
            enviada = await sock.sendMessage(jid, { poll: { name: String(enquete.nome), values: enquete.opcoes.map(String), selectableCount: 1, messageSecret: secret } });
            enquetes[enviada.key.id] = { grupo: jid, secret: secret.toString('base64'), opcoes: enquete.opcoes.map(String), quando: Date.now() };
            salvarEnquetes();
        } else if (imagem) {
            enviada = await sock.sendMessage(jid, { image: Buffer.from(imagem, 'base64'), caption: texto || undefined, ...extra });
        } else {
            enviada = await sock.sendMessage(jid, { text: String(texto || ''), ...extra });
        }
        marcarEnviada(enviada?.key?.id);
        res.json({ success: true, id: enviada?.key?.id || null });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Apaga para todos uma mensagem enviada por esta conta. Body: { para, id }
app.post('/apagar', async (req, res) => {
    const { para, id } = req.body || {};
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    try {
        const jid = await resolveJid(para);
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: String(id) } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Renomeia um grupo (a conta precisa ser admin dele). Body: { grupo: JID @g.us, nome }
app.post('/renomear-grupo', async (req, res) => {
    const { grupo, nome } = req.body || {};
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    if (!String(grupo || '').endsWith('@g.us') || !nome) return res.status(400).json({ success: false, error: 'grupo (@g.us) e nome obrigatórios' });
    try {
        await sock.groupUpdateSubject(grupo, String(nome));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Lista os grupos em que o número do bot participa (nome + JID), direto do WhatsApp.
// Serve pra descobrir o ID de um grupo — mensagens enviadas pelo próprio número não
// passam pelo log do messages.upsert (fromMe é ignorado).
app.get('/grupos', async (req, res) => {
    try {
        if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp desconectado' });
        const grupos = await sock.groupFetchAllParticipating();
        const lista = Object.values(grupos || {})
            .map((g) => ({ id: g.id, nome: g.subject || '', participantes: (g.participants || []).length, criadoEm: g.creation ? new Date(g.creation * 1000).toISOString() : null }))
            .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
        res.json({ success: true, total: lista.length, grupos: lista });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Varedura de eventos PS2 (26/10/2026, pedido da feature "jogar em nuvem"): lê a descrição de TODOS os grupos em
// que a conta participa e devolve os que parecem anúncio de partida com link do jogo (+ link do VMC). O bridge
// (jellyflix-whatsapp.js, rota /evento varrer) usa isso para criar o evento, baixar jogo e VMC e aprovar o kit.
app.post('/varrer-eventos', async (req, res) => {
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    try {
        const grupos = Object.values(await sock.groupFetchAllParticipating());
        const achados = [];
        for (const g of grupos) {
            let desc = String(g.desc || '');
            if (!desc || desc.length < 30) {
                try { desc = String((await sock.groupMetadata(g.id)).desc || ''); } catch (_) {}
            }
            const urls = (desc.match(/https?:\/\/\S+/g) || []).filter((u) => !/youtu\.?be/i.test(u));
            const parecem = urls.length >= 1 && /\bvmc\b/i.test(desc) && /dns|come[çc]a|serv(?:er|idor)/i.test(desc);
            if (parecem) achados.push({ id: g.id, nome: g.subject || '', desc, links: urls });
        }
        res.json({ success: true, varridos: grupos.length, grupos: achados });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Varredura para "games online" (25/10/2026): TODOS os grupos com link na descrição, sem exigir o formato de
// anúncio de evento. Cada grupo volta com os links puros + marquinhas (vmc? dns? participantes); quem decide
// se vale baixar é o jogos_online.py do notebook — o bridge só repassa.
app.post('/varrer-jogos', async (req, res) => {
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    try {
        const grupos = Object.values(await sock.groupFetchAllParticipating());
        const achados = [];
        for (const g of grupos) {
            let desc = String(g.desc || '');
            if (!desc || desc.length < 20) {
                try { desc = String((await sock.groupMetadata(g.id)).desc || ''); } catch (_) {}
            }
            const urls = (desc.match(/https?:\/\/\S+/g) || []).filter((u) => !/youtu\.?be/i.test(u));
            if (!urls.length) continue;
            achados.push({ id: g.id, nome: g.subject || '', desc, links: urls, vmc: /\bvmc\b/i.test(desc),
                           dns: /dns/i.test(desc), participantes: (g.participants || []).length });
        }
        res.json({ success: true, varridos: grupos.length, grupos: achados });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Envio por NOME do grupo (25/10/2026): mensagens teste ("CLAUDE") e avisos sem precisar do JID.
// Body: { grupo: 'CLAUDE', texto?, imagem? base64 } → acha o 1º grupo cujo subject bate (igual, ou contém).
app.post('/enviar-nome', async (req, res) => {
    const { grupo, texto, imagem } = req.body || {};
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    const nome = String(grupo || '').trim();
    if (!nome) return res.status(400).json({ success: false, error: 'grupo obrigatório' });
    try {
        const grupos = Object.values(await sock.groupFetchAllParticipating());
        const si = (gg) => String(gg.subject || '').toLowerCase();
        const alvo = grupos.find((g) => String(g.id || '') === nome)
            || grupos.find((g) => si(g) === nome.toLowerCase())
            || grupos.find((g) => si(g).includes(nome.toLowerCase()));
        if (!alvo) return res.status(404).json({ success: false, error: `nenhum grupo com "${nome}" no nome` });
        let enviada;
        if (imagem) {
            enviada = await sock.sendMessage(alvo.id, { image: Buffer.from(String(imagem), 'base64'), caption: String(texto || '') || undefined });
        } else {
            enviada = await sock.sendMessage(alvo.id, { text: String(texto || '') });
        }
        marcarEnviada(enviada?.key?.id);
        res.json({ success: true, id: enviada?.key?.id || null, grupo: alvo.subject });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Documento/anexo para o CLAUDE (pedido 25/10): cabe o APK do instalador, ZIPs, gravações… via caminho local
app.post('/enviar-arquivo', async (req, res) => {
    const { grupo, caminho, nome, texto, mimetype } = req.body || {};
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    const p = require('path').resolve(String(caminho || ''));
    const base = require('os').homedir();
    if (!p.startsWith(base)) return res.status(400).json({ success: false, error: 'só arquivos dentro de ' + base });
    try {
        const grupos = Object.values(await sock.groupFetchAllParticipating());
        const si = (gg) => String(gg.subject || '').toLowerCase();
        const alvo = grupos.find((g) => String(g.id || '') === nome && false)
            || grupos.find((g) => si(g) === String(grupo).toLowerCase())
            || grupos.find((g) => si(g).includes(String(grupo).toLowerCase()));
        if (!alvo) return res.status(404).json({ success: false, error: `nenhum grupo com "${grupo}" no nome` });
        const st = require('fs').statSync(p);
        if (!st.isFile()) return res.status(400).json({ success: false, error: 'não é arquivo' });
        if (st.size > 1024 * 1024 * 1024) return res.status(400).json({ success: false, error: 'arquivo maior que 1 GB' });
        const buffer = require('fs').readFileSync(p);
        const ext = require('path').extname(p).toLowerCase();
        const isImage = ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp';
        const fileName = String(nome || require('path').basename(p));
        const caption = String(texto || '') || undefined;

        let enviada;
        if (isImage) {
            const imgMime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            enviada = await sock.sendMessage(alvo.id, { image: buffer, mimetype: String(mimetype || imgMime), fileName, caption });
        } else {
            const docMime = String(mimetype || (/\.apk$/i.test(p) ? 'application/vnd.android.package-archive'
                : /\.zip$/i.test(p) ? 'application/zip' : /\.pdf$/i.test(p) ? 'application/pdf' : 'application/octet-stream'));
            enviada = await sock.sendMessage(alvo.id, { document: buffer, fileName, mimetype: docMime, caption });
        }
        marcarEnviada(enviada?.key?.id);
        res.json({ success: true, id: enviada?.key?.id || null, grupo: alvo.subject, bytes: st.size });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cria um grupo com o bot como admin. Body: { nome, participantes: ['5551...'] } → { id } (JID @g.us).
app.post('/criar-grupo', async (req, res) => {
    const { nome, participantes } = req.body || {};
    if (!sock || !isConnected) return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    if (!nome || !Array.isArray(participantes) || participantes.length === 0) {
        return res.status(400).json({ success: false, error: 'nome e participantes obrigatórios' });
    }
    try {
        const jids = await Promise.all(participantes.map((n) => resolveJid(n)));
        const grupo = await sock.groupCreate(String(nome), jids);
        res.json({ success: true, id: grupo.id, nome: grupo.subject });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, timestamp: new Date().toISOString() });
});

app.get('/qr', (req, res) => {
    if (qrCodeAtual) {
        res.send(`<html><body><img src="https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrCodeAtual)}"/><p>Escaneie o QR Code com o WhatsApp</p></body></html>`);
    } else if (isConnected) {
        res.send('<h2>✅ WhatsApp conectado</h2><p>O bot está ativo e responderá apenas quando o comando /conectar for bem‑sucedido.</p>');
    } else {
        res.send('<h2>⏳ Aguardando QR Code...</h2><meta http-equiv="refresh" content="2">');
    }
});

const PORT = 8082;
let _httpServer = null;
async function startHttpServer() {
    if (_httpServer) return _httpServer;
    _httpServer = app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🌐 API WhatsApp: http://localhost:${PORT}`);
        console.log(`🔍 Status: http://localhost:${PORT}/status`);
        console.log(`📱 QR Code: http://localhost:${PORT}/qr`);
    });
    return _httpServer;
}

async function startAll() {
    await startHttpServer();
    await startBot();
}

process.on('uncaughtException', (err) => {
    console.error('❌ Exceção não capturada:', err);
});

process.on('SIGINT', () => {
    console.log('\n👋 Encerrando bot WhatsApp...');
    process.exit(0);
});

module.exports = { startAll, startHttpServer, startBot, get isConnected() { return isConnected; }, sendMessage, resolveJid, get sock() { return sock; } };

if (require.main === module) {
    startAll().catch(err => {
        console.error('❌ Erro fatal:', err);
        setTimeout(() => process.exit(1), 1000);
    });
}