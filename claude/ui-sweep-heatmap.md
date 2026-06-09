Sweep Visualizations — Percentile Curves + Heatmaps
Read CLAUDE.md and claude/ui-guidance.md fully before doing anything else.
Read the existing sweep results page and run results page code carefully
before writing anything. Understand what's already built before adding to it.
This session adds two visualization components to the sweep results page:

Overlaid percentile curves with toggleable runs
Heatmap grid (publish p99, publish p999, e2e p99, e2e p999)

Do not touch Terraform, Helm, CI/CD, or any backend API endpoints unless
a bug is discovered that blocks the frontend work.

Data available in SQLite
sweeps table (relevant columns)

id
name
parameter_axes — JSON dict of dimension_name → list of values
Example: {"partitionsPerTopic": [1, 100], "producerConfig.acks": [0, "all"],
"producerConfig.linger.ms": [5, 10]}

runs table (relevant columns)

id
sweep_id — foreign key to sweeps
sweep_params — JSON dict of dimension_name → value for this specific run
Example: {"partitionsPerTopic": 100, "producerConfig.acks": "all",
"producerConfig.linger.ms": 10}

run_results table (relevant columns)

run_id
publish_p99, publish_p999 — aggregate publish latency values (ms)
e2e_p99, e2e_p999 — aggregate e2e latency values (ms)
publish_quantiles_json — full HDR percentile curve as JSON text
Parsed structure: array of {percentile: float, latencyMs: float}
Percentiles range from 50.0 to 99.9999, thinned to every 10th point
e2e_quantiles_json — same structure for e2e latency


New API endpoint
GET /api/sweeps/{sweep_id}/visualization-data
Returns everything needed to render both chart types in a single call:
json{
  "sweep": {
    "id": 7,
    "name": "my sweep",
    "parameter_axes": {
      "partitionsPerTopic": [1, 100],
      "producerConfig.acks": [0, "all"],
      "producerConfig.linger.ms": [5, 10]
    }
  },
  "runs": [
    {
      "run_id": 86,
      "sweep_params": {
        "partitionsPerTopic": 100,
        "producerConfig.acks": "all",
        "producerConfig.linger.ms": 10
      },
      "label": "partitions=100, acks=all, linger=10",
      "publish_p99": 8.2,
      "publish_p999": 15.4,
      "e2e_p99": 9.4,
      "e2e_p999": 23.6,
      "publish_quantiles": [{"percentile": 50.0, "latencyMs": 3.3}, ...],
      "e2e_quantiles": [{"percentile": 50.0, "latencyMs": 3.9}, ...]
    },
    ...
  ]
}
Label generation: join all sweep_params as "key=value" pairs separated
by ", ". If the label exceeds 40 characters, truncate with "...". Labels
must be unique within a sweep — if truncation causes collisions, keep
full labels.
If run_results does not exist for a run (HDR parsing not yet complete),
include the run in the response with null for all metric fields. The
frontend must handle nulls gracefully — skip that run in charts rather
than crashing.

Component 1 — Overlaid percentile curves with toggleable runs
What it shows
All runs in the sweep on the same chart. Each run is one line.
X-axis: percentile (log scale, p50 to p99.9999).
Y-axis: latency in ms (linear, auto-scaled to visible series).
Publish latency and e2e latency are separate charts, side by side.
Controls
A legend/checkbox panel to the right of the charts. One checkbox per run,
labeled with the run's label string. All runs checked by default.
When a run is unchecked:

Its line is removed from both charts simultaneously
The y-axis domain recalculates based on the remaining visible series
Y-axis domain = [0, max latency across all visible series * 1.1]
Do NOT leave the y-axis locked to the full dataset range when runs
are hidden — this is the most important behavior requirement here.

Implementation notes
Use Recharts LineChart. Each run is a <Line> component.
The log scale x-axis requires scale="log" on the XAxis component.
X-axis tick values: [50, 90, 99, 99.9, 99.99, 99.999] — format as
strings, not raw floats.
Use a consistent color palette — assign colors to runs by index so
the same run always gets the same color regardless of which others
are visible.
Both charts (publish and e2e) must share the same color assignments
so run colors are consistent across both charts.
Layout
Full width of the sweep results page.
Two charts side by side: "Publish latency — percentile curves" (left)
and "E2E latency — percentile curves" (right).
Checkbox panel to the right of both charts, shared — one set of
checkboxes controls both charts simultaneously.

Component 2 — Heatmap grid
What it shows
Four heatmaps in a 2×2 grid:

Top left:    Publish latency p99
Top right:   Publish latency p99.9
Bottom left: E2E latency p99
Bottom right: E2E latency p99.9

All four heatmaps always reflect the same selected axes and slice values.
Controls (shared across all four heatmaps)
These controls sit above the 2×2 grid and apply to all four charts:
X-axis picker — dropdown populated from parameter_axes keys.
Y-axis picker — dropdown populated from parameter_axes keys.
X and Y must be different dimensions — if the user selects the same
dimension for both, show a validation message and revert.
Slice controls — for each dimension NOT selected as X or Y axis,
show a dropdown labeled with the dimension name, populated with that
dimension's values from parameter_axes. The user selects which value
to hold constant. Default to the first value in the list.
When axes or slice values change, all four heatmaps update simultaneously.
Default axis selection: on load, auto-select the first two dimensions
from parameter_axes as X and Y axes. All remaining dimensions get slice
controls defaulting to their first value.
Heatmap rendering
Use Recharts for the heatmap implementation.
Each heatmap cell represents one run. The cell's position is determined
by its sweep_params values for the X and Y dimensions. Color represents
the metric value (p99, p999 etc) for that run.
Color scale: green (low latency, good) → yellow → red (high latency, bad).
Compute the color scale domain from the visible data in each individual
heatmap — do not share a domain across all four heatmaps, since p99 and
p999 have different value ranges.
Cell labels: show the numeric value inside each cell (e.g. "8.2ms").
If the cell is too small for a label, omit it.
Runs excluded by the slice selection (their sweep_params don't match
the current slice values) are not shown — they are simply absent from
the grid. Do not show empty/grey cells for excluded runs.
If a run has null metric values (HDR parsing incomplete), show the cell
in a neutral grey with "—" as the label.
Layout
Controls row above the grid (axis pickers + slice dropdowns).
2×2 grid of equal-sized heatmaps below.
Each heatmap has a title: "Publish p99 (ms)", "Publish p99.9 (ms)",
"E2E p99 (ms)", "E2E p99.9 (ms)".
Color scale legend below each heatmap.

Page layout on the sweep results page
Existing content (comparison table, run list) stays as-is above.
New section: "Latency percentile curves"

Overlaid percentile curves component (full width)

New section: "Latency heatmaps"

Axis/slice controls row
2×2 heatmap grid


Validation
Use sweep 7 data (or the equivalent current sweep with 3 dimensions and
8 runs) to validate:

GET /api/sweeps/{id}/visualization-data returns correct data for all runs
Percentile curves render — one line per run, correct colors
Unchecking a run removes it from both publish and e2e charts
Y-axis rescales correctly when runs are hidden — verify with a run
that has significantly higher latency than others
X-axis shows log scale with correct tick labels (50, 90, 99, 99.9...)
Heatmap renders 2×2 grid with correct cell values
Axis picker change updates all four heatmaps simultaneously
Slice control change filters correctly — only runs matching the
current slice values appear
Color scale is green→red with correct domain per heatmap
With 3 dimensions and X+Y consuming 2, exactly 1 slice control
appears for the third dimension


Notes

Recharts does not have a built-in heatmap component — implement using
a custom SVG or a grid of colored rectangles via Recharts' customized
rendering. Alternatively use a CSS grid of colored divs if SVG is
overly complex. The goal is correct data representation, not a
pixel-perfect charting library heatmap.
The y-axis auto-scaling on series toggle is the most likely thing to
get wrong — test this explicitly with runs that have very different
latency profiles.
Do not implement parallel coordinates in this session — that is a
separate future item.
Do not implement the YAML-driven sweep config in this session — the
existing parameter_axes JSON in SQLite is sufficient for this work.
