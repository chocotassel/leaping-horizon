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
A literal ten-slot obstacle layout with six visible rows and four silent travel slots.
_Avoid_: Metadata-only M, filled-in silent slots

Canonical forms (the second form is the mirror):

- `22200 → 00000 → 10000 → 00000 → 22200 → 22200 → 00000 → 10000 → 00000 → 22200`
- `00222 → 00000 → 00001 → 00000 → 00222 → 00222 → 00000 → 00001 → 00000 → 00222`

`00000` is a silent template slot, not a stored gameplay row.

**Full-width Drum Sweep**:
A driving Gesture with at least five forced edge Choice Rows in `0 → 4 → 0 → 4 → 0` order or its mirror. Each full-width stroke lands on the next measured beat. Lower pressure uses clean `10000 / 00001` rows; higher pressure uses `10222 / 22201`, leaving one empty lane between the Target Cell and three Hazard Cells.
_Avoid_: Edge decoration, optional sweep, center wiggle

**Wave Gate**:
A rule-generated hazard-only Gesture. Hazard depth follows the repeating cycle `1 → 2 → 3 → 2`, with hazards on the opposite edge preserving a moving two-lane safe corridor. Longer runs continue the cycle through the shared trough, and mirroring reverses each generated row.
_Avoid_: Per-song row templates, copied mirror tables

Canonical five-row example:

- `20022 → 22002 → 22200 → 22002 → 20022`

**Density Fill**:
A rule-generated Gate Row between two measured musical anchors. Solid fill repeats the safe bridge densely enough for adjacent cubes to form a continuous wall; compact fill evenly reduces the gap. M and Full-width Drum Sweep slots never receive fill rows.

## Invariants

- A gameplay row contributes at most one Combo step, regardless of its number of cells.
- Hazards resolve before targets within the same row.
- Every displayed Target Cell in a Route Branch belongs to at least one complete Combo route.
- A declared M Gesture is six uninterrupted visible rows backed by the literal ten-slot template, not a metadata-only summary.
- Every sufficiently long peak section contains a forced Full-width Drum Sweep and has no full-Combo route confined to lanes 1–3.
- A long chart contains Wave Gates in both directions, with at least one spliced run.
- Density Fill never narrows the contiguous safe bridge between its two measured anchors.
- A canonical repeated phrase preserves its ordered rows and Route Branches across occurrences.
- Musical anchors remain at measured audio times; Density Fill is interpolated only between two unchanged anchors.
