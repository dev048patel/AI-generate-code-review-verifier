interface Group {
  label: string;
  full: number; // 0-100
  baseline: number; // 0-100
}

const WIDTH = 640;
const HEIGHT = 220;
const MARGIN = { top: 16, right: 16, bottom: 28, left: 36 };
const BAR_WIDTH = 26;

/**
 * Grouped bar chart comparing the full pipeline against the no-AI baseline
 * across a few percentage metrics. Two series -> legend + direct value
 * labels on every bar (a handful of bars total, not a dense series).
 */
export function ComparisonBarChart({ groups }: { groups: Group[] }) {
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const groupWidth = plotWidth / groups.length;
  const yScale = (v: number) => plotHeight - (v / 100) * plotHeight;

  const gridLines = [0, 25, 50, 75, 100];

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Precision, recall, and F1 comparison chart" width="100%">
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {gridLines.map((g) => (
            <g key={g}>
              <line
                x1={0}
                x2={plotWidth}
                y1={yScale(g)}
                y2={yScale(g)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text x={-8} y={yScale(g)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--text-muted)">
                {g}
              </text>
            </g>
          ))}

          {groups.map((group, i) => {
            const groupX = i * groupWidth + groupWidth / 2;
            const fullX = groupX - BAR_WIDTH - 4;
            const baseX = groupX + 4;
            return (
              <g key={group.label}>
                <Bar x={fullX} value={group.full} yScale={yScale} plotHeight={plotHeight} color="var(--series-1)" />
                <Bar x={baseX} value={group.baseline} yScale={yScale} plotHeight={plotHeight} color="var(--series-2)" />
                <text
                  x={groupX}
                  y={plotHeight + 18}
                  textAnchor="middle"
                  fontSize={12}
                  fill="var(--text-secondary)"
                  fontWeight={600}
                >
                  {group.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: "var(--series-1)" }} />
          Full pipeline
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: "var(--series-2)" }} />
          No-AI baseline (rules only)
        </span>
      </div>
    </div>
  );
}

function Bar({
  x,
  value,
  yScale,
  plotHeight,
  color,
}: {
  x: number;
  value: number;
  yScale: (v: number) => number;
  plotHeight: number;
  color: string;
}) {
  const y = yScale(value);
  const h = plotHeight - y;
  return (
    <g>
      <rect x={x} y={y} width={BAR_WIDTH} height={Math.max(h, 1)} rx={4} fill={color} />
      <text x={x + BAR_WIDTH / 2} y={y - 6} textAnchor="middle" fontSize={11} fontWeight={650} fill="var(--text-primary)">
        {value.toFixed(0)}
      </text>
    </g>
  );
}
