'use strict';

// Render SMILES structures, stereochemical annotations, electron-pushing
// mechanism schemes and whole reaction equations into standalone SVG files.
// Pure Node (no DOM); the only chemistry engine is the vendored RDKit wasm.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PAPER = '#FFFFFF';
const BOND = '#111827';
const STEREO_INK = '#111827';
const ARROW_INK = '#1D4ED8';
const NUMBER_INK = '#9CA3AF';

const DEFAULT_CANVAS_W = 620;
const DEFAULT_CANVAS_H = 460;
const DEFAULT_PADDING = 16;

const SIZE_WIDTH = { s: 300, m: 440, l: 620 };
const MAX_RENDER_W = 640;
const MAX_RENDER_H = 340;

const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";

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

/* ------------------------------------------------------------------ */
/* Chemistry facts                                                     */
/* ------------------------------------------------------------------ */

/** @param {string} vendorDir */
function loadRDKit(vendorDir) {
  if (rdkitPromise) return rdkitPromise;
  const factory = require(path.join(vendorDir, 'RDKit_minimal.js'));
  rdkitPromise = Promise.resolve(factory());
  return rdkitPromise;
}

/** Parse atom coordinates, charges and bonds out of a V2000 molblock. */
function parseMolblockGeometry(molblock) {
  const lines = String(molblock).split('\n');
  const counts = lines[3] || '';
  const nAtoms = Number.parseInt(counts.slice(0, 3), 10);
  const nBonds = Number.parseInt(counts.slice(3, 6), 10);
  const atoms = [];
  for (let i = 0; i < nAtoms; i += 1) {
    const line = lines[4 + i] || '';
    atoms.push({
      x: parseFloat(line.slice(0, 10)) || 0,
      y: parseFloat(line.slice(10, 20)) || 0,
      element: line.slice(31, 34).trim() || 'C',
    });
  }
  const charges = new Map();
  for (const line of lines) {
    if (!line.startsWith('M  CHG')) continue;
    const fields = line.trim().split(/\s+/);
    const pairs = Number.parseInt(fields[2], 10);
    if (!Number.isFinite(pairs)) continue;
    for (let i = 0; i < pairs; i += 1) {
      const idx = Number.parseInt(fields[3 + i * 2], 10) - 1;
      const value = Number.parseInt(fields[4 + i * 2], 10);
      if (Number.isFinite(idx) && Number.isFinite(value)) charges.set(idx, value);
    }
  }
  const bonds = [];
  for (let i = 0; i < nBonds; i += 1) {
    const line = lines[4 + nAtoms + i] || '';
    bonds.push({
      a: Number.parseInt(line.slice(0, 3), 10) - 1,
      b: Number.parseInt(line.slice(3, 6), 10) - 1,
      order: Number.parseInt(line.slice(6, 9), 10) || 1,
      stereo: Number.parseInt(line.slice(9, 12), 10) || 0,
    });
  }
  for (const [idx, value] of charges) if (atoms[idx]) atoms[idx].charge = value;
  return { atoms, bonds };
}

/** Atom symbols and total charge from a molblock (used for formulas). */
function parseMolblockAtoms(molblock) {
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

/** Hill-order formula from atom symbols. */
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

/** Molecular formula including implicit hydrogens. */
function molecularFormula(mol) {
  let withHydrogens = null;
  try {
    withHydrogens = mol.add_hs();
  } catch (err) {
    return null;
  }
  if (typeof withHydrogens !== 'string' || withHydrogens === '') return null;
  const parsed = parseMolblockAtoms(withHydrogens);
  if (parsed.symbols.length === 0) return null;
  return { formula: hillFormula(parsed.symbols), charge: parsed.charge };
}

/** Pretty formula with Unicode subscripts and charge superscript. */
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

/** Average molecular weight from RDKit descriptors. */
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

/** CIP stereo descriptors: atoms as [index, "(R)"], bonds as [a, b, "(E)"]. */
function readStereo(mol) {
  let parsed = null;
  try {
    parsed = JSON.parse(mol.get_stereo_tags());
  } catch (err) {
    return { atoms: [], bonds: [] };
  }
  return {
    atoms: Array.isArray(parsed && parsed.CIP_atoms) ? parsed.CIP_atoms : [],
    bonds: Array.isArray(parsed && parsed.CIP_bonds) ? parsed.CIP_bonds : [],
  };
}

/* ------------------------------------------------------------------ */
/* SVG geometry                                                        */
/* ------------------------------------------------------------------ */

/** Bounding box of every drawn path coordinate. */
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

/** Median straight-line bond length, used to normalise panel scales. */
function bondLengthOf(svg) {
  const lengths = [];
  const re = /<path\b[^>]*class='bond[^']*'[^>]*\bd='M\s*([-\d.]+),([-\d.]+)\s*L\s*([-\d.]+),([-\d.]+)'/g;
  let match;
  while ((match = re.exec(svg)) !== null) {
    const len = Math.hypot(Number(match[3]) - Number(match[1]), Number(match[4]) - Number(match[2]));
    if (Number.isFinite(len) && len > 0) lengths.push(len);
  }
  if (lengths.length === 0) return 0;
  lengths.sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)];
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Crop to the drawing, drop the white plate, and normalise ink colours. */
function cropSvg(svg, padding) {
  let out = String(svg).replace(/<\?xml[^>]*\?>\s*/i, '');
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
  let inner = out.slice(open.index + open[0].length).replace(/<\/svg>\s*$/i, '');
  inner = inner.replace(/#000000/gi, BOND);
  for (const [from, to] of Object.entries(ATOM_PALETTE)) inner = inner.replace(new RegExp(from, 'gi'), to);
  return { inner, box, bondLength: bondLengthOf(out) };
}

/** Coordinate pairs inside an SVG path `d` attribute. */
function pointsOfPath(d) {
  return [...String(d).matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)].map((p) => ({ x: Number(p[1]), y: Number(p[2]) }));
}

/** Bond paths grouped by bond index, tagged with their two atom indices. */
function parseSvgBonds(svg) {
  const groups = new Map();
  const re = /<path\b[^>]*class='([^']*)'[^>]*\bd='([^']*)'/g;
  let match;
  while ((match = re.exec(svg)) !== null) {
    const hit = /bond-(\d+)\s+atom-(\d+)\s+atom-(\d+)/.exec(match[1]);
    if (!hit) continue;
    const pts = pointsOfPath(match[2]);
    if (pts.length < 2) continue;
    const key = Number(hit[1]);
    if (!groups.has(key)) groups.set(key, { atoms: [Number(hit[2]), Number(hit[3])], paths: [] });
    groups.get(key).paths.push(pts);
  }
  return groups;
}

/**
 * Correspondences between molblock coordinates and SVG coordinates. Only
 * single-segment bonds and wedge triangles are exact: RDKit splits coloured
 * bonds into halves and shortens them at atom labels.
 */
function exactPairs(geo, groups) {
  const pairs = [];
  for (const [, group] of groups) {
    const a = geo.atoms[group.atoms[0]];
    const b = geo.atoms[group.atoms[1]];
    if (!a || !b) continue;
    if (group.paths.length !== 1) continue;
    const pts = group.paths[0];
    pairs.push({ ux: a.x, uy: a.y, X: pts[0].x, Y: pts[0].y });
    if (pts.length === 2) {
      pairs.push({ ux: b.x, uy: b.y, X: pts[1].x, Y: pts[1].y });
    } else {
      const base = { x: (pts[pts.length - 2].x + pts[pts.length - 1].x) / 2, y: (pts[pts.length - 2].y + pts[pts.length - 1].y) / 2 };
      pairs.push({ ux: b.x, uy: b.y, X: base.x, Y: base.y });
    }
  }
  return pairs;
}

/** Least squares for: s*ux + tx = X ; -s*uy + ty = Y (Gaussian elimination). */
function solveTransform(pairs) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const p of pairs) {
    for (const row of [[p.ux, 1, 0, p.X], [-p.uy, 0, 1, p.Y]]) {
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) A[i][j] += row[i] * row[j];
        b[i] += row[i] * row[3];
      }
    }
  }
  const M = [A[0].slice(), A[1].slice(), A[2].slice()];
  const v = b.slice();
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 3; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      const t = M[pivot]; M[pivot] = M[col]; M[col] = t;
      const tv = v[pivot]; v[pivot] = v[col]; v[col] = tv;
    }
    for (let r = col + 1; r < 3; r += 1) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 3; c += 1) M[r][c] -= f * M[col][c];
      v[r] -= f * v[col];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r -= 1) {
    let sum = v[r];
    for (let c = r + 1; c < 3; c += 1) sum -= M[r][c] * x[c];
    x[r] = sum / M[r][r];
  }
  return { s: x[0], tx: x[1], ty: x[2] };
}

function makeTransform(fit) {
  if (!fit) return null;
  if (!(fit.s > 5 && fit.s < 8000)) return null;
  return {
    ...fit,
    apply(atom) {
      return { x: fit.s * atom.x + fit.tx, y: -fit.s * atom.y + fit.ty };
    },
  };
}

/** Recover the affine map from molblock space to the SVG drawing. */
function fitTransform(geo, groups) {
  const pairs = exactPairs(geo, groups);
  const distinct = new Set(pairs.map((p) => `${p.ux.toFixed(2)},${p.uy.toFixed(2)}`));
  if (pairs.length < 2 || distinct.size < 2) return null;
  let fit = makeTransform(solveTransform(pairs));
  if (!fit) return null;
  const residual = (p) => {
    const px = fit.s * p.ux + fit.tx;
    const py = -fit.s * p.uy + fit.ty;
    return Math.hypot(px - p.X, py - p.Y);
  };
  if (Math.max(...pairs.map(residual)) > 1.5) {
    const kept = pairs.filter((p) => residual(p) <= 1.5);
    const keptDistinct = new Set(kept.map((p) => `${p.ux.toFixed(2)},${p.uy.toFixed(2)}`));
    if (kept.length >= 2 && keptDistinct.size >= 2) {
      const refit = makeTransform(solveTransform(kept));
      if (refit) fit = refit;
    }
  }
  return fit;
}

/* ------------------------------------------------------------------ */
/* Molecule analysis                                                   */
/* ------------------------------------------------------------------ */

/** Render one molecule and recover its atom drawing positions. */
async function analyzeMolecule(vendorDir, smiles, options) {
  const opts = options || {};
  const text = typeof smiles === 'string' ? smiles.trim() : '';
  if (text === '') throw new Error('SMILES 不能为空');
  if (text.includes('>>')) throw new Error('单个结构不支持 ">>"，反应请用 draw_reaction');
  const RDKit = await loadRDKit(vendorDir);
  const canvasW = Number.isFinite(opts.canvasWidth) ? opts.canvasWidth : DEFAULT_CANVAS_W;
  const canvasH = Number.isFinite(opts.canvasHeight) ? opts.canvasHeight : DEFAULT_CANVAS_H;

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
    const molblock = mol.get_molblock();
    const geo = parseMolblockGeometry(molblock);
    const raw = mol.get_svg(canvasW, canvasH);
    const cropped = cropSvg(raw, DEFAULT_PADDING);
    const groups = parseSvgBonds(raw);
    const transform = fitTransform(geo, groups);
    const atomXY = geo.atoms.map((atom) => (transform ? transform.apply(atom) : null));

    let canonicalSmiles;
    try {
      const canonical = mol.get_smiles();
      if (typeof canonical === 'string' && canonical !== '') canonicalSmiles = canonical;
    } catch (err) {
      canonicalSmiles = undefined;
    }
    const calculated = molecularFormula(mol);
    return {
      inner: cropped.inner,
      box: cropped.box,
      bondLength: cropped.bondLength,
      geo,
      atomXY,
      transformOk: transform !== null,
      stereo: readStereo(mol),
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

/* ------------------------------------------------------------------ */
/* Overlay elements (labels, arrows)                                   */
/* ------------------------------------------------------------------ */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One text label plus an approximate bounding box. */
function textLabel(spec) {
  const anchor = spec.anchor || 'middle';
  const width = spec.text.length * spec.size * 0.62;
  const x0 = anchor === 'middle' ? spec.x - width / 2 : anchor === 'end' ? spec.x - width : spec.x;
  const markup = `<text x="${round1(spec.x)}" y="${round1(spec.y)}" text-anchor="${anchor}"`
    + ` font-size="${spec.size}" fill="${spec.fill}" font-family="${FONT_STACK}">${escapeXml(spec.text)}</text>`;
  return { markup, bounds: [{ x: x0, y: spec.y - spec.size }, { x: x0 + width, y: spec.y + spec.size * 0.3 }] };
}

function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function expandBox(box, points) {
  if (points.length === 0) return box;
  const b = boundsOf(points);
  const minX = Math.min(box.x, b.minX);
  const minY = Math.min(box.y, b.minY);
  const maxX = Math.max(box.x + box.w, b.maxX);
  const maxY = Math.max(box.y + box.h, b.maxY);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function centroidOf(atomXY) {
  const known = atomXY.filter(Boolean);
  if (known.length === 0) return { x: 0, y: 0 };
  return {
    x: known.reduce((sum, p) => sum + p.x, 0) / known.length,
    y: known.reduce((sum, p) => sum + p.y, 0) / known.length,
  };
}

/**
 * Space-filling direction for a label: the bisector of the largest angular gap
 * between an atom's bonds (gapIndex 0 = widest gap, 1 = second widest).
 */
function labelDirection(analysis, atomIndex, gapIndex) {
  const p = analysis.atomXY[atomIndex];
  if (!p) return { x: 0, y: -1 };
  const angles = [];
  for (const bond of analysis.geo.bonds) {
    const other = bond.a === atomIndex ? bond.b : bond.b === atomIndex ? bond.a : -1;
    const q = other >= 0 ? analysis.atomXY[other] : null;
    if (!q) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    if (Math.hypot(dx, dy) < 1e-6) continue;
    angles.push(Math.atan2(dy, dx));
  }
  if (angles.length === 0) {
    const c = centroidOf(analysis.atomXY);
    return unitVector(p.x - c.x, p.y - c.y);
  }
  if (angles.length === 1) return unitVector(-Math.cos(angles[0]), -Math.sin(angles[0]));
  angles.sort((l, r) => l - r);
  const gaps = [];
  for (let i = 0; i < angles.length; i += 1) {
    const from = angles[i];
    const to = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
    gaps.push({ from, size: to - from });
  }
  gaps.sort((l, r) => r.size - l.size);
  const gap = gaps[Math.min(gapIndex, gaps.length - 1)];
  const mid = gap.from + gap.size / 2;
  return unitVector(Math.cos(mid), Math.sin(mid));
}

function unitVector(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: -1 };
  return { x: dx / len, y: dy / len };
}

/** Unit vector pointing from an atom away from its neighbours. */
function outwardDirection(analysis, atomIndex) {
  const p = analysis.atomXY[atomIndex];
  if (!p) return { x: 0, y: -1 };
  const neighbours = [];
  for (const bond of analysis.geo.bonds) {
    const other = bond.a === atomIndex ? bond.b : bond.b === atomIndex ? bond.a : -1;
    const q = other >= 0 ? analysis.atomXY[other] : null;
    if (q) neighbours.push(q);
  }
  let dx = 0;
  let dy = 0;
  if (neighbours.length === 0) {
    const c = centroidOf(analysis.atomXY);
    dx = p.x - c.x;
    dy = p.y - c.y;
  } else {
    for (const q of neighbours) {
      dx += p.x - q.x;
      dy += p.y - q.y;
    }
    dx /= neighbours.length;
    dy /= neighbours.length;
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: -1 };
  return { x: dx / len, y: dy / len };
}

/** 1-based atom numbers (SMILES order) drawn next to each atom. */
function numberingElements(analysis) {
  const elements = [];
  analysis.atomXY.forEach((p, index) => {
    if (!p) return;
    const hasStereo = analysis.stereo.atoms.some(([idx]) => idx === index);
    const dir = labelDirection(analysis, index, hasStereo ? 1 : 0);
    const distance = hasStereo ? 34 : 24;
    elements.push(textLabel({
      x: p.x + dir.x * distance,
      y: p.y + dir.y * distance + 5,
      text: String(index + 1),
      size: 13,
      fill: NUMBER_INK,
    }));
  });
  return elements;
}

/** R/S and E/Z annotations from RDKit CIP tags. */
function stereoElements(analysis) {
  const elements = [];
  for (const entry of analysis.stereo.atoms) {
    const index = entry[0];
    const label = entry[1];
    const p = analysis.atomXY[index];
    if (!p || typeof label !== 'string') continue;
    const dir = labelDirection(analysis, index, 0);
    elements.push(textLabel({ x: p.x + dir.x * 30, y: p.y + dir.y * 30 + 6, text: label, size: 18, fill: STEREO_INK }));
  }
  const centroid = centroidOf(analysis.atomXY);
  for (const entry of analysis.stereo.bonds) {
    const ia = entry[0];
    const ib = entry[1];
    const label = entry[2];
    const pa = analysis.atomXY[ia];
    const pb = analysis.atomXY[ib];
    if (!pa || !pb || typeof label !== 'string') continue;
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    let nx = -(pb.y - pa.y);
    let ny = pb.x - pa.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * (mid.x - centroid.x) + ny * (mid.y - centroid.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    elements.push(textLabel({ x: mid.x + nx * 24, y: mid.y + ny * 24 + 6, text: label, size: 17, fill: STEREO_INK }));
  }
  return elements;
}

/** Parse "3" / "bond:3,4" / "H:3" into an anchor descriptor (0-based). */
function parseAnchorSpec(spec) {
  const text = typeof spec === 'number' ? String(spec) : String(spec == null ? '' : spec).trim();
  const bond = /^bond\s*[:([]\s*(\d+)\s*[,:-]\s*(\d+)\s*[)\]]?$/i.exec(text);
  if (bond) return { kind: 'bond', a: Number(bond[1]) - 1, b: Number(bond[2]) - 1 };
  const hydrogen = /^h\s*[:：]\s*(\d+)$/i.exec(text);
  if (hydrogen) return { kind: 'hydrogen', index: Number(hydrogen[1]) - 1 };
  const atom = /^(\d+)$/.exec(text);
  if (atom) return { kind: 'atom', index: Number(atom[1]) - 1 };
  throw new Error(`无法识别的箭头端点 "${spec}"：请写原子编号（如 "3"）、键（如 "bond:3,4"）或氢（如 "H:3"）`);
}

/** Resolve an anchor to a drawing point. */
function anchorPoint(analysis, anchor, side) {
  const centroid = centroidOf(analysis.atomXY);
  if (anchor.kind === 'atom' || anchor.kind === 'hydrogen') {
    const p = analysis.atomXY[anchor.index];
    if (!p) throw new Error(`原子 ${anchor.index + 1} 无法定位（该结构缺少可用的单键参照）`);
    if (anchor.kind === 'hydrogen') {
      // RDKit drops implicit hydrogens from the depiction; approximate the
      // hydrogen position by stepping outward from its heavy atom.
      const dir = outwardDirection(analysis, anchor.index);
      const distance = 26;
      return { point: { x: p.x + dir.x * distance, y: p.y + dir.y * distance }, hydrogen: true };
    }
    return { point: p, atom: anchor.index };
  }
  const exists = analysis.geo.bonds.some((bond) => (bond.a === anchor.a && bond.b === anchor.b) || (bond.a === anchor.b && bond.b === anchor.a));
  if (!exists) throw new Error(`结构中没有 ${anchor.a + 1}-${anchor.b + 1} 这根键`);
  const pa = analysis.atomXY[anchor.a];
  const pb = analysis.atomXY[anchor.b];
  if (!pa || !pb) throw new Error(`键 ${anchor.a + 1}-${anchor.b + 1} 无法定位`);
  const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  let nx = -(pb.y - pa.y);
  let ny = pb.x - pa.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  const away = nx * (mid.x - centroid.x) + ny * (mid.y - centroid.y) < 0 ? -1 : 1;
  const offset = side === 'start' ? 11 : 7;
  return { point: { x: mid.x + nx * away * offset, y: mid.y + ny * away * offset }, bond: true };
}

/** Curved electron-pair arrow between two anchors. */
function arrowElement(analysis, spec) {
  const from = anchorPoint(analysis, parseAnchorSpec(spec.from), 'start');
  const to = anchorPoint(analysis, parseAnchorSpec(spec.to), 'end');
  const centroid = centroidOf(analysis.atomXY);

  const dx = to.point.x - from.point.x;
  const dy = to.point.y - from.point.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 26) throw new Error('箭头两端太近，无法绘制：请选择相距更远的原子或键');
  const ux = dx / chord;
  const uy = dy / chord;

  const elementAt = (anchor) => (typeof anchor.index === 'number' && analysis.geo.atoms[anchor.index]
    ? analysis.geo.atoms[anchor.index].element
    : undefined);
  const labelled = (element) => element !== undefined && element !== 'C';
  const startGap = from.bond || from.hydrogen ? 0 : labelled(elementAt(from)) ? 21 : 13;
  const endGap = to.bond || to.hydrogen ? 0 : labelled(elementAt(to)) ? 23 : 14;
  const p0 = { x: from.point.x + ux * startGap, y: from.point.y + uy * startGap };
  const p3 = { x: to.point.x - ux * endGap, y: to.point.y - uy * endGap };

  let nx = -(p3.y - p0.y);
  let ny = p3.x - p0.x;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  const mid = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
  if (nx * (mid.x - centroid.x) + ny * (mid.y - centroid.y) < 0) {
    nx = -nx;
    ny = -ny;
  }
  const bend = Math.min(72, Math.max(24, len * 0.18));
  const c1 = { x: p0.x + (p3.x - p0.x) * 0.28 + nx * bend, y: p0.y + (p3.y - p0.y) * 0.28 + ny * bend };
  const c2 = { x: p0.x + (p3.x - p0.x) * 0.72 + nx * bend, y: p0.y + (p3.y - p0.y) * 0.72 + ny * bend };

  const headLen = 13;
  const headHalf = 5.5;
  const tip = p3;
  let hx = tip.x - c2.x;
  let hy = tip.y - c2.y;
  const hLen = Math.hypot(hx, hy) || 1;
  hx /= hLen;
  hy /= hLen;
  const base = { x: tip.x - hx * headLen, y: tip.y - hy * headLen };
  const perp = { x: -hy, y: hx };
  const left = { x: base.x + perp.x * headHalf, y: base.y + perp.y * headHalf };
  const right = { x: base.x - perp.x * headHalf, y: base.y - perp.y * headHalf };

  let markup = `<path d="M ${round1(p0.x)},${round1(p0.y)} C ${round1(c1.x)},${round1(c1.y)}`
    + ` ${round1(c2.x)},${round1(c2.y)} ${round1(base.x)},${round1(base.y)}"`
    + ` fill="none" stroke="${ARROW_INK}" stroke-width="2.4" stroke-linecap="round"/>`
    + `<path d="M ${round1(tip.x)},${round1(tip.y)} L ${round1(left.x)},${round1(left.y)} L ${round1(right.x)},${round1(right.y)} Z" fill="${ARROW_INK}"/>`;

  const bounds = [p0, c1, c2, tip, left, right];
  if (typeof spec.label === 'string' && spec.label.trim() !== '') {
    const labelPoint = { x: mid.x + nx * (bend + 16), y: mid.y + ny * (bend + 16) };
    const label = textLabel({ x: labelPoint.x, y: labelPoint.y, text: spec.label.trim(), size: 15, fill: ARROW_INK });
    markup += label.markup;
    for (const point of label.bounds) bounds.push(point);
  }
  return { markup, bounds };
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

function wrapSvg(inner, box, w, h) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${w}" height="${h}"`,
    ` viewBox="${round1(box.x)} ${round1(box.y)} ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet">`,
    `<rect x="${round1(box.x)}" y="${round1(box.y)}" width="${box.w}" height="${box.h}" fill="${PAPER}"/>`,
    inner,
    '</svg>',
  ].join('');
}

function displaySize(box, targetWidth) {
  let width = Math.min(MAX_RENDER_W, Math.max(160, targetWidth));
  let height = (width * box.h) / box.w;
  if (height > MAX_RENDER_H) {
    height = MAX_RENDER_H;
    width = (height * box.w) / box.h;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** Render one structure as a complete, self-contained SVG. */
async function renderStructure(vendorDir, smiles, options) {
  const opts = options || {};
  const size = opts.size === 's' || opts.size === 'l' ? opts.size : 'm';
  const analysis = await analyzeMolecule(vendorDir, smiles);
  const overlay = [];
  if (opts.numbered === true) overlay.push(...numberingElements(analysis));
  if (opts.stereo === true) overlay.push(...stereoElements(analysis));

  let box = analysis.box;
  for (const element of overlay) box = expandBox(box, element.bounds);
  const display = displaySize(box, SIZE_WIDTH[size] || SIZE_WIDTH.m);
  return {
    svg: wrapSvg(analysis.inner + overlay.map((e) => e.markup).join(''), box, display.width, display.height),
    width: display.width,
    height: display.height,
    formula: analysis.formula,
    formulaPretty: analysis.formulaPretty,
    molecularWeight: analysis.molecularWeight,
    canonicalSmiles: analysis.canonicalSmiles,
    stereoAtoms: analysis.stereo.atoms.map(([index, label]) => ({ atom: index + 1, label })),
    stereoBonds: analysis.stereo.bonds.map(([a, b, label]) => ({ atoms: [a + 1, b + 1], label })),
    stereoUsable: analysis.transformOk,
  };
}

/** Render an electron-pushing mechanism scheme (1-3 panels). */
async function renderMechanism(vendorDir, panels, options) {
  const opts = options || {};
  if (!Array.isArray(panels) || panels.length === 0) throw new Error('至少需要一个反应步骤（panels）');
  if (panels.length > 3) throw new Error('一条机理图最多 3 个步骤；更长的机理请分多次调用');
  const analysed = [];
  for (const panel of panels) {
    const analysis = await analyzeMolecule(vendorDir, panel.smiles, { canvasWidth: 520, canvasHeight: 420 });
    const overlay = [];
    if (opts.numbered === true) overlay.push(...numberingElements(analysis));
    const arrowSummaries = [];
    for (const spec of panel.arrows || []) {
      if (!analysis.transformOk) {
        throw new Error('该步骤结构无法定位原子坐标（缺少可作为参照的单键）；请把试剂与底物写在同一条 SMILES 中');
      }
      const element = arrowElement(analysis, spec);
      overlay.push(element);
      arrowSummaries.push(`${describeAnchor(analysis, parseAnchorSpec(spec.from))} → ${describeAnchor(analysis, parseAnchorSpec(spec.to))}`);
    }
    let box = analysis.box;
    for (const element of overlay) box = expandBox(box, element.bounds || []);
    analysed.push({
      analysis,
      overlay,
      box,
      arrows: arrowSummaries,
      caption: typeof panel.caption === 'string' ? panel.caption.trim() : '',
    });
  }

  if (analysed.length === 1) {
    const only = analysed[0];
    const display = displaySize(only.box, SIZE_WIDTH.m);
    return {
      svg: wrapSvg(only.analysis.inner + only.overlay.map((e) => e.markup).join(''), only.box, display.width, display.height),
      width: display.width,
      height: display.height,
      steps: 1,
      arrows: only.arrows,
      captions: only.caption ? [only.caption] : [],
    };
  }

  const targetBond = Number.isFinite(opts.targetBond) ? opts.targetBond : 30;
  for (const entry of analysed) {
    entry.scale = entry.analysis.bondLength > 0 ? targetBond / entry.analysis.bondLength : 1;
    entry.drawW = entry.box.w * entry.scale;
    entry.drawH = entry.box.h * entry.scale;
  }

  const PAD = 20;
  const GAP = 16;
  const ARROW_W = 66;
  const CAPTION_SIZE = 14;
  const CAPTION_H = analysed.some((entry) => entry.caption !== '') ? 26 : 0;
  const textWidth = (text) => [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) >= 0x2e80 ? CAPTION_SIZE : CAPTION_SIZE * 0.58), 0);
  const bodyH = Math.max(...analysed.map((entry) => entry.drawH));

  let cursor = PAD;
  for (let i = 0; i < analysed.length; i += 1) {
    if (i > 0) cursor += GAP + ARROW_W + GAP;
    analysed[i].x = cursor;
    analysed[i].y = PAD + (bodyH - analysed[i].drawH) / 2;
    cursor += analysed[i].drawW;
  }
  // Captions are centred under their panel and may be wider than it: expand the
  // canvas horizontally instead of letting them clip.
  let shiftLeft = 0;
  let extraRight = 0;
  for (const entry of analysed) {
    if (entry.caption === '') continue;
    const half = textWidth(entry.caption) / 2;
    const center = entry.x + entry.drawW / 2;
    shiftLeft = Math.max(shiftLeft, PAD * 0.5 - (center - half));
    extraRight = Math.max(extraRight, center + half - (cursor + PAD * 0.5));
  }
  const totalW = cursor + PAD + shiftLeft + extraRight;
  const totalH = bodyH + PAD * 2 + CAPTION_H;
  const scale = Math.min(1, MAX_RENDER_W / totalW, MAX_RENDER_H / totalH);
  const outW = Math.max(160, Math.round(totalW * scale));
  const outH = Math.max(80, Math.round(totalH * scale));
  const midY = PAD + bodyH / 2;

  const chunks = [`<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="${PAPER}"/>`];
  if (shiftLeft > 0) chunks.push(`<g transform="translate(${round1(shiftLeft)},0)">`);
  for (let i = 0; i < analysed.length; i += 1) {
    const entry = analysed[i];
    chunks.push([
      `<svg x="${round1(entry.x)}" y="${round1(entry.y)}" width="${round1(entry.drawW)}" height="${round1(entry.drawH)}"`,
      ` viewBox="${round1(entry.box.x)} ${round1(entry.box.y)} ${entry.box.w} ${entry.box.h}"`,
      ' preserveAspectRatio="xMidYMid meet">',
      entry.analysis.inner,
      entry.overlay.map((e) => e.markup).join(''),
      '</svg>',
    ].join(''));
    if (entry.caption !== '') {
      chunks.push(`<text x="${round1(entry.x + entry.drawW / 2)}" y="${round1(PAD + bodyH + 20)}" text-anchor="middle" fill="${BOND}" font-size="${CAPTION_SIZE}" font-family="${FONT_STACK}">${escapeXml(entry.caption)}</text>`);
    }
    if (i < analysed.length - 1) {
      const startX = round1(entry.x + entry.drawW + GAP);
      const endX = round1(entry.x + entry.drawW + GAP + ARROW_W);
      chunks.push(`<path d="M ${startX},${round1(midY)} H ${endX - 12}" stroke="${ARROW_INK}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`);
      chunks.push(`<path d="M ${endX},${round1(midY)} L ${endX - 13},${round1(midY - 8)} L ${endX - 13},${round1(midY + 8)} Z" fill="${ARROW_INK}"/>`);
    }
  }

  return {
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${outW}" height="${outH}"`,
      ` viewBox="0 0 ${round1(totalW)} ${round1(totalH)}" preserveAspectRatio="xMidYMid meet">`,
      ...chunks,
      shiftLeft > 0 ? '</g>' : '',
      '</svg>',
    ].join(''),
    width: outW,
    height: outH,
    steps: analysed.length,
    arrows: analysed.flatMap((entry) => entry.arrows),
    captions: analysed.map((entry) => entry.caption).filter((caption) => caption !== ''),
  };
}

/** Text description of one arrow endpoint, for model-facing confirmation. */
function describeAnchor(analysis, anchor) {
  if (anchor.kind === 'atom') {
    const atom = analysis.geo.atoms[anchor.index] || { element: '?' };
    return `${atom.element}(${anchor.index + 1})`;
  }
  if (anchor.kind === 'hydrogen') {
    const atom = analysis.geo.atoms[anchor.index] || { element: '?' };
    return `${atom.element}${anchor.index + 1} 上的 H`;
  }
  return `键${anchor.a + 1}-${anchor.b + 1}`;
}

/** Compose one reaction equation. */
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
  const measured = await Promise.all(all.map(async (smiles) => {
    const analysis = await analyzeMolecule(vendorDir, smiles, { canvasWidth: 520, canvasHeight: 400 });
    return { ...analysis, drawW: 0, drawH: 0, scale: 1 };
  }));

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
  const scale = Math.min(1, MAX_RENDER_W / totalW, MAX_RENDER_H / totalH);
  const outW = Math.max(120, Math.round(totalW * scale));
  const outH = Math.max(60, Math.round(totalH * scale));
  const mid = PAD + bodyH / 2;
  const ink = `stroke="${BOND}" fill="none" stroke-width="2.6" stroke-linecap="round"`;
  const chunks = [`<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="${PAPER}"/>`];

  for (const item of items) {
    if (item.kind === 'mol') {
      const y = PAD + (bodyH - item.h) / 2;
      chunks.push([
        `<svg x="${round1(item.x)}" y="${round1(y)}" width="${round1(item.w)}" height="${round1(item.h)}"`,
        ` viewBox="${round1(item.part.box.x)} ${round1(item.part.box.y)} ${item.part.box.w} ${item.part.box.h}"`,
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
      chunks.push(`<path d="M ${endX},${round1(mid)} L ${round1(endX - head)},${round1(mid - 8)} L ${round1(endX - head)},${round1(mid + 8)} Z" fill="${BOND}"/>`);
      if (conditions !== '') {
        const cx = round1((startX + endX) / 2);
        chunks.push(`<text x="${cx}" y="${round1(mid - 26)}" text-anchor="middle" font-size="18" fill="${BOND}" font-family="${FONT_STACK}">${escapeXml(conditions)}</text>`);
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

/** Write one SVG figure into the workspace and return its absolute path. */
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

/** Turn an absolute path into a Markdown image the answer body resolves. */
function figureMarkdown(file, alt) {
  const posix = file.replace(/\\/g, '/');
  const encoded = encodeURI(posix).replace(/#/g, '%23').replace(/\?/g, '%3F');
  const label = String(alt || '结构图').replace(/[[\]\r\n]/g, ' ').trim() || '结构图';
  return `![${label}](${encoded})`;
}

function describeFailure(text, err) {
  const detail = err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
  const trimmed = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return `无法解析为有效结构：${trimmed}${detail === '' ? '' : `（${detail}）`}`;
}

module.exports = {
  loadRDKit,
  renderStructure,
  renderReaction,
  renderMechanism,
  writeFigure,
  figureMarkdown,
};
