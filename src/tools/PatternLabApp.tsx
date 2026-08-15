import { useEffect, useMemo, useState } from 'react';

type Cell = 0 | 1 | 2;
type RowCells = [Cell, Cell, Cell, Cell, Cell];

interface PatternRow {
  id: string;
  cells: RowCells;
  intent: string;
  pace: string;
}

interface PatternPreset {
  id: string;
  name: string;
  sequence: string;
  description: string;
  rows: PatternRow[];
  note: string;
}

const STORAGE_KEY = 'neon-slice:pattern-draft:v1';
const CELL_LABELS: Record<Cell, string> = { 0: '空路', 1: '击打方块', 2: '地刺' };
const CELL_ICONS: Record<Cell, string> = { 0: '·', 1: '◆', 2: '▲' };
const INTENTS = [
  '向左滑', '向右滑', '立刻折返', '压到边缘', '短暂保持', '先误导再变向', '自由选路', '喘口气',
];
const PACES = ['快', '正常', '慢'];

const SAMPLE_ROWS: PatternRow[] = [
  { id: 'sample-1', cells: [2, 2, 0, 0, 1], intent: '向右滑', pace: '正常' },
  { id: 'sample-2', cells: [2, 0, 0, 1, 2], intent: '向左滑', pace: '正常' },
  { id: 'sample-3', cells: [0, 0, 1, 2, 2], intent: '向左滑', pace: '快' },
  { id: 'sample-4', cells: [0, 1, 0, 2, 2], intent: '立刻折返', pace: '正常' },
  { id: 'sample-5', cells: [1, 0, 2, 2, 2], intent: '压到边缘', pace: '慢' },
  { id: 'sample-6', cells: [0, 1, 0, 2, 2], intent: '向右滑', pace: '正常' },
  { id: 'sample-7', cells: [2, 0, 1, 0, 2], intent: '向右滑', pace: '快' },
  { id: 'sample-8', cells: [2, 2, 0, 1, 0], intent: '短暂保持', pace: '慢' },
];

const STANDARD_M_ROWS: PatternRow[] = [
  { id: 'm-1', cells: [2, 2, 2, 0, 0], intent: '向右滑', pace: '正常' },
  { id: 'm-2', cells: [0, 0, 0, 0, 0], intent: '向左滑', pace: '快' },
  { id: 'm-3', cells: [1, 0, 0, 0, 0], intent: '向左滑', pace: '快' },
  { id: 'm-4', cells: [1, 0, 0, 0, 0], intent: '立刻折返', pace: '快' },
  { id: 'm-5', cells: [0, 0, 0, 0, 0], intent: '向右滑', pace: '快' },
  { id: 'm-6', cells: [2, 2, 2, 0, 0], intent: '压到边缘', pace: '正常' },
];

const CLIMAX_SMS_ROWS: PatternRow[] = [
  { id: 'sms-s1-1', cells: [1, 0, 2, 2, 2], intent: '向左滑', pace: '快' },
  { id: 'sms-s1-2', cells: [0, 1, 0, 0, 0], intent: '向右滑', pace: '快' },
  { id: 'sms-s1-3', cells: [0, 0, 1, 0, 0], intent: '向右滑', pace: '快' },
  { id: 'sms-s1-4', cells: [0, 0, 0, 1, 0], intent: '向右滑', pace: '快' },
  { id: 'sms-s1-5', cells: [2, 2, 2, 0, 1], intent: '压到边缘', pace: '正常' },
  { id: 'sms-s1-6', cells: [0, 0, 0, 0, 0], intent: '短暂保持', pace: '正常' },
  ...STANDARD_M_ROWS.map((row, index) => ({ ...row, id: `sms-m-${index + 1}` })),
  { id: 'sms-s2-1', cells: [0, 0, 0, 0, 1], intent: '向左滑', pace: '快' },
  { id: 'sms-s2-2', cells: [0, 0, 0, 1, 0], intent: '向左滑', pace: '快' },
  { id: 'sms-s2-3', cells: [0, 0, 1, 0, 0], intent: '向左滑', pace: '快' },
  { id: 'sms-s2-4', cells: [0, 1, 0, 0, 0], intent: '向左滑', pace: '快' },
  { id: 'sms-s2-5', cells: [1, 0, 2, 2, 2], intent: '压到边缘', pace: '正常' },
  { id: 'sms-s2-6', cells: [0, 0, 0, 0, 0], intent: '喘口气', pace: '慢' },
];

const PRESETS: PatternPreset[] = [
  {
    id: 'slide-sample',
    name: '基础滑行示例',
    sequence: '自由绘制 · 8 拍',
    description: '保留原来的编辑起点，用来快速尝试单行地刺与方块组合。',
    rows: SAMPLE_ROWS,
    note: '',
  },
  {
    id: 'standard-m',
    name: '标准 M · 左侧奖励',
    sequence: '22200 · 00000 · 10000 · 10000 · 00000 · 22200',
    description: '两堵地刺墙把连续旋律方块夹在左侧。保命可以留在右边，追求 Combo 则要左划取块再返回。镜像时将每一行左右翻转。',
    rows: STANDARD_M_ROWS,
    note: '标准 M 风险奖励口袋：先留在右侧过墙，再主动左划吃连续方块，最后返回右侧；镜像版本把所有行左右翻转。',
  },
  {
    id: 'climax-sms',
    name: '高潮 S → 旋律 M → S',
    sequence: '连续换边 · 抢拍取块 · 再次换边',
    description: '前段 S 提升滑动频率，中段 M 用连续方块制造追 Combo 的冒险，尾段 S 延续高压，适合音乐最强处。',
    rows: CLIMAX_SMS_ROWS,
    note: '高潮组合：用 S 连续换边抬高注意力，接旋律 M 主动抢连续方块，再用反向 S 保持高压。',
  },
];

function copyRows(rows: PatternRow[]): PatternRow[] {
  return rows.map((row, index) => ({ ...row, id: `${Date.now()}-${index}`, cells: [...row.cells] as RowCells }));
}

function readDraft(): { rows: PatternRow[]; note: string } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as { rows?: PatternRow[]; note?: string } | null;
    if (parsed?.rows?.length) return { rows: parsed.rows, note: parsed.note ?? '' };
  } catch {
    // Ignore a damaged local draft and return the editable example.
  }
  return { rows: copyRows(SAMPLE_ROWS), note: '' };
}

function findInvalidGap(cells: RowCells): number | null {
  for (let lane = 1; lane <= 3; lane += 1) {
    if (cells[lane] !== 2 && cells[lane - 1] === 2 && cells[lane + 1] === 2) return lane;
  }
  return null;
}

function describe(rows: PatternRow[], note: string): string {
  const lines = rows.map((row, index) => (
    `第${String(index + 1).padStart(2, '0')}拍（${row.pace}，${row.intent}）：${row.cells.map((cell) => CELL_ICONS[cell]).join(' ')}  [${row.cells.join(',')}]`
  ));
  return [
    '我想要的 5 道谱面片段（0=空路，1=击打方块，2=地刺）：',
    ...lines,
    note.trim() ? `整体感觉：${note.trim()}` : '',
  ].filter(Boolean).join('\n');
}

export function PatternLabApp() {
  const initial = useMemo(readDraft, []);
  const [rows, setRows] = useState(initial.rows);
  const [note, setNote] = useState(initial.note);
  const [tool, setTool] = useState<Cell>(2);
  const [notice, setNotice] = useState('点击格子就能画，不需要谱面术语。');

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows, note }));
  }, [note, rows]);

  const invalidRows = useMemo(() => rows.reduce<number[]>((indices, row, index) => {
    if (findInvalidGap(row.cells) !== null) indices.push(index);
    return indices;
  }, []), [rows]);
  const spikeCount = rows.reduce((total, row) => total + row.cells.filter((cell) => cell === 2).length, 0);
  const targetCount = rows.reduce((total, row) => total + row.cells.filter((cell) => cell === 1).length, 0);

  const paintCell = (rowIndex: number, laneIndex: number) => {
    setRows((current) => current.map((row, index) => {
      if (index !== rowIndex) return row;
      const cells = [...row.cells] as RowCells;
      if (tool === 1) {
        for (let lane = 0; lane < cells.length; lane += 1) {
          if (cells[lane] === 1) cells[lane] = 0;
        }
      }
      cells[laneIndex] = tool;
      return { ...row, cells };
    }));
  };

  const updateRow = (rowIndex: number, field: 'intent' | 'pace', value: string) => {
    setRows((current) => current.map((row, index) => index === rowIndex ? { ...row, [field]: value } : row));
  };

  const loadPreset = (preset: PatternPreset) => {
    setRows(copyRows(preset.rows));
    setNote(preset.note);
    setNotice(`已载入“${preset.name}”，可以继续直接修改。`);
  };

  const copyDescription = async () => {
    try {
      await navigator.clipboard.writeText(describe(rows, note));
      setNotice('已复制。直接粘贴到 Codex 对话里即可。');
    } catch {
      setNotice('浏览器没有允许剪贴板，请使用“导出设计文件”。');
    }
  };

  const exportDraft = () => {
    const payload = {
      schemaVersion: 1,
      kind: 'neon-slice-pattern-draft',
      laneCount: 5,
      legend: { 0: 'empty', 1: 'breakable', 2: 'spike' },
      rows: rows.map(({ cells, intent, pace }, index) => ({ order: index + 1, cells, intent, pace })),
      note,
      generatedAt: new Date().toISOString(),
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'neon-slice.pattern-draft.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setNotice('已导出。把这份 JSON 发给 Codex 即可。');
  };

  return (
    <main className="pattern-lab">
      <header className="pattern-header">
        <div><p>NEON SLICE · PATTERN LAB</p><h1>谱面想法板</h1><span>把你脑中的滑行路线直接画出来。</span></div>
        <nav><a href="/">返回游戏</a><a href="/rhythm-lab.html">节奏试听室</a></nav>
      </header>

      <section className="pattern-presets" aria-label="谱面形态模板">
        <div className="preset-intro">
          <p>一键载入形态</p>
          <span>先看完整节奏动作，再按自己的感觉改每一拍。</span>
        </div>
        <div className="preset-list">
          {PRESETS.map((preset) => (
            <button key={preset.id} type="button" onClick={() => loadPreset(preset)}>
              <span className="preset-name">{preset.name}</span>
              <code>{preset.sequence}</code>
              <small>{preset.description}</small>
              <i>载入模板</i>
            </button>
          ))}
        </div>
      </section>

      <section className="pattern-toolbar" aria-label="选择画笔">
        <strong>选择要画的东西</strong>
        {([0, 1, 2] as Cell[]).map((cell) => (
          <button key={cell} type="button" className={`tool-${cell} ${tool === cell ? 'is-active' : ''}`} aria-pressed={tool === cell} onClick={() => setTool(cell)}>
            <i>{CELL_ICONS[cell]}</i>{CELL_LABELS[cell]}
          </button>
        ))}
        <button type="button" className="pattern-reset" onClick={() => { setRows(copyRows(SAMPLE_ROWS)); setNote(''); setNotice('已恢复滑行示例。'); }}>恢复示例</button>
        <button type="button" className="pattern-reset" onClick={() => { setRows(copyRows(SAMPLE_ROWS).map((row) => ({ ...row, cells: [0, 0, 0, 0, 0] }))); setNotice('已清空格子。'); }}>清空重画</button>
      </section>

      <div className="pattern-layout">
        <section className="pattern-board" aria-label="五道谱面编辑器">
          <div className="lane-heading"><span />{[1, 2, 3, 4, 5].map((lane) => <b key={lane}>{lane} 道</b>)}<span>我希望玩家…</span><span>衔接</span></div>
          {rows.map((row, rowIndex) => {
            const invalidLane = findInvalidGap(row.cells);
            return (
              <div key={row.id} className={`pattern-row ${invalidLane === null ? '' : 'is-invalid'}`}>
                <span className="row-index">{String(rowIndex + 1).padStart(2, '0')}</span>
                {row.cells.map((cell, laneIndex) => (
                  <button
                    key={laneIndex}
                    type="button"
                    className={`pattern-cell cell-${cell} ${invalidLane === laneIndex ? 'is-problem' : ''}`}
                    aria-label={`第 ${rowIndex + 1} 拍，第 ${laneIndex + 1} 道，${CELL_LABELS[cell]}`}
                    onClick={() => paintCell(rowIndex, laneIndex)}
                  >{CELL_ICONS[cell]}</button>
                ))}
                <select aria-label={`第 ${rowIndex + 1} 拍的移动意图`} value={row.intent} onChange={(event) => updateRow(rowIndex, 'intent', event.target.value)}>
                  {INTENTS.map((intent) => <option key={intent}>{intent}</option>)}
                </select>
                <select aria-label={`第 ${rowIndex + 1} 拍的衔接速度`} value={row.pace} onChange={(event) => updateRow(rowIndex, 'pace', event.target.value)}>
                  {PACES.map((pace) => <option key={pace}>{pace}</option>)}
                </select>
              </div>
            );
          })}
          <div className="player-edge"><span />玩家方向</div>
        </section>

        <aside className="pattern-side">
          <section className="pattern-summary">
            <span>{rows.length} 拍</span><span>{targetCount} 个方块</span><span>{spikeCount} 组地刺</span>
          </section>
          <section className={`pattern-check ${invalidRows.length ? 'has-error' : ''}`} aria-live="polite">
            <strong>{invalidRows.length ? `有 ${invalidRows.length} 行需要调整` : '安全口形状合理'}</strong>
            <p>{invalidRows.length ? `第 ${invalidRows.map((index) => index + 1).join('、')} 行在中间留了单格空口，已标红。` : '中间第 2–4 道没有被尖刺夹住的单格空口。'}</p>
          </section>
          <label className="pattern-note">这段整体想要什么感觉？
            <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：前四拍一直把人逼向右边，第五拍突然折返，然后给一拍喘息…" />
          </label>
          <div className="pattern-actions">
            <button type="button" className="primary" onClick={() => void copyDescription()}>复制给 Codex</button>
            <button type="button" onClick={exportDraft}>导出设计文件</button>
          </div>
          <p className="pattern-notice" aria-live="polite">{notice}</p>
          <div className="pattern-legend"><span><i className="legend-empty">·</i>空路</span><span><i className="legend-target">◆</i>击打</span><span><i className="legend-spike">▲</i>地刺</span></div>
        </aside>
      </div>
    </main>
  );
}
