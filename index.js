/**
 * Host half of the chem-structures bundle.
 *
 * Two model-facing tools turn SMILES into picture files inside the Session
 * workspace and hand back a ready-to-paste Markdown image line, so the rendered
 * figure appears in the assistant's answer body instead of inside a tool card.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor');

/** Workspace folder that holds the generated SVG figures. */
const FIGURE_DIRNAME = 'chem-drawings';

const TOOL_STRUCTURE = 'draw_structure';
const TOOL_REACTION = 'draw_reaction';

/** Prompt section placement: after ordinary guidance, before the persona suffix. */
const PROMPT_ORDER = 9850;

export const inject = ['tools', 'systemPrompt', 'workingDirectory'];

/**
 * Absolute directory where this call's figures belong.
 * @param {any} ctx
 * @param {any} exec
 * @returns {Promise<string>}
 */
async function figureDirectory(ctx, exec) {
  let root;
  try {
    root = exec && exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : undefined;
  } catch (err) {
    root = undefined;
  }
  if (typeof root !== 'string' || root === '') root = ctx.workingDirectory.defaultDirectory;
  return path.join(root, FIGURE_DIRNAME);
}

/** One-line human summary used inside the compact tool row. */
function shortSummary(value) {
  const facts = [];
  if (typeof value.formulaPretty === 'string' && value.formulaPretty !== '') facts.push(value.formulaPretty);
  if (typeof value.molecularWeight === 'number') facts.push(`M ${value.molecularWeight}`);
  return facts.join(' · ');
}

export function apply(ctx) {
  const renderer = require('./render.cjs');

  // Compile the WebAssembly module ahead of the first call, without blocking activation.
  ctx.effect(() => {
    const warming = renderer.loadRDKit(VENDOR_DIR);
    if (warming && typeof warming.catch === 'function') warming.catch(() => {});
    return () => {};
  }, 'chem-structures: warm up RDKit');

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_STRUCTURE,
        description:
          'Draw one molecular structure as a picture and return a Markdown image line for the answer body. '
          + 'Use this whenever a specific molecule\'s structure matters; you cannot draw structures as text. '
          + 'After the call, paste the returned `![...](...)` line into your reply on its own line where the figure belongs '
          + '- the reader then sees the structure inside the answer, not in the tool log. '
          + 'Input is one SMILES: lower-case aromatic atoms (c1ccccc1), parentheses for branches, ring-closure digits, '
          + "'@'/'@@' for stereochemistry, brackets for charges/isotopes ([NH4+], [O-]), '.' between disconnected species. "
          + 'Pick `size` to control the picture width: "s" (~300px, simple molecules or several figures), '
          + '"m" (~440px, default), "l" (~620px, crowded skeletons such as steroids or polyenes).',
        parameters: {
          type: 'object',
          properties: {
            smiles: {
              type: 'string',
              description: 'SMILES of exactly one structure, e.g. "CC(=O)Oc1ccccc1C(=O)O" for aspirin.',
            },
            caption: {
              type: 'string',
              description: 'Short name or label in the user\'s language, e.g. "阿司匹林（乙酰水杨酸）"; used for the image alt text and the tool row.',
            },
            size: {
              type: 'string',
              enum: ['s', 'm', 'l'],
              description: 'Picture width class: s (~300px), m (~440px, default), l (~620px).',
            },
          },
          required: ['smiles'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              file: { type: 'string' },
              width: { type: 'number' },
              height: { type: 'number' },
              formula: { type: 'string' },
              formulaPretty: { type: 'string' },
              molecularWeight: { type: 'number' },
              canonicalSmiles: { type: 'string' },
            },
            required: ['markdown', 'file', 'width', 'height'],
            additionalProperties: false,
          },
          render: (args, value) => [{
            type: 'text',
            text: `结构图已生成${args.caption ? `（${args.caption}）` : ''}`
              + `${shortSummary(value) ? `，${shortSummary(value)}` : ''}。\n`
              + '把下面这一行原样插入回答正文中图片应出现的位置（单独一行，不要放进代码块）：\n'
              + value.markdown,
          }],
          presentationMeta: (args, value) => ({
            kind: 'structure',
            caption: typeof args.caption === 'string' ? args.caption : '',
            formulaPretty: value.formulaPretty,
            molecularWeight: value.molecularWeight,
            width: value.width,
            height: value.height,
          }),
        },
        execute: async (args, exec) => {
          if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
          const rendered = await renderer.renderStructure(VENDOR_DIR, args.smiles, { size: args.size });
          const directory = await figureDirectory(ctx, exec);
          const file = await renderer.writeFigure(directory, 'molecule', rendered.svg);
          if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
          const caption = typeof args.caption === 'string' && args.caption.trim() !== '' ? args.caption.trim() : '结构式';
          return {
            markdown: renderer.figureMarkdown(file, caption),
            file,
            width: rendered.width,
            height: rendered.height,
            ...(rendered.formula === undefined ? {} : { formula: rendered.formula }),
            ...(rendered.formulaPretty === undefined ? {} : { formulaPretty: rendered.formulaPretty }),
            ...(rendered.molecularWeight === undefined ? {} : { molecularWeight: rendered.molecularWeight }),
            ...(rendered.canonicalSmiles === undefined ? {} : { canonicalSmiles: rendered.canonicalSmiles }),
          };
        },
      }),
    'chem-structures: draw_structure tool',
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_REACTION,
        description:
          'Draw a complete reaction equation as one picture and return a Markdown image line for the answer body. '
          + 'The scheme lays out reactants, plus signs, an arrow with optional conditions, and products at one uniform bond length. '
          + 'Write `equation` as "reactants>>products" and separate each side\'s components with "." '
          + '(e.g. "CC(=O)O.OCC>>CC(=O)OCC.O"). Put catalysts/temperature/reagents in `conditions`, drawn above the arrow '
          + '(e.g. "H₂SO₄, Δ"; use Unicode subscripts/superscripts). '
          + 'After the call, paste the returned `![...](...)` line into your reply on its own line.',
        parameters: {
          type: 'object',
          properties: {
            equation: {
              type: 'string',
              description: 'Reaction SMILES, "reactants>>products", components separated by ".".',
            },
            conditions: {
              type: 'string',
              description: 'Text drawn above the arrow, e.g. "H⁺, Δ" or "H₂SO₄, 加热".',
            },
            caption: {
              type: 'string',
              description: 'Short label in the user\'s language for the alt text and the tool row.',
            },
          },
          required: ['equation'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              file: { type: 'string' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['markdown', 'file', 'width', 'height'],
            additionalProperties: false,
          },
          render: (args, value) => [{
            type: 'text',
            text: `反应方程式图已生成（${value.width}×${value.height}px）。\n`
              + '把下面这一行原样插入回答正文中方程式应出现的位置（单独一行，不要放进代码块）：\n'
              + value.markdown,
          }],
          presentationMeta: (args, value) => ({
            kind: 'reaction',
            caption: typeof args.caption === 'string' ? args.caption : '',
            conditions: typeof args.conditions === 'string' ? args.conditions : '',
            width: value.width,
            height: value.height,
          }),
        },
        execute: async (args, exec) => {
          if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
          const rendered = await renderer.renderReaction(VENDOR_DIR, args.equation, { conditions: args.conditions });
          const directory = await figureDirectory(ctx, exec);
          const file = await renderer.writeFigure(directory, 'reaction', rendered.svg);
          if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
          const caption = typeof args.caption === 'string' && args.caption.trim() !== '' ? args.caption.trim() : '反应方程式';
          return {
            markdown: renderer.figureMarkdown(file, caption),
            file,
            width: rendered.width,
            height: rendered.height,
          };
        },
      }),
    'chem-structures: draw_reaction tool',
  );

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'plugin:chem-structures',
        order: PROMPT_ORDER,
        text:
          'Chemical structures belong in the answer body: when a specific molecule matters, call `draw_structure`; when a '
          + 'transformation matters, call `draw_reaction` (reactants>>products, conditions above the arrow). '
          + 'Both tools write a picture file and return one Markdown image line - copy that line into your reply on its own '
          + 'line at the exact place the figure should appear, then keep explaining around it ("如上图") instead of '
          + 'repeating bond geometry in prose. Never leave the figure only inside the tool call, never wrap the image line '
          + 'in a code block, and never print the file path as text. Choose size "s" for small inline figures, "m" by '
          + 'default, "l" for crowded skeletons. Convert compound names to SMILES yourself; draw one molecule per call.',
      }),
    'chem-structures: prompt section',
  );
}
