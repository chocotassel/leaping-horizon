# Rhythm Chart

Leaping Horizon uses an algorithm-generated base chart with a small manual-edit layer.

## Language

**Rhythm Point**

A measured attack or Beat This beat where the editor may place cells. It owns time only; an empty Rhythm Point is valid.

**Base Row**

The algorithm's starting five-lane row. Measured pitch controls the suggested lane for Target Cells.

**Target Cell**

A breakable block (`1`) that contributes score and Combo when collected.

**Hazard Cell**

A spike (`2`) that ends the run when touched.

**Row Override**

A sparse manual replacement for one Base Row, addressed by its measured Rhythm Point time.

**Color Range**

A non-overlapping manual interval that overrides the base palette from one Rhythm Point to another.

**Level Edits**

The versioned `edits.json` sidecar containing Row Overrides and Color Ranges. It is preserved when the base chart is regenerated.

## Production flow

```text
audio.mp3
  -> analyze-rhythm.py
  -> transcribePerformance(...): measured attacks + pitch lanes
  -> build-rhythm-levels.mjs: compact Base Rows + all editable Rhythm Points
  -> src/songs/<song>/level.json
       + src/songs/<song>/edits.json
  -> applyLevelEdits(...)
  -> runtime Level
```

The development workbench is `/editor.html`. Its save endpoint writes only the song's `edits.json`; it never rewrites analysis or the generated base chart.

## Invariants

- A Row Override may reference only an existing Rhythm Point.
- Rhythm Point times remain measured values and are never moved by the editor.
- Five-lane values are `0` empty, `1` Target Cell, or `2` Hazard Cell.
- An all-empty override removes the corresponding gameplay row without removing the Rhythm Point.
- A manually added non-empty row at an empty Rhythm Point becomes a gameplay row.
- A row containing at least one Target Cell is a Choice Row; a spike-only row is a Gate Row.
- Color Ranges start and end at Rhythm Points, may end at song duration, and may not overlap.
- Outside manual Color Ranges, the conservative algorithmic palette remains active.
- `level.json` contains runtime/base data only; analysis evidence and large explanatory scores remain in ignored `work/` files.
