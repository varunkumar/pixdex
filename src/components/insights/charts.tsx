import type { Chart } from './factText';

/** A small CSS chart. Screen readers get the same figures as one label. */
const FactChart = ({ chart, label }: { chart: Chart; label: string }) => {
  if (chart.type === 'columns') {
    const max = Math.max(...chart.values, 1);
    const text = chart.labels.map((l, i) => `${l} ${Math.round(chart.values[i] * 10) / 10}`).join(', ');
    return (
      <div role="img" aria-label={`${label}: ${text}`}>
        <div className="pdx-cols">
          {chart.values.map((v, i) => (
            <i key={i} data-on={i === chart.highlight} style={{ height: `${(v * 100) / max}%` }} />
          ))}
        </div>
        <div className="pdx-cols-axis">
          {chart.labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      </div>
    );
  }
  if (chart.type === 'bars') {
    const max = Math.max(...chart.rows.map((r) => r.value), 1);
    return (
      <div className="pdx-bars">
        {chart.rows.map((r) => (
          <div key={r.label} className="pdx-bar-row">
            <span title={r.label}>{r.label}</span>
            <div className="pdx-track" aria-hidden="true">
              <i style={{ width: `${(r.value * 100) / max}%` }} />
            </div>
            <span>{r.text}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="pdx-bars">
      {chart.rows.map((r) => (
        <div key={r.label} className="pdx-bar-row pdx-span-row">
          <span title={r.label}>{r.label}</span>
          <div className="pdx-track" aria-hidden="true">
            {/* At least a sliver, so a camera used on one day still shows. */}
            <i style={{ marginLeft: `${Math.min(r.start, 98)}%`, width: `${Math.max(r.width, 2)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
};

export default FactChart;
