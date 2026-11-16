const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const moment = require('moment-timezone');

let Tesseract = null;
try {
  Tesseract = require('tesseract.js');
} catch (e) {}

// Confiança mínima (0-1) para considerar uma leitura como "sucesso" plausível.
// Combina a confiança real do Tesseract com um score de legibilidade do texto extraído.
const MIN_OCR_CONFIDENCE = Number(process.env.OCR_MIN_CONFIDENCE || 0.30);

class TesseractOCR {
  constructor() {
    this.worker = null;
    this.isInitialized = false;
    this.initPromise = null;
  }

  async setReceiptOptimizedParameters() {
    const worker = this.worker;
    if (!worker) return;
    if (typeof worker.setParameters !== 'function') return;

    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzR$RSrs.,: /-',
      preserve_interword_spaces: '1',
      textord_min_linesize: '2.5'
    });
  }

  async init() {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (!Tesseract) {
        throw new Error("Dependência ausente: execute 'npm install tesseract.js' no projeto para habilitar o OCR Tesseract.");
      }

      console.log('🔧 Inicializando Tesseract.js...');

      const createWorker = typeof Tesseract.createWorker === 'function'
        ? Tesseract.createWorker
        : (typeof Tesseract?.default?.createWorker === 'function' ? Tesseract.default.createWorker : null);

      if (!createWorker) {
        throw new Error("Não foi possível inicializar o Tesseract: createWorker não encontrado no pacote instalado.");
      }

      // Cache persistente pros dados de idioma (evita rebaixar o .traineddata a cada restart do processo)
      const cacheDir = path.join(__dirname, 'tessdata-cache');
      try {
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      } catch (e) {}

      let worker = null;
      try {
        // API moderna do tesseract.js (v5+): já carrega e inicializa o idioma numa única chamada,
        // sem precisar de .load()/.loadLanguage()/.initialize() (métodos legados e depreciados)
        worker = await createWorker('por', 1, { cachePath: cacheDir });
      } catch (e) {
        console.warn(`⚠️ Falha ao inicializar Tesseract com idioma "por" (${e.message}). Tentando fallback "eng"...`);
        try {
          if (worker?.terminate) await worker.terminate();
        } catch (terminateErr) {}
        try {
          worker = await createWorker('eng', 1, { cachePath: cacheDir });
        } catch (e2) {
          // Último recurso: tenta a API antiga, para instalações com uma versão diferente do pacote
          worker = await createWorker();
          if (worker?.load) await worker.load();
          if (worker?.loadLanguage) await worker.loadLanguage('eng');
          if (worker?.initialize) await worker.initialize('eng');
        }
      }

      if (!worker?.recognize) {
        throw new Error("Tesseract inicializado mas worker inválido (método recognize ausente).");
      }

      this.worker = worker;
      this.isInitialized = true;
      console.log('✅ Tesseract.js inicializado com sucesso!');
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  // Calcula o limiar ótimo de binarização (método de Otsu) a partir do histograma
  // de tons de cinza da imagem, em vez de usar um valor fixo (128) que só funciona
  // bem em fotos com iluminação/contraste uniformes.
  async computeOtsuThreshold(grayscaleBuffer) {
    try {
      const { data } = await sharp(grayscaleBuffer).raw().toBuffer({ resolveWithObject: true });
      const histogram = new Array(256).fill(0);
      for (let i = 0; i < data.length; i++) histogram[data[i]]++;
      const total = data.length;
      if (!total) return 128;

      let sum = 0;
      for (let t = 0; t < 256; t++) sum += t * histogram[t];

      // Em imagens com um histograma bem bimodal (pouquíssimos tons distintos), pode haver
      // um "empate" de variância máxima ao longo de vários t seguidos — nesse caso usamos o
      // ponto médio do empate em vez do primeiro t, evitando escolher um limiar extremo.
      let sumB = 0, wB = 0, varMax = -1, tiedSum = 0, tiedCount = 0;
      const EPS = 1e-9;
      for (let t = 0; t < 256; t++) {
        wB += histogram[t];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;
        sumB += t * histogram[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > varMax + EPS) {
          varMax = varBetween;
          tiedSum = t;
          tiedCount = 1;
        } else if (Math.abs(varBetween - varMax) <= EPS) {
          tiedSum += t;
          tiedCount += 1;
        }
      }
      return tiedCount > 0 ? Math.round(tiedSum / tiedCount) : 128;
    } catch (e) {
      return 128;
    }
  }

  // Score de 0 a 1 indicando o quão "legível"/plausível um texto parece
  // (proporção de caracteres alfanuméricos reais e presença de palavras de verdade),
  // usado para distinguir texto de comprovante real de ruído de OCR mal-sucedido.
  textPlausibilityScore(text) {
    const s = String(text || '').trim();
    if (!s) return 0;

    const totalNoSpace = s.replace(/\s/g, '').length;
    if (totalNoSpace === 0) return 0;

    const alnum = (s.match(/[A-Za-zÀ-ÿ0-9]/g) || []).length;
    const ratio = alnum / totalNoSpace;

    const realWords = s.split(/\s+/).filter(w => (w.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 3);
    const wordScore = Math.min(realWords.length / 6, 1);

    return Math.max(0, Math.min(1, ratio * 0.6 + wordScore * 0.4));
  }

  // Checa se uma linha de texto parece um nome de verdade (estabelecimento),
  // e não ruído de OCR tipo "F is 3 SZ 7 3 A".
  isPlausibleLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    const totalNoSpace = s.replace(/\s/g, '').length;
    if (totalNoSpace === 0) return false;
    const letters = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    const letterRatio = letters / totalNoSpace;
    const realWords = s.split(/\s+/).filter(w => (w.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 3);
    return letterRatio >= 0.55 && realWords.length >= 1;
  }

  async preprocessImageToBuffer(imagePath, options = {}) {
    try {
      console.log('🎨 Pré-processando imagem...');
      const {
        width = 1200,
        quality = 85,
        applyThreshold = true,
        autoThreshold = true,
        threshold = 128
      } = options;

      // .rotate() sem argumentos = corrige automaticamente a orientação EXIF
      // (fotos de celular tiradas de lado/cabeça pra baixo), que antes não era tratada aqui.
      let pipeline = sharp(imagePath)
        .rotate()
        .resize(width, null, { withoutEnlargement: true, fit: 'inside' })
        .grayscale()
        .normalize()
        .sharpen();

      if (!applyThreshold) {
        return await pipeline.jpeg({ quality }).toBuffer();
      }

      // Branch do pipeline (sharp suporta .clone()) só pra medir o histograma
      // e calcular o limiar ideal antes de aplicar o threshold definitivo.
      const grayBuffer = await pipeline.clone().png().toBuffer();
      const finalThreshold = autoThreshold ? await this.computeOtsuThreshold(grayBuffer) : threshold;

      const processedBuffer = await pipeline.threshold(finalThreshold).jpeg({ quality }).toBuffer();
      return processedBuffer;
    } catch (error) {
      console.error('❌ Erro no pré-processamento:', error.message);
      return fs.readFileSync(imagePath);
    }
  }

  parsePossibleBRL(raw) {
    const cleaned = String(raw || '')
      .replace(/R\$/gi, '')
      .replace(/\bRS\b/gi, '')
      .replace(/\s/g, '')
      .trim();

    if (!cleaned) return null;

    if (/^\d{1,3}(\.\d{3})*(,\d{2})$/.test(cleaned)) {
      const normalized = cleaned.replace(/\./g, '').replace(',', '.');
      const n = parseFloat(normalized);
      return Number.isFinite(n) ? n : null;
    }

    if (/^\d+(,\d{2})$/.test(cleaned)) {
      const n = parseFloat(cleaned.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }

    if (/^\d{1,5}$/.test(cleaned)) {
      const n = parseInt(cleaned, 10);
      return Number.isFinite(n) ? n : null;
    }

    return null;
  }

  normalizeMonthName(raw) {
    const s = String(raw || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z]/g, '');
    if (!s) return '';
    return s;
  }

  monthFromText(raw) {
    const s = this.normalizeMonthName(raw);
    if (!s) return null;
    const map = {
      jan: '01',
      fev: '02',
      mar: '03',
      abr: '04',
      mai: '05',
      jun: '06',
      jul: '07',
      ago: '08',
      set: '09',
      out: '10',
      nov: '11',
      dez: '12'
    };
    const key = s.slice(0, 3);
    return map[key] || null;
  }

  // Retorna TODOS os candidatos a valor encontrados no texto, ordenados por score
  // (do mais provável pro menos provável), em vez de só o melhor — assim quem chama
  // pode decidir, e também cruzar esse score com a confiança da variante de OCR usada.
  extractAmountCandidates(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const priorityLines = lines.filter(l => /(total|voc[eê]\s+pag|valor|pix\s+enviado|pagamento)/i.test(l));
    const sources = [
      ...priorityLines,
      String(text || '')
    ];

    const patterns = [
      /(?:R\$|RS)\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,\d{2})?)/gi,
      /R?\$?\s*([0-9]{1,3}(?:\.[0-9]{3})*,\d{2})/gi,
      /([0-9]{1,3}(?:\.[0-9]{3})*,\d{2})/g,
      /(\d+,\d{2})/g,
      /(?:R\$|RS)\s*(\d{1,5})(?!\d)/gi,
      /(?:total|valor\s+pago|valor)\s*(?:rs|r\$)?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,\d{2})?)/gi
    ];

    const candidates = [];
    for (const src of sources) {
      for (const pattern of patterns) {
        const matches = String(src).matchAll(pattern);
        for (const match of matches) {
          const raw = match[1] || match[0];
          const amount = this.parsePossibleBRL(raw);
          if (!Number.isFinite(amount)) continue;
          if (amount <= 0 || amount >= 100000) continue;
          if (amount >= 1900 && amount <= 2100) continue;

          let score = 0;
          const srcLower = String(src).toLowerCase();
          if (srcLower.includes('total') || srcLower.includes('você pag') || srcLower.includes('voce pag')) score += 10;
          if (/r\$/i.test(raw)) score += 5;
          if (String(raw).includes(',') && /\d,\d{2}/.test(String(raw))) score += 3;
          if (amount < 1000) score += 2;
          if (amount < 100) score += 1;
          candidates.push({ amount, score });
        }
      }
    }

    if (!candidates.length) return [];
    candidates.sort((a, b) => b.score - a.score || b.amount - a.amount);
    return candidates;
  }

  extractAmount(text) {
    const candidates = this.extractAmountCandidates(text);
    return candidates.length ? candidates[0].amount : null;
  }

  extractDate(text) {
    const patterns = [
      /(\d{2})\/(\d{2})\/(\d{4})/g,
      /(\d{2})\/(\d{2})\/(\d{2})/g,
      /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/g,
      /(\d{1,2})\s+(?:de\s+)?([A-Za-zÀ-ÿ]+)\s+(?:de\s+)?(\d{4})/gi
    ];

    for (const pattern of patterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const g = pattern.flags.includes('i') ? 3 : 0;
        if (g) {
          const day = String(match[1]).padStart(2, '0');
          const month = this.monthFromText(match[2]);
          const year = match[3];
          if (!month) continue;
          const date = moment(`${year}-${month}-${day}`, 'YYYY-MM-DD');
          if (date.isValid() && date.year() >= 2020 && date.year() <= 2030) return date.format('YYYY-MM-DD');
          continue;
        }

        const day = match[1];
        const month = match[2];
        let year = match[3];
        if (year.length === 2) year = `20${year}`;
        const date = moment(`${year}-${month}-${day}`, 'YYYY-MM-DD');
        if (date.isValid() && date.year() >= 2020 && date.year() <= 2030) return date.format('YYYY-MM-DD');
      }
    }
    return moment().format('YYYY-MM-DD');
  }

  extractEstablishment(text) {
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 3 && line.length < 60)
      .filter(line => this.isPlausibleLine(line));

    const establishmentPatterns = [
      /^(supermercado|mercado|padaria|farmácia|farmacia|posto|restaurante|lanchonete)/i,
      /^(extra|carrefour|pão de açúcar|pao de acucar|assai|atacadão|atacadao)/i,
      /^[A-Z][a-z]+ (mercado|supermercado)/i
    ];

    for (const line of lines) {
      for (const pattern of establishmentPatterns) {
        if (pattern.test(line)) return line.substring(0, 50);
      }
    }

    const firstLine = lines.find(line => !line.match(/^(\d|total|valor|cgc|cnpj|data|hora)/i));
    return firstLine ? firstLine.substring(0, 50) : 'Estabelecimento não identificado';
  }

  suggestCategory(text, amount) {
    const textLower = text.toLowerCase();
    const categories = {
      'Alimentação': ['supermercado', 'mercado', 'padaria', 'açougue', 'hortifruti', 'feira'],
      'Transporte': ['uber', '99', 'taxi', 'gasolina', 'posto', 'estacionamento', 'pedágio', 'pedagio'],
      'Lazer': ['cinema', 'teatro', 'show', 'bar', 'restaurante', 'lanchonete', 'hamburgueria'],
      'Saúde': ['farmácia', 'farmacia', 'hospital', 'clínica', 'clinica', 'médico', 'medico', 'dentista', 'laboratório', 'laboratorio'],
      'Educação': ['escola', 'faculdade', 'curso', 'livro', 'material', 'universidade'],
      'Moradia': ['água', 'agua', 'luz', 'energia', 'gás', 'gas', 'aluguel', 'condomínio', 'condominio', 'iptu'],
      'Compras': ['magazine', 'loja', 'shopee', 'mercadolivre', 'amazon', 'shein']
    };

    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => textLower.includes(keyword))) return category;
    }

    if (amount < 50) return 'Pequenas Compras';
    if (amount > 500) return 'Grandes Compras';
    return 'Outros Gastos';
  }

  suggestPaymentMethod(text) {
    const textLower = text.toLowerCase();
    if (textLower.includes('pix') && textLower.includes('neon')) return 'Pix Neon';
    if (textLower.includes('pix')) return 'PIX';
    if (textLower.includes('débito') || textLower.includes('debito')) return 'Cartão de Débito';
    if (textLower.includes('crédito') || textLower.includes('credito')) return 'Cartão de Crédito';
    if (textLower.includes('dinheiro')) return 'Dinheiro';
    if (textLower.includes('vale') || textLower.includes('refeição') || textLower.includes('refeicao')) return 'VR Pluxee';
    return 'Não informado';
  }

  analyzePixNeon(text) {
    const fullText = String(text || '');
    const normalized = fullText.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();

    let systemType = null;
    let systemCategory = null;
    const systemPaymentMethod = 'Pix Neon';

    if (lower.includes('pix enviado')) {
      systemType = 'expense';
      systemCategory = 'Transferência';
    } else if (lower.includes('pix recebido')) {
      systemType = 'income';
      systemCategory = 'Outros Rendimentos';
    }

    let quemPagou = null;
    let quemRecebeu = null;
    const quemRecebeuMatch = fullText.match(/Quem recebeu[\s\S]*?Nome[\s\S]*?([A-ZÀ-Ÿ][A-ZÀ-Ÿ\s]+?)(?:\n|CPF|CNPJ|$)/i);
    if (quemRecebeuMatch) quemRecebeu = String(quemRecebeuMatch[1]).trim();

    const quemPagouMatch = fullText.match(/Quem pagou[\s\S]*?Nome[\s\S]*?([A-ZÀ-Ÿ][A-ZÀ-Ÿ\s]+?)(?:\n|CPF|CNPJ|$)/i);
    if (quemPagouMatch) quemPagou = String(quemPagouMatch[1]).trim();

    let description = 'Transação Pix';
    if (systemType === 'expense' && quemRecebeu) description = `Pix enviado para ${quemRecebeu}`;
    else if (systemType === 'income' && quemPagou) description = `Pix recebido de ${quemPagou}`;
    else if (systemType === 'expense') description = 'Pix enviado';
    else if (systemType === 'income') description = 'Pix recebido';

    const idMatch = fullText.match(/ID de transa[cç][aã]o[\s\S]*?([A-Z0-9]{20,})/i);
    const transactionId = idMatch ? String(idMatch[1]).trim() : null;

    const cnpjMatch = fullText.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
    const cnpjRecebeu = cnpjMatch ? String(cnpjMatch[1]).trim() : null;

    return {
      bank: 'Neon',
      kind: 'PIX',
      systemType,
      systemCategory,
      systemPaymentMethod,
      description,
      whoPaid: quemPagou,
      whoReceived: quemRecebeu,
      transactionId,
      receiverCnpj: cnpjRecebeu
    };
  }

  async extractReceiptData(imagePath) {
    try {
      console.log('🔍 Iniciando OCR com Tesseract...');
      if (!this.isInitialized) await this.init();
      await this.setReceiptOptimizedParameters();

      console.log('📸 Reconhecendo texto...');

      // Gera até 3 variantes da imagem em vez de confiar só na primeira:
      // (A) preto-e-branco com threshold adaptativo (Otsu) — melhor pra recibo bem iluminado/nítido
      // (B) tons de cinza normalizados, sem threshold rígido — melhor pra foto com sombra/luz irregular
      // (C) arquivo original sem nenhum tratamento — rede de segurança
      const variants = [];
      try {
        variants.push({ label: 'otsu', source: await this.preprocessImageToBuffer(imagePath, { applyThreshold: true, autoThreshold: true, width: 1200 }) });
      } catch (e) {}
      try {
        variants.push({ label: 'grayscale', source: await this.preprocessImageToBuffer(imagePath, { applyThreshold: false, width: 1400 }) });
      } catch (e) {}
      variants.push({ label: 'original', source: imagePath });

      const attempts = [];
      for (const variant of variants) {
        try {
          const { data } = await this.worker.recognize(variant.source);
          const text = String(data?.text || '');
          const cleanText = text
            .replace(/[^\w\s\.,;:!?$R$\d\/-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          const rawConfidence = Number(data?.confidence);
          const tessConfidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(100, rawConfidence)) / 100 : 0;
          const plausibility = this.textPlausibilityScore(cleanText || text);
          const amountCandidates = this.extractAmountCandidates(text || cleanText);
          const topAmount = amountCandidates.length ? amountCandidates[0] : null;

          // Rank pondera: confiança real do Tesseract + legibilidade do texto + achou um valor plausível.
          // Isso evita que a PRIMEIRA variante a encontrar qualquer número "vença" mesmo sendo ruído.
          const rank = (tessConfidence * 0.45) + (plausibility * 0.35) + (topAmount ? 0.20 : 0);

          attempts.push({ label: variant.label, text, cleanText, tessConfidence, plausibility, topAmount, rank });
        } catch (e) {
          console.warn(`⚠️ Falha ao reconhecer variante "${variant.label}" da imagem:`, e.message);
        }
      }

      if (!attempts.length) {
        throw new Error('Nenhuma variante da imagem pôde ser processada pelo Tesseract.');
      }

      attempts.sort((a, b) => b.rank - a.rank);
      const chosen = attempts.find(a => a.topAmount) || attempts[0];

      const text = chosen.text;
      const cleanText = chosen.cleanText;
      const amount = chosen.topAmount ? chosen.topAmount.amount : null;
      const ocrConfidence = Math.max(0, Math.min(1, (chosen.tessConfidence * 0.6) + (chosen.plausibility * 0.4)));

      console.log(`📝 Texto extraído (${cleanText.length} caracteres) [variante escolhida: ${chosen.label}, confiança Tesseract: ${(chosen.tessConfidence * 100).toFixed(0)}%, legibilidade: ${(chosen.plausibility * 100).toFixed(0)}%]`);
      if (cleanText) console.log(`   Preview: ${cleanText.substring(0, 200)}...`);

      const date = this.extractDate(cleanText);
      const establishment = this.extractEstablishment(text);
      const paymentMethod = this.suggestPaymentMethod(cleanText);
      const suggestedCategory = this.suggestCategory(cleanText, amount || 0);
      const pixNeon = (cleanText.toLowerCase().includes('neon') && cleanText.toLowerCase().includes('pix'))
        ? this.analyzePixNeon(text)
        : null;

      const success = amount !== null && amount > 0;
      console.log(`✅ OCR concluído: ${success ? 'Sucesso' : 'Falha'} (confiança final: ${(ocrConfidence * 100).toFixed(0)}%)`);
      if (success) {
        console.log(`   💰 Valor: R$ ${amount}`);
        console.log(`   📍 Estabelecimento: ${establishment}`);
        console.log(`   📅 Data: ${date}`);
        if (ocrConfidence < MIN_OCR_CONFIDENCE) {
          console.log(`   ⚠️ Confiança abaixo do mínimo recomendado (${(MIN_OCR_CONFIDENCE * 100).toFixed(0)}%) — resultado pode estar incorreto, recomenda-se confirmação.`);
        }
      }

      return {
        success,
        amount: amount || 0,
        description: pixNeon?.description || establishment,
        date,
        paymentMethod: pixNeon?.systemPaymentMethod || paymentMethod,
        suggestedCategory: pixNeon?.systemCategory || suggestedCategory,
        systemType: pixNeon?.systemType || null,
        systemCategory: pixNeon?.systemCategory || null,
        systemPaymentMethod: pixNeon?.systemPaymentMethod || null,
        pix: pixNeon || null,
        // Confiança REAL agora (mistura confiança nativa do Tesseract + legibilidade do texto),
        // em vez do valor fixo 0.85/0 que existia antes independente da qualidade da leitura.
        confidence: Number(ocrConfidence.toFixed(2)),
        lowConfidence: success && ocrConfidence < MIN_OCR_CONFIDENCE,
        rawText: cleanText.substring(0, 500),
        error: success ? '' : 'Não foi possível extrair os dados da imagem'
      };
    } catch (error) {
      console.error('❌ Erro no OCR com Tesseract:', error.message);
      return {
        success: false,
        amount: 0,
        description: '',
        date: moment().format('YYYY-MM-DD'),
        paymentMethod: '',
        suggestedCategory: 'Outros',
        confidence: 0,
        lowConfidence: false,
        error: error.message
      };
    }
  }

  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      console.log('✅ Tesseract finalizado');
    }
  }
}

module.exports = new TesseractOCR();
