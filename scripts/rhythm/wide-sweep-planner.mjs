const PEAK_ROLE = 'peak';
const DRIVING_ROLES = new Set(['build', 'drive']);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function sumCapacity(mobility, fromExclusive, toInclusive) {
  let total = 0;
  for (let index = fromExclusive + 1; index <= toInclusive; index += 1) {
    total += Math.max(0, Math.floor(Number(mobility[index]) || 0));
  }
  return total;
}

function isStrongSlot(slot) {
  if (!slot || slot.blocked) return false;
  const score = Number(slot.score) || 0;
  if (slot.sectionRole === PEAK_ROLE) return true;
  if (DRIVING_ROLES.has(slot.sectionRole)) return score >= 0.62;
  return score >= 0.82;
}

function collectStrongRuns(slots) {
  const runs = [];
  let start = null;
  // Preserve the canonical centre entry and exit rows. They keep phrase-family
  // templates composable even when consecutive occurrences have different
  // measured timing.
  for (let index = 1; index < slots.length - 1; index += 1) {
    if (isStrongSlot(slots[index])) {
      if (start === null) start = index;
      continue;
    }
    if (start !== null) runs.push({ start, end: index - 1 });
    start = null;
  }
  if (start !== null) runs.push({ start, end: slots.length - 2 });
  return runs;
}

function transitionTimes(slots, fromSlot, toSlot) {
  const fromTimes = slots[fromSlot]?.timeSecondsByOccurrence ?? [];
  const toTimes = slots[toSlot]?.timeSecondsByOccurrence ?? [];
  if (!fromTimes.length || fromTimes.length !== toTimes.length) return [];
  return fromTimes.map((time, index) => Number(toTimes[index]) - Number(time));
}

function isTimedEdgeTransition(slots, mobility, fromSlot, toSlot, distance, maximumSeconds) {
  if (sumCapacity(mobility, fromSlot, toSlot) < distance) return false;
  const elapsed = transitionTimes(slots, fromSlot, toSlot);
  return elapsed.length > 0 && elapsed.every((seconds) => (
    Number.isFinite(seconds)
    && seconds > 0
    && seconds <= maximumSeconds + 1e-6
  ));
}

function entryWindowStart(slots, mobility, runStart, anchorSlot, anchorLane) {
  for (let startSlot = anchorSlot; startSlot >= runStart; startSlot -= 1) {
    const entrySlot = startSlot - 1;
    const entryLane = slots[entrySlot]?.baseLane;
    if (!Number.isInteger(entryLane)) continue;
    if (sumCapacity(mobility, entrySlot, anchorSlot) >= Math.abs(anchorLane - entryLane)) {
      return { startSlot, entrySlot, entryLane };
    }
  }
  return null;
}

function exitWindowEnd(slots, mobility, runEnd, anchorSlot, anchorLane) {
  for (let endSlot = anchorSlot; endSlot <= runEnd; endSlot += 1) {
    const exitSlot = endSlot + 1;
    const exitLane = slots[exitSlot]?.baseLane;
    if (!Number.isInteger(exitLane)) continue;
    if (sumCapacity(mobility, anchorSlot, exitSlot) >= Math.abs(exitLane - anchorLane)) {
      return { endSlot, exitSlot, exitLane };
    }
  }
  return null;
}

function fitLaneSegment(path, mobility, laneCount, fromSlot, fromLane, toSlot, toLane) {
  const totalCapacity = sumCapacity(mobility, fromSlot, toSlot);
  if (totalCapacity < Math.abs(toLane - fromLane)) return false;
  let currentLane = fromLane;
  let elapsedCapacity = 0;
  for (let slotIndex = fromSlot + 1; slotIndex <= toSlot; slotIndex += 1) {
    const capacity = Math.max(0, Math.floor(Number(mobility[slotIndex]) || 0));
    elapsedCapacity += capacity;
    const remainingCapacity = sumCapacity(mobility, slotIndex, toSlot);
    const minimum = Math.max(0, currentLane - capacity, toLane - remainingCapacity);
    const maximum = Math.min(laneCount - 1, currentLane + capacity, toLane + remainingCapacity);
    if (minimum > maximum) return false;
    const progress = totalCapacity > 0 ? elapsedCapacity / totalCapacity : 1;
    const desired = Math.round(fromLane + (toLane - fromLane) * progress);
    currentLane = clamp(desired, minimum, maximum);
    path[slotIndex] = currentLane;
  }
  return currentLane === toLane;
}

function buildGuidePath(candidate, slots, mobility, laneCount) {
  const path = Array.from({ length: slots.length }, () => null);
  const fixedPoints = [
    { slot: candidate.entrySlot, lane: candidate.entryLane },
    ...candidate.anchorSlots.map((slot, index) => ({ slot, lane: candidate.anchorLanes[index] })),
    { slot: candidate.exitSlot, lane: candidate.exitLane },
  ];
  for (let index = 1; index < fixedPoints.length; index += 1) {
    const previous = fixedPoints[index - 1];
    const next = fixedPoints[index];
    path[previous.slot] = previous.lane;
    if (!fitLaneSegment(
      path,
      mobility,
      laneCount,
      previous.slot,
      previous.lane,
      next.slot,
      next.lane,
    )) return null;
  }
  return path;
}

function candidateScore(candidate, slots, preferredFirstEdge) {
  const downbeats = candidate.anchorSlots.filter((slot) => slots[slot].beatInBar === 0).length;
  const strength = candidate.anchorSlots.reduce((sum, slot) => sum + (Number(slots[slot].score) || 0), 0);
  const peakHits = candidate.anchorSlots.filter((slot) => slots[slot].sectionRole === PEAK_ROLE).length;
  const preferredOrientation = candidate.anchorLanes[0] === preferredFirstEdge ? 1 : 0;
  const travelSpan = candidate.anchorSlots.at(-1) - candidate.anchorSlots[0];
  return downbeats * 100 + peakHits * 20 + strength * 4 + preferredOrientation - travelSpan * 0.01;
}

function candidatesForRun({
  run,
  slots,
  mobility,
  laneCount,
  maximumTransitionSeconds,
  preferredFirstEdge,
}) {
  const candidates = [];
  const edgeDistance = laneCount - 1;
  for (const firstEdge of [0, laneCount - 1]) {
    const anchorLanes = [firstEdge, laneCount - 1 - firstEdge, firstEdge];
    for (let first = run.start; first <= run.end - 2; first += 1) {
      for (let second = first + 1; second <= run.end - 1; second += 1) {
        if (!isTimedEdgeTransition(
          slots,
          mobility,
          first,
          second,
          edgeDistance,
          maximumTransitionSeconds,
        )) continue;
        for (let third = second + 1; third <= run.end; third += 1) {
          if (!isTimedEdgeTransition(
            slots,
            mobility,
            second,
            third,
            edgeDistance,
            maximumTransitionSeconds,
          )) continue;
          const entry = entryWindowStart(slots, mobility, run.start, first, firstEdge);
          const exit = exitWindowEnd(slots, mobility, run.end, third, firstEdge);
          if (!entry || !exit) continue;
          const candidate = {
            ...entry,
            ...exit,
            anchorSlots: [first, second, third],
            anchorLanes,
          };
          const guidePath = buildGuidePath(candidate, slots, mobility, laneCount);
          if (!guidePath) continue;
          candidate.guidePath = guidePath;
          candidate.score = candidateScore(candidate, slots, preferredFirstEdge);
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

/**
 * Plans recognisable edge-to-edge drum gestures without moving a single audio
 * timestamp. Edge hits are fixed Choice Rows; intervening measured beats become
 * Gate Rows whose safe corridor follows a capacity-checked guide path.
 */
export function planFullWidthSweeps({
  slots = [],
  mobility = [],
  laneCount = 5,
  secondsPerBeat = 0.5,
  orientationSeed = 0,
  maximumGestures = 1,
} = {}) {
  const slotPlans = Array.from({ length: slots.length }, () => null);
  if (slots.length < 3 || mobility.length !== slots.length) return { gestures: [], slotPlans };

  const maximumTransitionSeconds = Math.max(0.1, Number(secondsPerBeat) || 0.5) * 8;
  const preferredFirstEdge = Number(orientationSeed) < 0.5 ? 0 : laneCount - 1;
  const runs = collectStrongRuns(slots).sort((left, right) => {
    const peakScore = (run) => slots.slice(run.start, run.end + 1)
      .filter((slot) => slot.sectionRole === PEAK_ROLE).length;
    const averageScore = (run) => slots.slice(run.start, run.end + 1)
      .reduce((sum, slot) => sum + (Number(slot.score) || 0), 0) / (run.end - run.start + 1);
    return peakScore(right) - peakScore(left)
      || averageScore(right) - averageScore(left)
      || left.start - right.start;
  });

  const gestures = [];
  for (const run of runs) {
    if (gestures.length >= maximumGestures) break;
    const candidates = candidatesForRun({
      run,
      slots,
      mobility,
      laneCount,
      maximumTransitionSeconds,
      preferredFirstEdge,
    }).sort((left, right) => right.score - left.score || left.startSlot - right.startSlot);
    const selected = candidates.find((candidate) => (
      slotPlans.slice(candidate.startSlot, candidate.endSlot + 1).every((plan) => plan === null)
    ));
    if (!selected) continue;

    const gestureIndex = gestures.length;
    const gestureId = `full-width-sweep-${gestureIndex + 1}`;
    const anchorBySlot = new Map(selected.anchorSlots.map((slot, index) => [slot, index]));
    for (let slotIndex = selected.startSlot; slotIndex <= selected.endSlot; slotIndex += 1) {
      const anchorIndex = anchorBySlot.get(slotIndex);
      slotPlans[slotIndex] = {
        gestureId,
        kind: anchorIndex === undefined ? 'travel-gate' : 'edge-target',
        lane: selected.guidePath[slotIndex],
        anchorIndex: anchorIndex ?? null,
      };
    }
    gestures.push({
      id: gestureId,
      startSlot: selected.startSlot,
      endSlot: selected.endSlot,
      anchorSlots: selected.anchorSlots,
      anchorLanes: selected.anchorLanes,
      edgeToEdgeTransitionCount: selected.anchorSlots.length - 1,
      sectionRole: selected.anchorSlots.some((slot) => slots[slot].sectionRole === PEAK_ROLE)
        ? PEAK_ROLE
        : slots[selected.anchorSlots[0]].sectionRole,
      score: Number((selected.score / 100).toFixed(3)),
      anchorTimesByOccurrence: slots[selected.anchorSlots[0]].timeSecondsByOccurrence.map((_, occurrenceIndex) => (
        selected.anchorSlots.map((slot) => Number(slots[slot].timeSecondsByOccurrence[occurrenceIndex].toFixed(5)))
      )),
    });
  }

  return { gestures, slotPlans };
}
