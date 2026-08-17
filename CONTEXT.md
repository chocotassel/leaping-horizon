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

**Musical Anchor**:
A measured audio moment that is eligible to carry a gameplay action because one or more perceptual signals support it.
_Avoid_: Grid tick, interpolated row

**Attack Event**:
A measured percussion strike, pitched-note onset, syllabic onset, or salient melodic articulation that the player can perform as a Target Cell.
_Avoid_: Beat subdivision, decorative pulse

**Melodic Trace**:
A locally pitch-ordered sequence of Attack Events whose lane contour preserves rises, falls, repetitions, and turns in a sung or played phrase.
_Avoid_: Global pitch scale, arbitrary lane wave

**Performance Score**:
The evidence-grounded sequence of Attack Events and Melodic Traces that is authoritative for Target Cell timing, lane intent, and hit voice.
_Avoid_: Obstacle layout, Director Score

**Hit Voice**:
A short, event-specific sound that completes an Attack Event when its Target Cell is struck, using the event's pitch and source character without masking the song.
_Avoid_: Universal click, background soundtrack

**Phrase Identity**:
A recurring musical or lyrical idea whose occurrences share one canonical Kinetic Form, possibly with an explicit development policy.
_Avoid_: Fixed eight-bar window, equal-duration clip

**Directed Moment**:
A Musical Anchor whose musical function calls for an observable player or visual response, such as impact, arrival, rupture, release, or breath.
_Avoid_: Every beat, arbitrary accent

**Narrative Turn**:
A high-salience Directed Moment where the song changes musical or emotional state rather than merely continuing its current phrase.
_Avoid_: Any downbeat, average-energy boundary

**Kinetic Form**:
The lane-independent movement, pressure, branching, and rest contour assigned to a Phrase Identity before five-lane realization.
_Avoid_: Fixed obstacle template, named Gesture quota

**Color Scene**:
A sustained visual state associated with a musical scene; it changes only at a supported Narrative Turn and remains stable through ordinary accents.
_Avoid_: Drum flash, per-beat palette swap

**Visual Accent**:
A brief brightness or motion impulse tied to a strong Musical Anchor without replacing the current Color Scene.
_Avoid_: Color Scene change

**Director Score**:
The evidence-grounded account of Phrase Identities, Directed Moments, Kinetic Forms, and Color Scenes that a chart compiler realizes.
_Avoid_: Level event list, lane template

**Realization Receipt**:
The proof that maps each required Directed Moment and Phrase Identity contract to the emitted gameplay and visual events.
_Avoid_: Generator summary without event references

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
A rule-generated guide between two Musical Anchors that preserves their safe bridge without claiming to be a musical action or contributing Combo.
_Avoid_: Musical Anchor, extra beat

## Invariants

- A gameplay row contributes at most one Combo step, regardless of its number of cells.
- Hazards resolve before targets within the same row.
- Every displayed Target Cell in a Route Branch belongs to at least one complete Combo route.
- A declared M Gesture is six uninterrupted visible rows backed by the literal ten-slot template, not a metadata-only summary.
- A named Gesture is emitted only when a Directed Moment or Kinetic Form supports it; song length never creates a Gesture quota.
- Every required Directed Moment has an observable realization in movement, density, threat, branching, rest, or visual state.
- A Color Scene changes only at a supported Narrative Turn; ordinary strong Musical Anchors use Visual Accents.
- Density Fill never narrows the contiguous safe bridge between its two measured anchors.
- Density Fill does not contribute Combo and is never reported as a Musical Anchor.
- A canonical Phrase Identity preserves its Kinetic Form and Route Branch topology across occurrences unless its development policy explicitly permits variation.
- Musical anchors remain at measured audio times; Density Fill is interpolated only between two unchanged anchors.
- Every core Target Cell realizes a measured Attack Event; the Director may shape surrounding threat but cannot invent, move, or replace its performance time or lane intent.
- A Melodic Trace preserves local pitch order across lanes, including repeated notes and pitch turns, rather than quantizing the phrase to a beat template.
- Beat, percussion, pitched-note, syllabic, and melodic-articulation evidence may coincide in one Attack Event but never create duplicate simultaneous rows.
- A Hit Voice derives from its Attack Event and remains subordinate to the recorded song.
- Repetition quality reports both agreement and coverage; an empty set of detected repeats is never a perfect result.
