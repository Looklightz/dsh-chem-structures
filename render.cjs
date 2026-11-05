'use strict';

// Render SMILES structures and whole reaction equations into standalone SVG
// files using the vendored RDKit WebAssembly build. Pure Node (no DOM).

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const INK = '#111827';
const PAPER = '#FFFFFF';
const BOND = '#111827';

const DEFAULT_CANVAS_W = 620;
const DEFAULT_CANVAS_H = 460;
const DEFAULT_PADDING = 16;

/** Target widths for the `size` parameter, in CSS pixels of the rendered image. */
const SIZE_WIDTH = { s: 300, m: 440, l: 620 };
/** Display caps enforced by the Harness markdown image style. */
const MAX_RENDER_W = 640;
const MAX_RENDER_H = 340;

/**
 * RDKit's stock palette suits white paper; these keep the same hue identity
 * with slightly deeper tones so labels read well at small sizes.
 */
const ATOM_PALETTE = {
  '#0000FF': '#3355E8', // N
  '#FF0000': '#D9383D', // O
  '#CCCC00': '#A87900', // S
  '#00CC00': '#1F9D3C', // Cl
  '#33CCCC': '#0E7C8F', // F
  '#7F4C19': '#9A5208', // Br
  '#804D1A': '#9A5208', // Br (older builds)
  '#A01EEF': '#8427A8', // I
  '#940094': '#8427A8', // I (older builds)
  '#FF7F00': '#D4560B', // P
  '#FFB5B5': '#C22A5F', // B
};

const SUBSCRIPT = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

let rdkitPromise = null;

/**
 * Load the vendored RDKit wasm module once per Host process.
 * @param {string} vendorDir - directory holding RDKit_minimal.js and .wasm
 * @returns {Promise<any>}
 */
function loadRDKit(vendorDir) {
  if (rdkitPromise) return rdkitPromise;
  const factory = require(path.join(vendorDir, 'RDKit_minimal.js'));
  rdkitPromise = Promise.resolve(factory());
  return rdkitPromise;
}

/* ------------------------------------------------------------------ */
/* Chemistry facts                                                     */
/* ------------------------------------------------------------------ */

/** @param {string} molblock @returns {{symbols: string[], charge: number}} */
function parseMolblock(molblock) {
  const lines = String(molblock).split('\n');
  const counts = lines[3] || '';
  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  const symbols = [];
  if (Number.isFinite(atomCount)) {
    for (let i = 4; i < 4 + atomCount && i < lines.length; i += 1) {
      const symbol = lines[i].slice(31, 34).trim();
      if (symbol !== '') symbols.push(symbol);
    }
  }
  let charge = 0;
  for (const line of lines) {
    if (!line.startsWith('M  CHG')) continue;
    const fields = line.trim().split(/\s+/);
    const pairs = Number.parseInt(fields[2], 10);
    if (!Number.isFinite(pairs)) continue;
    for (let i = 0; i < pairs; i += 1) {
      const value = Number.parseInt(fields[4 + i * 2], 10);
      if (Number.isFinite(value)) charge += value;
    }
  }
  return { symbols, charge };
}

/** @param {string[]} symbols @returns {string} Hill-order formula */
function hillFormula(symbols) {
  const counts = new Map();
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) || 0) + 1);
  const order = [];
  const push = (name) => {
    if (counts.has(name) && !order.includes(name)) order.push(name);
  };
  if (counts.has('C')) {
    push('C');
    push('H');
    for (const name of [...counts.keys()].sort()) if (name !== 'C' && name !== 'H') push(name);
  } else {
    for (const name of [...counts.keys()].sort()) push(name);
  }
  let text = '';
  for (const name of order) {
    const count = counts.get(name);
    text += count === 1 ? name : `${name}${count}`;
  }
  return text;
}

/**
 * Formula incl. implicit hydrogens.
 * @param {any} mol @returns {{formula: string, charge: number} | null}
 */
function molecularFormula(mol) {
  let withHydrogens = null;
  try {
    withHydrogens = mol.add_hs();
  } catch (err) {
    return null;
  }
  if (typeof withHydrogens !== 'string' || withHydrogens === '') return null;
  const parsed = parseMolblock(withHydrogens);
  if (parsed.symbols.length === 0) return null;
  return { formula: hillFormula(parsed.symbols), charge: parsed.charge };
}

/** @param {string} formula @param {number} [charge] @returns {string} */
function prettyFormula(formula, charge) {
  if (typeof formula !== 'string' || formula === '') return '';
  let text = formula.replace(/\d+/g, (digits) => [...digits].map((d) => SUBSCRIPT[d] || d).join(''));
  const q = typeof charge === 'number' && Number.isFinite(charge) ? charge : 0;
  if (q !== 0) {
    const magnitude = Math.abs(q);
    text += (magnitude === 1 ? '' : String(magnitude).replace(/\d/g, (d) => SUPERSCRIPT[d])) + (q > 0 ? '⁺' : '⁻');
  }
  return text;
}

/** Average molecular weight from RDKit descriptors. @param {any} mol */
function molecularWeight(mol) {
  let parsed = null;
  try {
    parsed = JSON.parse(mol.get_descriptors());
  } catch (err) {
    return undefined;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const first = list.find((entry) => entry && typeof entry === 'object');
  if (!first) return undefined;
  const value = typeof first.amw === 'number' ? first.amw : (typeof first.exactmw === 'number' ? first.exactmw : undefined);
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
}

/* ------------------------------------------------------------------ */
/* SVG geometry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Bounding box of everything RDKit drew (absolute coordinate pairs in `d`).
 * @param {string} svg
 */
function drawnBounds(svg) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const re = /<path\b[^>]*\bd=(?:'([^']*)'|"([^"]*)")/g;
  let match;
  while ((match = re.exec(svg)) !== null) {
    const d = match[1] !== undefined ? match[1] : match[2];
    if (!d) continue;
    const numbers = d.match(/-?\d+(?:\.\d+)?/g);
    if (!numbers) continue;
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const x = Number(numbers[i]);
      const y = Number(numbers[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Median straight-line length of the bond paths, used to normalise scale
 * between the molecules of one equation.
 * @param {string} svg
 */
function bondLength(svg) {
  const lengths = [];
  const re = /<path\b[^>]*class='bond[^']*'[^>]*\bd='M\s*([-\d.]+),([-\d.]+)\s*L\s*([-\d.]+),([-\d.]+)'/g;
  let match;
  while ((match = re.exec(svg)) !== null) {
    const dx = Number(match[3]) - Number(match[1]);
    const dy = Number(match[4]) - Number(match[2]);
    const len = Math.hypot(dx, dy);
    if (Number.isFinite(len) && len > 0) lengths.push(len);
  }
  if (lengths.length === 0) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)];
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Turn one raw RDKit SVG into drawable parts: cropped bounds, inner markup with
 * theme-ready colors, and the measured bond length.
 * @param {string} raw - RDKit SVG
 * @param {number} padding
 */
function cropSvg(raw, padding) {
  let out = String(raw).replace(/<\?xml[^>]*\?>\s*/i, '');
  out = out.replace(/<rect\b[^>]*fill:#FFFFFF[^>]*>\s*<\/rect>/gi, '');
  out = out.replace(/<rect\b[^>]*fill:#FFFFFF[^>]*\/>/gi, '');

  const bounds = drawnBounds(out);
  if (!bounds) throw new Error('结构绘制结果为空');
  const box = {
    x: round1(bounds.minX - padding),
    y: round1(bounds.minY - padding),
    w: Math.max(24, Math.ceil(bounds.maxX - bounds.minX + padding * 2)),
    h: Math.max(24, Math.ceil(bounds.maxY - bounds.minY + padding * 2)),
  };

  const open = out.match(/<svg\b[^>]*>/i);
  if (!open) throw new Error('结构绘制结果缺少根元素');
  const inner = out.slice(open.index + open[0].length).replace(/<\/svg>\s*$/i, '');
  const colored = inner.replace(/#000000/gi, BOND);
  let paletteApplied = colored;
  for (const [from, to] of Object.entries(ATOM_PALETTE)) {
    paletteApplied = paletteApplied.replace(new RegExp(from, 'gi'), to);
  }
  return { inner: paletteApplied, box, bondLength: bondLength(out) };
}

/**
 * Bare RDKit SVG for one molecule, plus its chemistry facts.
 * @param {string} vendorDir
 * @param {string} smiles
 * @param {{canvasWidth?: number, canvasHeight?: number}} [options]
 */
async function measureMolecule(vendorDir, smiles, options) {
  const opts = options || {};
  const text = typeof smiles === 'string' ? smiles.trim() : '';
  if (text === '') throw new Error('SMILES 不能为空');
  if (text.includes('>>')) throw new Error('单个结构不支持 ">>"，反应请用 draw_reaction');
  const RDKit = await loadRDKit(vendorDir);
  const width = Number.isFinite(opts.canvasWidth) ? opts.canvasWidth : DEFAULT_CANVAS_W;
  const height = Number.isFinite(opts.canvasHeight) ? opts.canvasHeight : DEFAULT_CANVAS_H;

  let mol = null;
  try {
    mol = RDKit.get_mol(text);
  } catch (err) {
    throw new Error(describeFailure(text, err));
  }
  if (!mol) throw new Error(describeFailure(text, null));
  try {
    try {
      mol.set_new_coords(true);
    } catch (err) {
      /* older builds */
    }
    const cropped = cropSvg(mol.get_svg(width, height), DEFAULT_PADDING);
    let canonicalSmiles;
    try {
      const canonical = mol.get_smiles();
      if (typeof canonical === 'string' && canonical !== '') canonicalSmiles = canonical;
    } catch (err) {
      canonicalSmiles = undefined;
    }
    const calculated = molecularFormula(mol);
    return {
      ...cropped,
      formula: calculated ? calculated.formula : undefined,
      formulaPretty: calculated ? prettyFormula(calculated.formula, calculated.charge) : undefined,
      molecularWeight: molecularWeight(mol),
      canonicalSmiles,
    };
  } finally {
    try {
      mol.delete();
    } catch (err) {
      /* released */
    }
  }
}

/** Escape XML text content. @param {string} value */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Root SVG wrapper with paper background. */
function wrapSvg(inner, box, displayW, displayH) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${displayW}" height="${displayH}"`,
    ` viewBox="${box.x} ${box.y} ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet">`,
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${PAPER}"/>`,
    inner,
    '</svg>',
  ].join('');
}

/**
 * Display size for one structure: requested width, capped by the reader's box.
 * @param {{w: number, h: number}} box
 * @param {number} targetWidth
 */
function displaySize(box, targetWidth) {
  let width = Math.min(MAX_RENDER_W, Math.max(160, targetWidth));
  let height = (width * box.h) / box.w;
  if (height > MAX_RENDER_H) {
    height = MAX_RENDER_H;
    width = (height * box.w) / box.h;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Render one structure as a complete, self-contained SVG file body.
 * @param {string} vendorDir
 * @param {string} smiles
 * @param {{size?: 's'|'m'|'l'}} [options]
 */
async function renderStructure(vendorDir, smiles, options) {
  const opts = options || {};
  const size = opts.size === 's' || opts.size === 'l' ? opts.size : 'm';
  const measured = await measureMolecule(vendorDir, smiles);
  const target = SIZE_WIDTH[size] || SIZE_WIDTH.m;
  const display = displaySize(measured.box, target);
  return {
    svg: wrapSvg(measured.inner, measured.box, display.width, display.height),
    width: display.width,
    height: display.height,
    formula: measured.formula,
    formulaPretty: measured.formulaPretty,
    molecularWeight: measured.molecularWeight,
    canonicalSmiles: measured.canonicalSmiles,
  };
}

/**
 * Compose one reaction equation: reactants + products with plus signs, an
 * arrow and optional conditions above it, all at one bond length.
 * @param {string} vendorDir
 * @param {string} equation - `reactants>>products`, components separated by '.'
 * @param {{conditions?: string, targetBond?: number}} [options]
 */
async function renderReaction(vendorDir, equation, options) {
  const opts = options || {};
  const text = typeof equation === 'string' ? equation.trim() : '';
  if (text === '') throw new Error('反应式不能为空');
  const pieces = text.split('>>');
  if (pieces.length !== 2) throw new Error('反应式需要写成 "反应物 >> 产物" 的形式');
  const split = (side) => side.split('.').map((part) => part.trim()).filter((part) => part !== '');
  const reactants = split(pieces[0]);
  const products = split(pieces[1]);
  if (reactants.length === 0 || products.length === 0) throw new Error('反应物和产物都不能为空');

  const all = [...reactants, ...products];
  const measured = await Promise.all(all.map((smiles) => measureMolecule(vendorDir, smiles, {
    canvasWidth: 520,
    canvasHeight: 400,
  })));

  const targetBond = Number.isFinite(opts.targetBond) ? opts.targetBond : 34;
  for (const part of measured) {
    part.scale = part.bondLength > 0 ? targetBond / part.bondLength : 1;
    part.drawW = part.box.w * part.scale;
    part.drawH = part.box.h * part.scale;
  }

  const conditions = typeof opts.conditions === 'string' ? opts.conditions.trim() : '';
  const GAP = 16;
  const PLUS_W = 30;
  const ARROW_W = 104;
  const PAD = 18;

  const items = [];
  let index = 0;
  reactants.forEach((_, i) => {
    if (i > 0) items.push({ kind: 'plus' });
    items.push({ kind: 'mol', part: measured[index++] });
  });
  items.push({ kind: 'arrow' });
  products.forEach((_, i) => {
    if (i > 0) items.push({ kind: 'plus' });
    items.push({ kind: 'mol', part: measured[index++] });
  });

  const tallest = Math.max(60, ...measured.map((part) => part.drawH));
  const bodyH = conditions === '' ? tallest : Math.max(tallest, 104);
  let x = PAD;
  for (const item of items) {
    if (item.kind === 'mol') {
      item.w = item.part.drawW;
      item.h = item.part.drawH;
      item.x = x;
      x += item.w + GAP;
    } else if (item.kind === 'plus') {
      item.w = PLUS_W;
      item.h = bodyH;
      item.x = x;
      x += item.w + GAP;
    } else {
      item.w = ARROW_W;
      item.h = bodyH;
      item.x = x;
      x += item.w + GAP;
    }
  }

  const totalW = x - GAP + PAD;
  const totalH = bodyH + PAD * 2;
  let scale = Math.min(1, MAX_RENDER_W / totalW, MAX_RENDER_H / totalH);
  const outW = Math.max(120, Math.round(totalW * scale));
  const outH = Math.max(60, Math.round(totalH * scale));

  const mid = PAD + bodyH / 2;
  const ink = `stroke="${INK}" fill="none" stroke-width="2.6" stroke-linecap="round"`;
  const chunks = [`<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="${PAPER}"/>`];

  for (const item of items) {
    if (item.kind === 'mol') {
      const y = PAD + (bodyH - item.h) / 2;
      chunks.push([
        `<svg x="${round1(item.x)}" y="${round1(y)}" width="${round1(item.w)}" height="${round1(item.h)}"`,
        ` viewBox="${item.part.box.x} ${item.part.box.y} ${item.part.box.w} ${item.part.box.h}"`,
        ' preserveAspectRatio="xMidYMid meet">',
        item.part.inner,
        '</svg>',
      ].join(''));
    } else if (item.kind === 'plus') {
      const cx = round1(item.x + item.w / 2);
      chunks.push(`<path d="M ${cx},${round1(mid - 10)} V ${round1(mid + 10)} M ${round1(cx - 10)},${round1(mid)} H ${round1(cx + 10)}" ${ink}/>`);
    } else {
      const startX = round1(item.x);
      const endX = round1(item.x + item.w);
      const head = 15;
      chunks.push(`<path d="M ${startX},${round1(mid)} H ${round1(endX - head)}" ${ink}/>`);
      chunks.push(
        `<path d="M ${endX},${round1(mid)} L ${round1(endX - head)},${round1(mid - 8)} L ${round1(endX - head)},${round1(mid + 8)} Z" fill="${INK}"/>`,
      );
      if (conditions !== '') {
        const cx = round1((startX + endX) / 2);
        chunks.push(
          `<text x="${cx}" y="${round1(mid - 26)}" text-anchor="middle" font-size="18" fill="${INK}"`
          + ` font-family="system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">${escapeXml(conditions)}</text>`,
        );
      }
    }
  }

  return {
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${outW}" height="${outH}"`,
      ` viewBox="0 0 ${totalW} ${totalH}" preserveAspectRatio="xMidYMid meet">`,
      ...chunks,
      '</svg>',
    ].join(''),
    width: outW,
    height: outH,
    reactantCount: reactants.length,
    productCount: products.length,
  };
}

/* ------------------------------------------------------------------ */
/* Files and Markdown                                                  */
/* ------------------------------------------------------------------ */

/**
 * Write one SVG figure into the workspace and return its absolute path.
 * @param {string} directory
 * @param {string} prefix
 * @param {string} svg
 */
async function writeFigure(directory, prefix, svg) {
  const safe = prefix.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'figure';
  const digest = crypto.createHash('sha1').update(svg).digest('hex').slice(0, 16);
  const file = path.join(directory, `${safe}-${digest}.svg`);
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(file, svg, 'utf8');
  } catch (err) {
    throw new Error(`图片写入失败：${err && err.message ? err.message : String(err)}`);
  }
  return file;
}

/**
 * Turn an absolute file path into a Markdown image the assistant body resolves.
 * @param {string} file - absolute path
 * @param {string} alt
 */
function figureMarkdown(file, alt) {
  const posix = file.replace(/\\/g, '/');
  const encoded = encodeURI(posix).replace(/#/g, '%23').replace(/\?/g, '%3F');
  const label = String(alt || '结构图').replace(/[[\]\r\n]/g, ' ').trim() || '结构图';
  return `![${label}](${encoded})`;
}

/** @param {string} text @param {unknown} err */
function describeFailure(text, err) {
  const detail = err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
  const trimmed = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return `无法解析为有效结构：${trimmed}${detail === '' ? '' : `（${detail}）`}`;
}

module.exports = {
  loadRDKit,
  renderStructure,
  renderReaction,
  writeFigure,
  figureMarkdown,
};
