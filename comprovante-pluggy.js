// Comprovante em imagem para transações que chegam pelo Pluggy (21/10/2026, pedido do usuário).
// O Pluggy não fornece o comprovante do banco, só os dados da transação (valor, data, descrição e, no PIX,
// pagador/recebedor). Aqui esses dados viram um SVG que o saveReceiptFile (sharp) grava como JPG no campo
// de comprovante que o sistema já tem. O rodapé deixa claro que não é o documento oficial do banco.

const BANCOS = {
  '001': 'Banco do Brasil', '033': 'Santander', '077': 'Inter', '104': 'Caixa', '197': 'Stone',
  '208': 'BTG Pactual', '212': 'Banco Original', '237': 'Bradesco', '260': 'Nubank', '290': 'PagBank',
  '323': 'Mercado Pago', '336': 'C6 Bank', '341': 'Itaú', '380': 'PicPay', '403': 'Cora', '536': 'Neon',
  '655': 'Neon (Votorantim)', '748': 'Sicredi', '756': 'Sicoob'
};

const LARGURA = 720;
const CORES = { fundo: '#ffffff', faixa: '#14532d', texto: '#111827', fraco: '#6b7280', linha: '#e5e7eb', saida: '#b91c1c', entrada: '#15803d' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function moeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// CPF no padrão dos comprovantes PIX: ***.456.789-**. CNPJ aparece inteiro (é público).
function documento(doc) {
  if (!doc || !doc.value) return null;
  const d = String(doc.value).replace(/\D/g, '');
  if (d.length === 11) return `CPF ***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `CNPJ ${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return `${doc.type || 'Doc.'} ${d.length > 4 ? '***' + d.slice(-4) : d}`;
}

function banco(p) {
  const cod = p.routingNumber ? String(p.routingNumber).padStart(3, '0') : null;
  if (cod) return BANCOS[cod] ? `${BANCOS[cod]} (${cod})` : `Banco ${cod}`;
  return p.routingNumberISPB ? `ISPB ${p.routingNumberISPB}` : null;
}

function quebrar(texto, max) {
  const linhas = [];
  let atual = '';
  for (const palavra of String(texto || '').split(/\s+/).filter(Boolean)) {
    if ((atual + ' ' + palavra).trim().length > max && atual) { linhas.push(atual); atual = palavra; }
    else atual = (atual + ' ' + palavra).trim();
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : ['—'];
}

function tipoOperacao(t, tipo) {
  const entrada = tipo === 'income';
  const pd = t && t.paymentData;
  if ((t && t.operationType === 'PIX') || (pd && pd.paymentMethod === 'PIX')) return entrada ? 'PIX recebido' : 'PIX enviado';
  if (pd && pd.boletoMetadata) return 'Pagamento de boleto';
  if (t && t.creditCardMetadata) return 'Compra no cartão de crédito';
  if (t && t.operationType) return `${String(t.operationType).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}${entrada ? ' (entrada)' : ' (saída)'}`;
  return entrada ? 'Entrada na conta' : 'Saída da conta';
}

function dataHora(t, dataGravada) {
  // Data e hora reais da transação (fuso de São Paulo); sem o dado do Pluggy, só a data gravada no sistema.
  if (t && t.date) {
    const d = new Date(t.date);
    if (!isNaN(d)) {
      const f = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const hora = d.toISOString().slice(11, 19) === '00:00:00' ? null : f.format(d).replace(',', ' às');
      return hora || f.format(d).split(',')[0];
    }
  }
  const [a, m, dia] = String(dataGravada || '').split('-');
  return a && m && dia ? `${dia}/${m}/${a}` : '—';
}

// dados: { banco, txId, description, amount, type, date, paymentMethod, pluggy (transação crua, opcional), cnpjInfo (dados ReceitaWS, opcional) }
function montarSvg(dados) {
  const t = dados.pluggy || null;
  const pd = (t && t.paymentData) || {};
  const entrada = dados.type === 'income';
  const ci = dados.cnpjInfo || null;
  const blocos = [];   // [titulo, [[rotulo, valor], ...]]

  blocos.push(['Transação', [
    ['Tipo', tipoOperacao(t, dados.type)],
    ['Data', dataHora(t, dados.date)],
    ['Conta', dados.paymentMethod || dados.banco],
    ...(t && t.creditCardMetadata && t.creditCardMetadata.totalInstallments > 1
      ? [['Parcela', `${t.creditCardMetadata.installmentNumber} de ${t.creditCardMetadata.totalInstallments}`]] : []),
    ...(t && t.merchant && (t.merchant.businessName || t.merchant.name) ? [['Estabelecimento', t.merchant.businessName || t.merchant.name]] : [])
  ]]);

  if (ci) {
    const cnpjFormatado = ci.cnpj && ci.cnpj.length === 14
      ? `${ci.cnpj.slice(0,2)}.${ci.cnpj.slice(2,5)}.${ci.cnpj.slice(5,8)}/${ci.cnpj.slice(8,12)}-${ci.cnpj.slice(12)}`
      : ci.cnpj;
    const linhasEstab = [
      ['Nome Fantasia', ci.fantasia],
      ['Razão Social', ci.nome],
      ['CNPJ', cnpjFormatado],
      ['Atividade (CNAE)', ci.cnaeTxt ? `${ci.cnae} - ${ci.cnaeTxt}` : ci.cnae],
      ['Endereço', ci.endereco],
      ['Cidade/UF', ci.cidadeUf],
      ['CEP', ci.cep],
      ['Telefone', ci.telefone],
      ['Situação', ci.situacao],
      ['Abertura', ci.abertura]
    ].filter(([, v]) => v);
    if (linhasEstab.length) blocos.push(['Estabelecimento (Receita Federal)', linhasEstab]);
  }

  for (const [titulo, p] of [['Quem pagou', pd.payer], ['Quem recebeu', pd.receiver]]) {
    if (!p) continue;
    const linhas = [
      ['Nome', p.name],
      ['Documento', documento(p.documentNumber)],
      ['Instituição', banco(p)],
      ['Agência', p.branchNumber],
      ['Conta', p.accountNumber ? '***' + String(p.accountNumber).slice(-4) : null]
    ].filter(([, v]) => v);
    if (linhas.length) blocos.push([titulo, linhas]);
  }

  const ids = [
    ['ID no Pluggy', t && t.id],
    ['Autenticação', pd.authenticationCode],
    ['Referência', pd.referenceNumber || pd.receiverReferenceId],
    ['Motivo', pd.reason],
    ['Código de barras', pd.boletoMetadata && pd.boletoMetadata.digitableLine]
  ].filter(([, v]) => v);
  if (!t) ids.push(['ID no sistema', dados.txId]);
  blocos.push(['Identificação', ids]);

  // layout
  const partes = [];
  let y = 0;
  partes.push(`<rect width="${LARGURA}" height="132" fill="${CORES.faixa}"/>`);
  partes.push(`<text x="40" y="58" font-size="30" font-weight="700" fill="#fff">Comprovante de transação</text>`);
  partes.push(`<text x="40" y="96" font-size="22" fill="#d1fae5">${esc(dados.banco || '')}</text>`);
  y = 196;
  partes.push(`<text x="40" y="${y}" font-size="20" fill="${CORES.fraco}">Valor</text>`);
  y += 52;
  partes.push(`<text x="40" y="${y}" font-size="46" font-weight="700" fill="${entrada ? CORES.entrada : CORES.saida}">${entrada ? '+ ' : '- '}${esc(moeda(Math.abs(dados.amount)))}</text>`);
  y += 44;
  for (const linha of quebrar(dados.description, 46)) {
    partes.push(`<text x="40" y="${y}" font-size="22" fill="${CORES.texto}">${esc(linha)}</text>`);
    y += 30;
  }

  for (const [titulo, linhas] of blocos) {
    if (!linhas.length) continue;
    y += 22;
    partes.push(`<line x1="40" x2="${LARGURA - 40}" y1="${y}" y2="${y}" stroke="${CORES.linha}" stroke-width="2"/>`);
    y += 40;
    partes.push(`<text x="40" y="${y}" font-size="22" font-weight="700" fill="${CORES.faixa}">${esc(titulo)}</text>`);
    for (const [rotulo, valor] of linhas) {
      const quebrado = quebrar(valor, 34);
      y += 36;
      partes.push(`<text x="40" y="${y}" font-size="20" fill="${CORES.fraco}">${esc(rotulo)}</text>`);
      quebrado.forEach((l, i) => {
        partes.push(`<text x="${LARGURA - 40}" y="${y + i * 28}" font-size="20" text-anchor="end" fill="${CORES.texto}">${esc(l)}</text>`);
      });
      y += (quebrado.length - 1) * 28;
    }
  }

  y += 50;
  partes.push(`<line x1="40" x2="${LARGURA - 40}" y1="${y}" y2="${y}" stroke="${CORES.linha}" stroke-width="2"/>`);
  y += 34;
  for (const linha of ['Gerado pelo sistema financeiro com os dados recebidos do Pluggy.', 'Não é o comprovante oficial emitido pelo banco.']) {
    partes.push(`<text x="${LARGURA / 2}" y="${y}" font-size="17" text-anchor="middle" fill="${CORES.fraco}">${esc(linha)}</text>`);
    y += 26;
  }
  const altura = y + 24;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGURA}" height="${altura}" viewBox="0 0 ${LARGURA} ${altura}" font-family="DejaVu Sans, Liberation Sans, sans-serif">` +
    `<rect width="${LARGURA}" height="${altura}" fill="${CORES.fundo}"/>${partes.join('')}</svg>`;
}

function gerarComprovanteSvg(dados) {
  return Buffer.from(montarSvg(dados));
}

module.exports = { gerarComprovanteSvg, _test: { documento, tipoOperacao, dataHora, quebrar } };
