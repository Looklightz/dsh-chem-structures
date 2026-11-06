/**
 * Host half of the chem-structures bundle.
 *
 * Three model-facing tools turn SMILES into picture files inside the Session
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
const TOOL_MECHANISM = 'draw_mechanism';

/** Prompt section placement: after ordinary guidance, before the persona suffix. */
const PROMPT_ORDER = 9850;

/** Shared wording for the "paste this into the answer" contract. */
const PASTE_HINT = '把下面这一行原样插入回答正文中图片应出现的位置（单独一行，不要放进代码块）：';

export const inject = ['tools', 'systemPrompt', 'workingDirectory'];

/** Absolute directory where this call's figures belong. */
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

/** One-line chemistry summary used inside compact tool rows. */
function shortSummary(value) {
  const facts = [];
  if (typeof value.formulaPretty === 'string' && value.formulaPretty !== '') facts.push(value.formulaPretty);
  if (typeof value.molecularWeight === 'number') facts.push(`M ${value.molecularWeight}`);
  return facts.join(' · ');
}

/** Human-readable CIP descriptors for the model-facing confirmation. */
function stereoSummary(value) {
  const parts = [];
  for (const entry of value.stereoAtoms || []) parts.push(`C${entry.atom}${entry.label}`);
  for (const entry of value.stereoBonds || []) parts.push(`${entry.atoms[0]}=${entry.atoms[1]}${entry.label}`);
  return parts.join('、');
}

export function apply(ctx) {
  const renderer = require('./render.cjs');

  // Compile the WebAssembly module ahead of the first call, without blocking activation.
  ctx.effect(() => {
    const warming = renderer.loadRDKit(VENDOR_DIR);
    if (warming && typeof warming.catch === 'function') warming.catch(() => {});
    return () => {};
  }, 'chem-structures: warm up RDKit');

  /* ---------------------------------------------------------------- */
  /* draw_structure                                                    */
  /* ---------------------------------------------------------------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_STRUCTURE,
        description:
          'Draw one molecular structure as a picture and return a Markdown image line for the answer body. '
          + 'Use this whenever a specific molecule\'s structure matters; you cannot draw structures as text. '
          + 'After the call, paste the returned `![...](...)` line into your reply on its own line where the figure belongs. '
          + 'Input is one SMILES: lower-case aromatic atoms (c1ccccc1), parentheses for branches, ring-closure digits, '
          + "'@'/'@@' for tetrahedral configuration, '/' and '\\' for double-bond geometry, brackets for charges/isotopes "
          + '([NH4+], [O-]), and \'.\' between disconnected species. '
          + 'Set `stereo: true` to annotate CIP descriptors (R/S on centres, E/Z on double bonds) next to the drawing - '
          + 'use it whenever the question is about stereoisomers or a specific enantiomer. '
          + 'Set `numbered: true` to print the 1-based SMILES atom numbers, which the reader can follow in an explanation. '
          + 'Pick `size` to control the picture width: "s" (~300px), "m" (~440px, default), "l" (~620px, crowded skeletons).',
        parameters: {
          type: 'object',
          properties: {
            smiles: {
              type: 'string',
              description: 'SMILES of exactly one structure, e.g. "CC(=O)Oc1ccccc1C(=O)O" for aspirin, or "C[C@H](O)CC" for (S)-butan-2-ol.',
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
            stereo: {
              type: 'boolean',
              description: 'Annotate CIP stereo descriptors: R/S for stereocentres, E/Z for stereo double bonds.',
            },
            numbered: {
              type: 'boolean',
              description: 'Print 1-based atom numbers (SMILES order) beside each atom.',
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
              stereo: { type: 'string' },
            },
            required: ['markdown', 'file', 'width', 'height'],
            additionalProperties: false,
          },
          render: (args, value) => [{
            type: 'text',
            text: `结构图已生成${args.caption ? `（${args.caption}）` : ''}`
              + `${shortSummary(value) ? `，${shortSummary(value)}` : ''}。\n`
              + `${typeof value.stereo === 'string' && value.stereo !== '' ? `立体描述符：${value.stereo}\n` : ''}`
              + `${PASTE_HINT}\n${value.markdown}`,
          }],
          presentationMeta: (args, value) => ({
            kind: 'structure',
            caption: typeof args.caption === 'string' ? args.caption : '',
            formulaPretty: value.formulaPretty,
            molecularWeight: value.molecularWeight,
            width: value.width,
            height: value.height,
            stereo: value.stereo,
          }),
        },
        execute: async (args, exec) => {
          if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
          const rendered = await renderer.renderStructure(VENDOR_DIR, args.smiles, {
            size: args.size,
            stereo: args.stereo === true,
            numbered: args.numbered === true,
          });
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
            ...(stereoSummary(rendered) === '' ? {} : { stereo: stereoSummary(rendered) }),
          };
        },
      }),
    'chem-structures: draw_structure tool',
  );

  /* ---------------------------------------------------------------- */
  /* draw_reaction                                                     */
  /* ---------------------------------------------------------------- */
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
            text: `反应方程式图已生成（${value.width}×${value.height}px）。\n${PASTE_HINT}\n${value.markdown}`,
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

  /* ---------------------------------------------------------------- */
  /* draw_mechanism                                                    */
  /* ---------------------------------------------------------------- */
  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_MECHANISM,
        description:
          'Draw a reaction mechanism with curved electron-pair arrows (电子迁移箭头), as one picture with 1-3 panels '
          + 'connected by arrows, and return a Markdown image line for the answer body. '
          + 'Each panel is one reaction step: { smiles, arrows, caption }. '
          + 'Atom references are 1-based atom numbers in the order the atoms appear in that panel\'s SMILES; '
          + 'branch parentheses and ring-closure digits do not create atoms, and every atom inside square brackets counts as one '
          + '(e.g. "[OH-]" is one atom). '
          + 'Arrow endpoints: "3" = atom 3 (its lone pair / sigma electrons), "bond:3,4" = the bond between atoms 3 and 4 '
          + '(pi or breaking sigma bond), "H:5" = the hydrogen on atom 5 (for proton transfers; RDKit does not draw implicit H). '
          + 'Every arrow goes from an electron source to an electron sink: breaking bonds start at the bond, forming bonds end at '
          + 'an atom. The call result lists each resolved arrow (e.g. "O(1) → C(3)") so you can verify the mapping before answering. '
          + 'After the call, paste the returned `![...](...)` line into your reply on its own line.',
        parameters: {
          type: 'object',
          properties: {
            panels: {
              type: 'array',
              description: '1-3 reaction steps, left to right.',
              items: {
                type: 'object',
                properties: {
                  smiles: {
                    type: 'string',
                    description: 'SMILES of this step, e.g. "[OH-].CCBr". Include every species (catalyst, reagent) as a separate "." component so its atoms can be referenced.',
                  },
                  arrows: {
                    type: 'array',
                    description: 'Curved electron-pair arrows for this step.',
                    items: {
                      type: 'object',
                      properties: {
                        from: { type: 'string', description: 'Electron source: atom number ("3"), bond ("bond:3,4") or hydrogen ("H:5").' },
                        to: { type: 'string', description: 'Electron sink: atom number ("1") or bond ("bond:1,2").' },
                        label: { type: 'string', description: 'Optional short text drawn beside the arrow, e.g. "H⁺".' },
                      },
                      required: ['from', 'to'],
                      additionalProperties: false,
                    },
                  },
                  caption: {
                    type: 'string',
                    description: 'Short caption under this panel, e.g. "质子化" or "亲核进攻".',
                  },
                },
                required: ['smiles'],
                additionalProperties: false,
              },
            },
            numbered: {
              type: 'boolean',
              description: 'Print atom numbers on the figure (default false; turn on when the explanation refers to specific atoms).',
            },
            caption: {
              type: 'string',
              description: 'Short label for the image alt text and tool row, e.g. "SN2 机理".',
            },
          },
          required: ['panels'],
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
              steps: { type: 'number' },
              arrows: { type: 'string' },
            },
            required: ['markdown', 'file', 'width', 'height'],
            additionalProperties: false,
          },
          render: (args, value) => [{
            type: 'text',
            text: `机理图已生成（${value.steps} 步，${value.width}×${value.height}px）。`
              + `${typeof value.arrows === 'string' && value.arrows !== '' ? `\n已解析的电子迁移箭头：${value.arrows}` : ''}\n`
              + `${PASTE_HINT}\n${value.markdown}`,
          }],
          presentationMeta: (args, value) => ({
            kind: 'mechanism',
            caption: typeof args.caption === 'string' ? args.caption : '',
            steps: value.steps,
            width: value.width,
            height: value.height,
          }),
        },
        execute: async (args, exec) => {
          if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
          const rendered = await renderer.renderMechanism(VENDOR_DIR, args.panels, { numbered: args.numbered === true });
          const directory = await figureDirectory(ctx, exec);
          const file = await renderer.writeFigure(directory, 'mechanism', rendered.svg);
          if (exec && exec.signal && exec.signal.aborted) throw new Error('已取消');
          const caption = typeof args.caption === 'string' && args.caption.trim() !== '' ? args.caption.trim() : '反应机理';
          return {
            markdown: renderer.figureMarkdown(file, caption),
            file,
            width: rendered.width,
            height: rendered.height,
            steps: rendered.steps,
            ...(rendered.arrows.length === 0 ? {} : { arrows: rendered.arrows.join('；') }),
          };
        },
      }),
    'chem-structures: draw_mechanism tool',
  );

  /* ---------------------------------------------------------------- */
  /* Prompt guidance                                                   */
  /* ---------------------------------------------------------------- */
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'plugin:chem-structures',
        order: PROMPT_ORDER,
        text:
          'Chemical structures belong in the answer body: call `draw_structure` when a molecule matters, `draw_reaction` when a '
          + 'transformation matters (reactants>>products, conditions above the arrow), and `draw_mechanism` when the electron flow '
          + 'matters (curved arrows, 1-3 steps). '
          + 'For stereochemistry questions, write the SMILES with @/@@ and /\\ and pass `stereo: true` so R/S and E/Z are labelled; '
          + 'the tool result also reports the CIP descriptors, which you can quote. '
          + 'For mechanisms, number atoms by SMILES order (branch/ring digits create no atoms; each bracket atom counts), reference '
          + 'them as "3" / "bond:3,4" / "H:5", and check the resolved arrow list echoed by the tool before explaining. '
          + 'Both tools write a picture file and return one Markdown image line - copy that line into your reply on its own line at '
          + 'the exact place the figure should appear, then keep explaining around it ("如上图"). Never leave the figure only inside '
          + 'the tool call, never wrap the image line in a code block, and never print the file path as text. '
          + 'Choose size "s" for small inline figures, "m" by default, "l" for crowded skeletons.',
      }),
    'chem-structures: prompt section',
  );
}
