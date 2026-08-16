# Rhythm Chart

This context describes how musical moments become player choices and movement gestures in a five-lane rhythm run.

## Language

**Target Cell**:
A breakable object in one lane that can satisfy its Choice Row when collected.
_Avoid_: Note, obstacle

**Hazard Cell**:
A spike in one lane that immediately ends the run when touched.
_Avoid_: Target, note

**Choice Row**:
A simultaneous musical moment containing one or more Target Cells; collecting any one Target Cell satisfies the row exactly once.
_Avoid_: Single note, mandatory lane

**Gate Row**:
A simultaneous musical moment made only of Hazard Cells and safe lanes, used to shape movement without requiring a hit.
_Avoid_: Empty row, target row

**Route Branch**:
Two or more equally valid continuations offered by a Choice Row or Gate Row, without a designated best lane.
_Avoid_: Preferred lane, optimal path

**Combo**:
The count of consecutive resolved gameplay rows; a Choice Row or survived Gate Row contributes at most one Combo step.
_Avoid_: Per-target streak

**Gesture**:
A recognizable sequence of Choice Rows and Gate Rows that elicits a movement contour from the player.
_Avoid_: Random row sequence

**M Gesture**:
A literal six-row Gesture that alternates three-spike Gate Rows with far-edge Choice Rows, forcing repeated full-width strokes.
_Avoid_: M-shaped obstacle picture, fixed pocket

Canonical six-row forms (the second form is the mirror):

- `00222 → 00001 → 22200 → 00001 → 00222 → 00001`
- `22200 → 10000 → 00222 → 10000 → 22200 → 10000`

**Full-width Drum Sweep**:
A strong-section Gesture with three forced edge Choice Rows in `0 → 4 → 0` order or its mirror. Intermediate Gate Rows guide continuous lateral travel; they are not alternative center routes.
_Avoid_: Edge decoration, optional sweep, center wiggle

## Invariants

- A gameplay row contributes at most one Combo step, regardless of its number of cells.
- Hazards resolve before targets within the same row.
- Every displayed Target Cell in a Route Branch belongs to at least one complete Combo route.
- A declared M Gesture is six uninterrupted rows in the actual event stream, not a metadata-only summary.
- Every sufficiently long peak section contains a forced Full-width Drum Sweep and has no full-Combo route confined to lanes 1–3.
- A canonical repeated phrase preserves its ordered rows and Route Branches across occurrences.
- Event times remain measured audio events; route generation never moves them onto a tempo grid.
