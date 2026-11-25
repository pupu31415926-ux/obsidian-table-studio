"""Build main.js and styles.css from src/.  Usage: python3 build.py"""
import pathlib
ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / 'src'; OUT = ROOT
N = 32
COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']

core = (SRC / 'core.js').read_text(); loc = (SRC / 'locales.js').read_text()
assert '/*__LOCALES__*/' in core
(OUT / 'main.js').write_text(core.replace('/*__LOCALES__*/', loc.strip()))

def sel(attr, i, tail=''):
    return f'table.tt-managed[{attr}~="c{i}"] > * > tr > :nth-child({i}){tail}'
def group(attr, tail):
    return ',\n'.join(sel(attr, i, tail) for i in range(1, N + 1))

css = [(SRC / 'base.css').read_text().rstrip(), '',
       '/* =========================================================',
       f'   以下由 build.py 生成：按列的换行与背景色（最多 {N} 列）',
       '   ========================================================= */', '',
       '/* 按列不换行：截断显示为省略号 */',
       group('data-tt-nw', ':not(:focus-within)') + ' {\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}',
       group('data-tt-nw', ':not(:focus-within) *') + ' {\n  white-space: nowrap !important;\n}',
       group('data-tt-nw', ':not(:focus-within) .table-cell-wrapper') + ' {\n  overflow: hidden;\n  text-overflow: ellipsis;\n}',
       '/* 编辑被截断的单元格：内容浮起完整显示，不撑高整行 */',
       group('data-tt-nw', ':focus-within') + ' {\n  position: relative;\n  overflow: visible;\n}',
       group('data-tt-nw', ':focus-within > .table-cell-wrapper') + ''' {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  box-sizing: border-box;
  min-width: 100%;
  width: max-content;
  max-width: min(480px, 70vw);
  min-height: 100%;
  background-color: var(--background-primary);
  box-shadow: var(--shadow-s);
  border-radius: var(--radius-s, 4px);
}''',
       'table.tt-managed.tt-frz-col > * > tr > :first-child:focus-within {\n  position: sticky;\n}', '',
       '/* 行背景色 */']
for c in COLORS:
    css.append(f'table.tt-managed > * > tr[data-tt-color="{c}"] {{ --tt-row-bg: var(--tt-{c}); }}')
css.append('')
css.append('/* 列背景色 */')
for c in COLORS:
    css.append(group(f'data-tt-c-{c}', '') + f' {{\n  --tt-col-bg: var(--tt-{c});\n}}')
(OUT / 'styles.css').write_text('\n'.join(css) + '\n')
print('built', len((OUT / 'main.js').read_text()), 'bytes js,', len((OUT / 'styles.css').read_text()), 'bytes css')
