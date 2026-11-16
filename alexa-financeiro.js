// Skill "financeiro" da Alexa (13/10/2026): "Alexa, pede pro financeiro paguei 30 reais no mercado com pluxee".
//
// A Alexa transcreve a frase e manda para POST /api/alexa (exposto pelo túnel da Cloudflare em
// seu-dominio.exemplo, SÓ esse caminho). A frase passa pela mesma interpretação do Telegram (IA da Groq; sem ela,
// regras fixas), a forma de pagamento sai da frase ("com pluxee", "no pix", "no débito") ou da sugestão (saldo do
// vale / histórico), e a Alexa confirma em voz alta antes de gravar. Gravada, a transação segue o caminho normal
// (addTransaction): notificação no Telegram/WhatsApp com a fatura ou o saldo do vale.
//
// Segurança (exigida pela Amazon para skill com endpoint próprio): cada pedido precisa vir assinado pela Amazon
// (certificado echo-api.amazon.com baixado de s3.amazonaws.com/echo.api/, cadeia até uma raiz confiável, assinatura
// SHA-256 do corpo bruto) com horário de no máximo 150 s, e ser da NOSSA skill (ALEXA_SKILL_ID no .env).
// ALEXA_USUARIOS (opcional): ids de conta Amazon aceitos, separados por vírgula; o id aparece no log a cada pedido.
'use strict';
const crypto = require('crypto');
const tls = require('tls');

const TOLERANCIA_MS = 150 * 1000;
const cacheCadeias = new Map();   // url → { pems, ate }

// ---------- verificação do pedido ----------

function urlCadeiaValida(endereco) {
  try {
    const u = new URL(endereco);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === 's3.amazonaws.com'
      && u.pathname.startsWith('/echo.api/') && (!u.port || u.port === '443');
  } catch {
    return false;
  }
}

function separarPems(texto) {
  return String(texto || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

async function baixarCadeia(endereco) {
  const guardada = cacheCadeias.get(endereco);
  if (guardada && guardada.ate > Date.now()) return guardada.pems;
  const resp = await fetch(endereco, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`certificado: HTTP ${resp.status}`);
  const pems = separarPems(await resp.text());
  cacheCadeias.set(endereco, { pems, ate: Date.now() + 60 * 60 * 1000 });
  return pems;
}

// Raízes: as embutidas no Node + as do sistema (/etc/ssl/certs), caso a Amazon troque de autoridade certificadora
let _raizes = null;
function raizesConfiaveis() {
  if (_raizes) return _raizes;
  let sistema = [];
  try { sistema = separarPems(require('fs').readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8')); } catch { /* sem bundle */ }
  _raizes = [...new Set([...tls.rootCertificates, ...sistema])];
  return _raizes;
}

// opcoes.raizes / opcoes.baixar / opcoes.agora existem para os testes (cadeia gerada localmente)
async function verificarRequisicaoAlexa(headers, corpoBruto, opcoes = {}) {
  const endereco = headers['signaturecertchainurl'];
  const assinatura = headers['signature-256'];
  if (!endereco || !assinatura) throw new Error('sem cabeçalhos de assinatura');
  if (!urlCadeiaValida(endereco)) throw new Error('URL do certificado inválida');
  if (!corpoBruto || !corpoBruto.length) throw new Error('corpo vazio');

  const pems = await (opcoes.baixar || baixarCadeia)(endereco);
  if (!pems.length) throw new Error('cadeia de certificados vazia');
  const cadeia = pems.map(p => new crypto.X509Certificate(p));
  const agora = opcoes.agora || Date.now();
  for (const c of cadeia) {
    if (agora < Date.parse(c.validFrom) || agora > Date.parse(c.validTo)) throw new Error('certificado fora da validade');
  }
  const folha = cadeia[0];
  if (!/(^|,\s*)DNS:echo-api\.amazon\.com(,|$)/.test(String(folha.subjectAltName || ''))) {
    throw new Error('certificado não é do echo-api.amazon.com');
  }
  for (let i = 0; i < cadeia.length - 1; i++) {
    if (!cadeia[i].checkIssued(cadeia[i + 1]) || !cadeia[i].verify(cadeia[i + 1].publicKey)) {
      throw new Error('cadeia de certificados quebrada');
    }
  }
  // A cadeia da Amazon sobe até "Amazon Root CA 1" e continua por certificados cruzados antigos (Starfield) que já
  // saíram das listas de raízes: vale o primeiro elo emitido por uma raiz confiável (ou que É a raiz, mesma chave).
  const raizes = (opcoes.raizes || raizesConfiaveis()).map(p => new crypto.X509Certificate(p));
  const chave = (c) => c.publicKey.export({ type: 'spki', format: 'der' });
  const confiavel = cadeia.some(c => raizes.some(r => (c.checkIssued(r) && c.verify(r.publicKey))
    || (c.subject === r.subject && chave(c).equals(chave(r)))));
  if (!confiavel) throw new Error('cadeia não chega a uma raiz confiável');

  if (!crypto.verify('sha256', corpoBruto, folha.publicKey, Buffer.from(String(assinatura), 'base64'))) {
    throw new Error('assinatura inválida');
  }
  const corpo = JSON.parse(corpoBruto.toString('utf8'));
  const quando = Date.parse(corpo && corpo.request && corpo.request.timestamp);
  if (!Number.isFinite(quando) || Math.abs(agora - quando) > TOLERANCIA_MS) throw new Error('pedido fora do horário');
  return corpo;
}

// ---------- forma de pagamento falada ----------

// A Alexa escreve do jeito que ouviu: "pluxee" pode vir "plux", "pluxi"; "flash" pode vir "flesh", "flex".
const FORMAS_FALADAS = [
  ['VR Pluxee', /\b(vr\s+)?(pluxee|pluxe|pluxi|plux|plúxi|plu\s+xi)\b/i],
  ['Flash', /\b(flash|flesh|flex|fléchi|flech)\b/i],
  ['Pix Sicredi', /\bpix\s+(d[oa]\s+|n[oa]\s+)?sicredi\b/i],
  ['Pix Neon', /\bpix(\s+(d[oa]\s+|n[oa]\s+)?neon)?\b/i],
  ['Sicredi Cartão Débito', /\b(d[eé]bito\s+(d[oa]\s+|n[oa]\s+)?sicredi|cart[aã]o\s+(d[oa]\s+)?sicredi)\b/i],
  ['Neon Cartão Débito', /\b(d[eé]bito(\s+(d[oa]\s+|n[oa]\s+)?neon)?|cart[aã]o\s+(d[oa]\s+)?neon)\b/i],
  ['Magazine', /\b(magazine(\s+luiza)?|magalu|mercado\s+pago)\b/i],
  ['Banrisul', /\bbanrisul\b/i],
  ['Bradesco', /\bbradesco\b/i],
  ['Cartão de Crédito', /\b(cart[aã]o\s+de\s+)?cr[eé]dito\b/i],
  ['Dinheiro em papel', /\b(dinheiro|em\s+esp[eé]cie)\b/i]
];
const CONECTIVOS_FORMA = '(?:\\s+(?:com|no|na|pelo|pela|via|usando|em|de|do|da|o|a))*';

// → { metodo, resto } (resto = frase sem a forma de pagamento) ou { metodo: null, resto: frase }
function detectarFormaPagamento(frase) {
  const texto = String(frase || '');
  for (const [metodo, re] of FORMAS_FALADAS) {
    const m = texto.match(re);
    if (!m) continue;
    const trecho = new RegExp(`${CONECTIVOS_FORMA}\\s*${m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const resto = texto.replace(trecho, ' ').replace(/\s+/g, ' ').trim();
    return { metodo, resto };
  }
  return { metodo: null, resto: texto.trim() };
}

// A IA às vezes devolve a frase inteira como descrição ("paguei 30 reais no mercado"): fica só "Mercado"
function limparDescricao(desc) {
  let d = String(desc || '')
    .replace(/\b(eu\s+)?(paguei|gastei|comprei|recebi|ganhei|anotar|anota|registrar|registra|lançar|lança)\b/gi, ' ')
    .replace(/\br\$\s*\d+(?:[.,]\d+)*/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)*\s*(reais|real|conto|contos|pila|pilas)?\b/gi, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^((no|na|nos|nas|de|do|da|dos|das|em|com|pra|para|o|a|um|uma|e)\s+)+/i, '')
    .trim();
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : '';
}

// ---------- respostas ----------

function responder(texto, { encerrar = true, sessao = {}, pergunta = null } = {}) {
  return {
    version: '1.0',
    sessionAttributes: sessao,
    response: {
      outputSpeech: { type: 'PlainText', text: texto },
      ...(pergunta ? { reprompt: { outputSpeech: { type: 'PlainText', text: pergunta } } } : {}),
      shouldEndSession: encerrar
    }
  };
}

// "R$ 1.234,56" lido pela Alexa em pt-BR vira "mil duzentos e trinta e quatro reais e cinquenta e seis centavos"
function falarValor(v) {
  const n = Math.round(Number(v || 0) * 100) / 100;
  const reais = Math.trunc(Math.abs(n));
  const centavos = Math.round((Math.abs(n) - reais) * 100);
  const sinal = n < 0 ? 'menos ' : '';
  if (!centavos) return `${sinal}${reais} ${reais === 1 ? 'real' : 'reais'}`;
  if (!reais) return `${sinal}${centavos} centavos`;
  return `${sinal}${reais} ${reais === 1 ? 'real' : 'reais'} e ${centavos} centavos`;
}

const VERBOS_INTENT = { PagueiIntent: 'paguei', GasteiIntent: 'gastei', CompreiIntent: 'comprei', RecebiIntent: 'recebi', GanheiIntent: 'ganhei' };
const AJUDA = 'Diga, por exemplo: paguei trinta reais no mercado com flash. Ou: recebi duzentos reais de freela no pix.';

// ---------- a skill ----------

function criarSkillAlexa(dep) {
  // dep: interpretarFraseComIA, interpretarTransacaoSemIA, numerosPorExtenso, sugerirFormaPagamento, saldoVale,
  //      metodoDeVale, linhaFaturaOuSaldo, addTransaction, getBestUserPatternCategory, idDoLivro, livro, log,
  //      skillId (string), usuarios (Set, vazio = qualquer conta da skill), limiarCategoria
  const log = dep.log || console.log;

  async function montarPendente(frase) {
    const texto = dep.numerosPorExtenso(frase);
    const { metodo, resto } = detectarFormaPagamento(texto);
    const padrao = dep.getBestUserPatternCategory(dep.idDoLivro(), resto);
    let dados = null, semIA = false;
    try {
      dados = await dep.interpretarFraseComIA(resto, padrao, 'alexa.parseTransaction');
    } catch (e) {
      log(`⚠️ [Alexa] IA indisponível (${String(e && e.message || e).slice(0, 120)}) — interpretando sem IA`);
      dados = dep.interpretarTransacaoSemIA(resto, padrao);
      semIA = true;
    }
    if (!dados || !(Number(dados.valor) > 0)) return null;
    if (!semIA && padrao && padrao.totalConfidence >= dep.limiarCategoria) dados.cat = padrao.category;
    const tipo = dados.tipo === 'income' ? 'income' : 'expense';
    const sugestao = !metodo && tipo === 'expense' ? dep.sugerirFormaPagamento(dados.desc, dados.cat, Number(dados.valor)) : null;
    return {
      frase: texto, desc: limparDescricao(dados.desc) || limparDescricao(resto) || 'Sem descrição', valor: Math.round(Number(dados.valor) * 100) / 100,
      tipo, cat: dados.cat || (tipo === 'income' ? 'Outros Rendimentos' : 'Outros Gastos'),
      metodo: metodo || (sugestao && sugestao.metodo) || null, sugerido: !metodo && Boolean(sugestao), semIA
    };
  }

  function perguntaConfirmacao(p) {
    const tipo = p.tipo === 'income' ? 'Receita' : 'Despesa';
    let aviso = '';
    const vale = dep.metodoDeVale(p.metodo);
    if (vale && p.tipo === 'expense') {
      const s = dep.saldoVale(vale);
      if (s && s.saldo < p.valor) aviso = ` Atenção: o saldo do ${vale} está em ${falarValor(s.saldo)}.`;
    }
    return `${tipo} de ${falarValor(p.valor)}, ${p.desc}, categoria ${p.cat}, ${p.tipo === 'income' ? 'em' : 'no'} ${p.metodo}`
      + `${p.sugerido ? ', pelo seu histórico' : ''}.${aviso} Confirma?`;
  }

  async function gravar(p) {
    const r = await dep.addTransaction({
      description: p.desc, amount: p.valor, type: p.tipo, category: p.cat, paymentMethod: p.metodo,
      date: dep.hoje(), user: dep.livro(), userId: dep.idDoLivro(), userName: 'Alexa'
    });
    if (!r || !r.success) throw new Error((r && r.error) || 'falha ao gravar');
    const extra = String(dep.linhaFaturaOuSaldo({ type: p.tipo, paymentMethod: p.metodo, date: dep.hoje(), user: dep.livro() }) || '')
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}️]/gu, '').replace(/\s*\(crédito de [^)]*\)/, '').trim();
    return extra ? `Pronto, registrado. ${extra}.` : 'Pronto, registrado.';
  }

  async function tratar(corpo) {
    const req = corpo.request || {};
    const sessao = (corpo.session && corpo.session.attributes) || {};
    const pendente = sessao.pendente || null;

    if (req.type === 'LaunchRequest') {
      return responder(`Financeiro aberto. ${AJUDA}`, { encerrar: false, pergunta: AJUDA });
    }
    if (req.type === 'SessionEndedRequest') return responder('', { encerrar: true });
    if (req.type !== 'IntentRequest') return responder('Não entendi.', { encerrar: true });

    const nome = req.intent && req.intent.name;
    const slots = (req.intent && req.intent.slots) || {};
    const slot = (k) => (slots[k] && slots[k].value ? String(slots[k].value) : '');

    if (nome === 'AnotarIntent' || VERBOS_INTENT[nome]) {
      const frase = [VERBOS_INTENT[nome], slot('frase')].filter(Boolean).join(' ').trim();
      if (!slot('frase')) return responder(`Não ouvi a compra. ${AJUDA}`, { encerrar: false, pergunta: AJUDA });
      const p = await montarPendente(frase);
      log(`🗣️ [Alexa] "${frase}" → ${p ? `${p.desc} | ${p.valor} | ${p.cat} | ${p.metodo || '?'}` : 'sem valor'}`);
      if (!p) return responder(`Não entendi o valor em: ${frase}. ${AJUDA}`, { encerrar: false, pergunta: AJUDA });
      if (!p.metodo) {
        const q = `${falarValor(p.valor)}, ${p.desc}. Qual foi a forma de pagamento? Por exemplo: flash, pix, débito ou dinheiro.`;
        return responder(q, { encerrar: false, sessao: { pendente: p }, pergunta: 'Qual foi a forma de pagamento?' });
      }
      return responder(perguntaConfirmacao(p), { encerrar: false, sessao: { pendente: p }, pergunta: 'Confirma? Diga sim ou não.' });
    }

    if (nome === 'FormaPagamentoIntent') {
      if (!pendente) return responder(`Primeiro me diga a compra. ${AJUDA}`, { encerrar: false, pergunta: AJUDA });
      const s = slots.forma || {};
      const resolvido = s.resolutions && s.resolutions.resolutionsPerAuthority
        && s.resolutions.resolutionsPerAuthority.find(a => a.status && a.status.code === 'ER_SUCCESS_MATCH');
      const metodo = (resolvido && resolvido.values[0].value.name) || detectarFormaPagamento(slot('forma')).metodo;
      if (!metodo) {
        return responder('Não reconheci a forma de pagamento. Diga flash, pluxee, pix neon, pix sicredi, débito, magazine ou dinheiro.',
          { encerrar: false, sessao, pergunta: 'Qual foi a forma de pagamento?' });
      }
      const p = { ...pendente, metodo, sugerido: false };
      return responder(perguntaConfirmacao(p), { encerrar: false, sessao: { pendente: p }, pergunta: 'Confirma? Diga sim ou não.' });
    }

    if (nome === 'AMAZON.YesIntent') {
      if (!pendente || !pendente.metodo) return responder('Não há nada para confirmar. ' + AJUDA, { encerrar: false, pergunta: AJUDA });
      try {
        return responder(await gravar(pendente), { encerrar: true });
      } catch (e) {
        log(`❌ [Alexa] Não consegui gravar: ${e.message}`);
        return responder('Não consegui registrar agora. Tente pelo Telegram.', { encerrar: true });
      }
    }
    if (nome === 'AMAZON.NoIntent' || nome === 'AMAZON.CancelIntent' || nome === 'AMAZON.StopIntent') {
      return responder(pendente ? 'Tudo bem, não registrei.' : 'Até mais.', { encerrar: true });
    }
    if (nome === 'AMAZON.HelpIntent') return responder(AJUDA, { encerrar: false, sessao, pergunta: AJUDA });
    if (nome === 'AMAZON.NavigateHomeIntent') return responder('Até mais.', { encerrar: true });
    return responder(`Não entendi. ${AJUDA}`, { encerrar: false, sessao, pergunta: AJUDA });   // FallbackIntent etc.
  }

  // Handler do Express. corpo bruto em req.rawBody (express.json com verify, ver sistema-mobile-3004.js)
  async function rota(req, res) {
    let corpo;
    try {
      corpo = await (dep.verificar || verificarRequisicaoAlexa)(req.headers, req.rawBody);
    } catch (e) {
      log(`🚫 [Alexa] Pedido recusado: ${e.message}`);
      return res.status(400).json({ error: 'pedido inválido' });
    }
    const appId = (corpo.session && corpo.session.application && corpo.session.application.applicationId)
      || (corpo.context && corpo.context.System && corpo.context.System.application && corpo.context.System.application.applicationId);
    const usuario = (corpo.session && corpo.session.user && corpo.session.user.userId)
      || (corpo.context && corpo.context.System && corpo.context.System.user && corpo.context.System.user.userId) || '';
    if (!dep.skillId || appId !== dep.skillId) {
      log(`🚫 [Alexa] Skill não autorizada: ${appId} (configure ALEXA_SKILL_ID no .env)`);
      return res.status(403).json({ error: 'skill não autorizada' });
    }
    if (dep.usuarios && dep.usuarios.size && !dep.usuarios.has(usuario)) {
      log(`🚫 [Alexa] Conta Amazon não autorizada: ${usuario.slice(0, 40)}…`);
      return res.status(403).json({ error: 'conta não autorizada' });
    }
    log(`🗣️ [Alexa] ${corpo.request && corpo.request.type} ${(corpo.request && corpo.request.intent && corpo.request.intent.name) || ''} (conta ${usuario.slice(-12)})`);
    try {
      res.json(await tratar(corpo));
    } catch (e) {
      log(`❌ [Alexa] Erro: ${e && e.stack ? e.stack : e}`);
      res.json(responder('Tive um problema agora. Tente de novo em instantes.', { encerrar: true }));
    }
  }

  return { rota, tratar, montarPendente };
}

module.exports = { criarSkillAlexa, verificarRequisicaoAlexa, detectarFormaPagamento, urlCadeiaValida, falarValor, responder, limparDescricao };
