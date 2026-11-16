'use strict';

const fs = require('fs');

// Utilitários compartilhados por sistema-mobile-3004.js.
// Só código de servidor: o JavaScript embutido nas páginas HTML (dashboard, login…)
// roda no navegador e não pode dar require neste arquivo.

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

// Valor -> "R$ 1.234,56". null/undefined/NaN/'' viram "R$ 0,00".
function formatBRL(value) {
  return BRL.format(value || 0);
}

// Escapa texto para HTML/Telegram parse_mode HTML. null/undefined viram ''
// (0 e false são preservados como '0' e 'false').
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Texto digitado pelo usuário -> número, ou null se inválido.
// Aceita "R$ 1.234,56", "1234,5", "-10", dígitos árabes/persas, espaços especiais.
// Números JS passam direto (se finitos), inclusive 0.
function parseMoneyBR(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  try {
    const raw = String(value || '').trim();
    if (!raw) return null;
    let v = raw.normalize('NFKC');
    v = v.replace(/ | /g, ' ').replace(/\s+/g, '');
    v = v.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    v = v.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
    v = v.replace(/[^\d,.\-]/g, '');
    if (!v || v === '-' || v === ',' || v === '.') return null;
    const lastComma = v.lastIndexOf(',');
    const lastDot = v.lastIndexOf('.');
    const lastSep = Math.max(lastComma, lastDot);
    const neg = v.includes('-') ? '-' : '';
    let normalized = '';
    if (lastSep >= 0) {
      const intDigits = v.slice(0, lastSep).replace(/[^\d]/g, '');
      const fracDigits = v.slice(lastSep + 1).replace(/[^\d]/g, '').slice(0, 2);
      const intPart = intDigits ? intDigits : '0';
      normalized = fracDigits ? (neg + intPart + '.' + fracDigits) : (neg + intPart);
    } else {
      const digits = v.replace(/[^\d]/g, '');
      if (!digits) return null;
      normalized = neg + digits;
    }
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Espaço do filesystem que contém `dir`: { totalGB, freeGB, usedPct } ou null se não der para ler.
function diskUsage(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalGB: total / 1e9, freeGB: free / 1e9, usedPct: total ? Math.round((1 - free / total) * 100) : 0 };
  } catch (e) {
    return null;
  }
}

// 1536 -> "1.5 KB"
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function validarCpf(cpf) {
  const d = String(cpf ?? '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1+$/.test(d)) return false;

  let soma = 0;
  for (let i = 0; i < 9; i += 1) soma += Number(d[i]) * (10 - i);
  const resto = soma % 11;
  const digito1 = resto < 2 ? 0 : 11 - resto;
  if (Number(d[9]) !== digito1) return false;

  soma = 0;
  for (let i = 0; i < 10; i += 1) soma += Number(d[i]) * (11 - i);
  const resto2 = soma % 11;
  const digito2 = resto2 < 2 ? 0 : 11 - resto2;
  return Number(d[10]) === digito2;
}

module.exports = { formatBRL, escapeHtml, parseMoneyBR, sleep, diskUsage, formatBytes, validarCpf };
