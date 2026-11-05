window.__ModuleLoader__.load({
  id: 'dsh-chem-structures',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin (also the slot registration locale). */
    const NS = 'chem-structures';

    /** Simplified Chinese dictionary: source of truth for the key set. */
    const zh = {
      'row.structure': '结构式',
      'row.reaction': '反应方程式',
      'row.preparing': '正在绘制…',
      'row.failed': '绘制失败',
      'row.figure': '结构图',
    };

    /** English dictionary. */
    const en = {
      'row.structure': 'Structure',
      'row.reaction': 'Reaction',
      'row.preparing': 'Drawing…',
      'row.failed': 'Drawing failed',
      'row.figure': 'Structure diagram',
    };

    const CSS = [
      '.chemx-card{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.chemx-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:calc(24px + var(--dsh-content-font-delta,0px));',
      'font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#8b8f96))}',
      '.chemx-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px;color:inherit}',
      '.chemx-title{flex:none;max-width:56%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.chemx-dot{flex:none;width:2px;height:2px;border-radius:1px;background:currentColor;opacity:.7}',
      '.chemx-sum{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.chemx-error{font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;',
      'color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.chemx-pending{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#8b8f96))}',
    ].join('');

    /**
     * Parse the raw tool arguments of either phase (running or settled).
     * @param {any} block
     * @returns {Record<string, unknown>}
     */
    function argsOf(block) {
      if (block === null || typeof block !== 'object') return {};
      const raw = 'kind' in block
        ? (block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : null)
        : (typeof block.argsRaw === 'string' ? block.argsRaw : null);
      if (typeof raw !== 'string' || raw === '') return {};
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (err) {
        return {};
      }
    }

    /** Presentation metadata attached by the Host for the compact row. */
    function metaOf(block) {
      if (block === null || typeof block !== 'object' || !('kind' in block)) return null;
      const meta = block.meta;
      if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
      return meta;
    }

    /** Flatten the durable result content into display text. */
    function resultText(block) {
      if (!block || typeof block !== 'object' || !('kind' in block)) return null;
      const parts = [];
      for (const item of block.content || []) {
        if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
        else if (item) parts.push(JSON.stringify(item, null, 2));
      }
      if (parts.length === 0 && block.error) parts.push(`${block.error.name}: ${block.error.code}`);
      const text = parts.join('\n').trim();
      if (text === '') return null;
      // The model-facing text carries the Markdown image line; the row only needs the first sentence.
      const firstLine = text.split('\n')[0];
      return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
    }

    /** Small original mark: a benzene ring with a delocalisation circle. */
    function StructureIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M8 1.7 13.3 4.8v6.1L8 14.1 2.7 10.9V4.8Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8, cy: 7.9, r: 2.05, fill: 'none', stroke: 'currentColor', strokeWidth: 1.05 }),
      );
    }

    /**
     * One compact row for a drawing tool call; the figure itself lives in the
     * assistant's answer body.
     * @param {'structure'|'reaction'} kind
     */
    function makeRow(kind) {
      return function ChemRow(props) {
        const block = props.block;
        const args = argsOf(block);
        const t = typeof props.t === 'function' ? props.t : (key) => zh[key] || key;
        const meta = metaOf(block);
        const settled = block !== null && typeof block === 'object' && 'kind' in block;
        const failed = settled && block.isError === true;
        const fallbackTitle = t(kind === 'reaction' ? 'row.reaction' : 'row.structure');
        const caption = typeof args.caption === 'string' && args.caption.trim() !== ''
          ? args.caption.trim()
          : (meta && typeof meta.caption === 'string' && meta.caption !== '' ? meta.caption : fallbackTitle);

        const facts = [];
        if (meta && typeof meta.formulaPretty === 'string' && meta.formulaPretty !== '') facts.push(meta.formulaPretty);
        if (meta && typeof meta.molecularWeight === 'number') facts.push(`M ${meta.molecularWeight}`);
        if (kind === 'reaction' && meta && typeof meta.conditions === 'string' && meta.conditions !== '') facts.push(meta.conditions);

        const children = [
          h(
            'div',
            { className: 'chemx-row', key: 'row' },
            h('span', { className: 'chemx-icon' }, h(StructureIcon)),
            h('span', { className: 'chemx-title' }, caption),
            facts.length > 0 ? h('span', { className: 'chemx-dot', 'aria-hidden': 'true' }) : null,
            facts.length > 0 ? h('span', { className: 'chemx-sum' }, facts.join(' · ')) : null,
            failed ? h('span', { className: 'chemx-sum' }, t('row.failed')) : null,
          ),
        ];

        if (failed) {
          children.push(h('div', { className: 'chemx-error', key: 'error' }, resultText(block) || t('row.failed')));
        } else if (!settled) {
          children.push(h('div', { className: 'chemx-pending', key: 'pending' }, t('row.preparing')));
        }

        return h(
          'div',
          {
            className: 'chemx-card',
            'data-tool': kind === 'reaction' ? 'draw_reaction' : 'draw_structure',
            'data-state': failed ? 'error' : settled ? 'ok' : 'running',
          },
          children,
        );
      };
    }

    const StructureRow = makeRow('structure');
    const ReactionRow = makeRow('reaction');

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chem-structures: dictionaries');
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const tagId = 'dsh-chem-structures/chem-structures.css';
          const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']';
          let tag = document.querySelector(selector);
          const created = tag === null;
          if (created) {
            tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-chem-structures';
            tag.dataset.pluginCss = tagId;
          }
          tag.textContent = CSS;
          if (created) document.head.appendChild(tag);
          return () => {
            if (created && tag.parentNode) tag.parentNode.removeChild(tag);
          };
        }, 'chem-structures: styles');
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: 'draw_structure', locale: NS },
            StructureRow,
          ));
        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: 'draw_reaction', locale: NS },
            ReactionRow,
          ));
      },
    };
  },
});
