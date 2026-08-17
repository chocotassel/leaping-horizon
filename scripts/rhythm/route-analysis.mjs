const TARGET = 1;
const HAZARD = 2;
const DEFAULT_LANE_COUNT = 5;
const LITERAL_M_ROWS = ['00222', '00001', '22200', '00001', '00222', '00001'];

function clampInteger(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.floor(Number(value))));
}

function lanesMatching(row, predicate) {
  return row.flatMap((cell, lane) => predicate(cell) ? [lane] : []);
}

function rowLanes(event, requireCombo) {
  const row = Array.isArray(event?.obstacles) ? event.obstacles : [];
  const targets = lanesMatching(row, (cell) => cell === TARGET);
  if (requireCombo && targets.length) return targets;
  return lanesMatching(row, (cell) => cell !== HAZARD);
}

function maximumLaneSteps(fromTime, toTime, secondsPerLane, laneCount) {
  return clampInteger((toTime - fromTime + 1e-6) / secondsPerLane, 0, laneCount - 1);
}

function mirrorRows(rows) {
  return rows.map((row) => [...row].reverse().join(''));
}

function rowToken(event) {
  return Array.isArray(event?.obstacles) ? event.obstacles.join('') : '';
}

/**
 * Find literal, uninterrupted M gestures in the rows the player will actually see.
 * Generator summaries are deliberately ignored: an inserted overlay makes the
 * six-row window stop matching.
 */
export function findLiteralMGestures(events) {
  const rows = Array.isArray(events) ? events : [];
  const variants = [
    { orientation: 'identity', rows: LITERAL_M_ROWS },
    { orientation: 'mirror', rows: mirrorRows(LITERAL_M_ROWS) },
  ];
  const gestures = [];

  for (let startIndex = 0; startIndex <= rows.length - LITERAL_M_ROWS.length; startIndex += 1) {
    const window = rows.slice(startIndex, startIndex + LITERAL_M_ROWS.length);
    const variant = variants.find((candidate) => candidate.rows.every((token, offset) => (
      rowToken(window[offset]) === token
    )));
    if (!variant) continue;
    if (!window.every((event) => event?.layer === 'core' && event?.pattern === 'm')) continue;
    if (!window.every((event, offset) => event?.kind === (offset % 2 === 0 ? 'dodge' : 'target'))) continue;
    gestures.push({
      startIndex,
      endIndex: startIndex + LITERAL_M_ROWS.length - 1,
      startSeconds: Number(window[0].timeSeconds),
      endSeconds: Number(window.at(-1).timeSeconds),
      orientation: variant.orientation,
      rows: [...variant.rows],
    });
    startIndex += LITERAL_M_ROWS.length - 1;
  }
  return gestures;
}

export function chooseMGesturePlacement(candidates, desiredMirror, desiredBar) {
  return [...candidates].sort((left, right) => (
    Number(left.mirror !== desiredMirror) - Number(right.mirror !== desiredMirror)
    || left.rolePenalty - right.rolePenalty
    || Math.abs(left.candidateBar - desiredBar) - Math.abs(right.candidateBar - desiredBar)
    || left.span - right.span
  ))[0] ?? null;
}

/**
 * Analyse the complete route graph without choosing a preferred player path.
 * Every returned time and lane comes directly from the supplied event rows.
 */
export function analyzeRouteGraph(events, {
  startLane = 2,
  startTime = 0,
  secondsPerLane = 0.23,
  laneCount = DEFAULT_LANE_COUNT,
  requireCombo = true,
  pathCountCap = 1_000_000_000,
  consecutiveGapSeconds = 0.6,
} = {}) {
  const rows = Array.isArray(events) ? events : [];
  if (!rows.length) {
    return {
      feasible: true,
      referenceRoute: [],
      allowedLanesByRow: [],
      globallyViableLanesByRow: [],
      globallyViableTransitionsByRow: [],
      pathCountCapped: 1,
      choiceRowCount: 0,
      multiTargetChoiceRowCount: 0,
      meaningfulChoiceRows: [],
      deadChoiceCells: [],
      deadAllowedCells: [],
      wideChoiceRowCount: 0,
      consecutiveChoicePairs: [],
      maximumConsecutiveChoiceRows: 0,
    };
  }

  const allowedByRow = rows.map((event) => rowLanes(event, requireCombo));
  const forwardCounts = [];
  let priorCounts = new Map([[startLane, 1]]);
  let priorTime = startTime;
  for (let index = 0; index < rows.length; index += 1) {
    const steps = maximumLaneSteps(
      priorTime,
      Number(rows[index]?.timeSeconds),
      secondsPerLane,
      laneCount,
    );
    const counts = new Map();
    for (const lane of allowedByRow[index]) {
      let count = 0;
      for (const [priorLane, priorCount] of priorCounts) {
        if (Math.abs(lane - priorLane) <= steps) count = Math.min(pathCountCap, count + priorCount);
      }
      if (count > 0) counts.set(lane, count);
    }
    forwardCounts.push(counts);
    priorCounts = counts;
    priorTime = Number(rows[index]?.timeSeconds);
  }

  const backward = Array.from({ length: rows.length }, () => new Set());
  backward[rows.length - 1] = new Set(allowedByRow[rows.length - 1]);
  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const steps = maximumLaneSteps(
      Number(rows[index]?.timeSeconds),
      Number(rows[index + 1]?.timeSeconds),
      secondsPerLane,
      laneCount,
    );
    backward[index] = new Set(allowedByRow[index].filter((lane) => (
      [...backward[index + 1]].some((nextLane) => Math.abs(lane - nextLane) <= steps)
    )));
  }

  const globallyViableLanesByRow = rows.map((_, index) => (
    [...forwardCounts[index].keys()].filter((lane) => backward[index].has(lane))
  ));
  const globallyViableTransitionsByRow = rows.map(() => []);
  for (let index = 1; index < rows.length; index += 1) {
    const steps = maximumLaneSteps(
      Number(rows[index - 1]?.timeSeconds),
      Number(rows[index]?.timeSeconds),
      secondsPerLane,
      laneCount,
    );
    for (const fromLane of globallyViableLanesByRow[index - 1]) {
      for (const toLane of globallyViableLanesByRow[index]) {
        if (Math.abs(toLane - fromLane) <= steps) {
          globallyViableTransitionsByRow[index].push({ fromLane, toLane });
        }
      }
    }
  }
  const meaningfulChoiceRows = [];
  const deadChoiceCells = [];
  const deadAllowedCells = [];
  let choiceRowCount = 0;
  let multiTargetChoiceRowCount = 0;
  let wideChoiceRowCount = 0;
  let maximumConsecutiveChoiceRows = 0;
  let currentConsecutiveChoiceRows = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const targetLanes = lanesMatching(rows[index].obstacles ?? [], (cell) => cell === TARGET);
    for (const lane of allowedByRow[index].filter((candidate) => (
      !globallyViableLanesByRow[index].includes(candidate)
    ))) {
      deadAllowedCells.push({ rowIndex: index, lane });
    }
    if (!targetLanes.length) {
      currentConsecutiveChoiceRows = 0;
      continue;
    }
    choiceRowCount += 1;
    const viableTargets = targetLanes.filter((lane) => globallyViableLanesByRow[index].includes(lane));
    for (const lane of targetLanes.filter((lane) => !viableTargets.includes(lane))) {
      deadChoiceCells.push({ rowIndex: index, lane });
    }
    if (targetLanes.length >= 2) multiTargetChoiceRowCount += 1;
    if (viableTargets.length >= 2) {
      meaningfulChoiceRows.push(index);
      currentConsecutiveChoiceRows += 1;
      maximumConsecutiveChoiceRows = Math.max(
        maximumConsecutiveChoiceRows,
        currentConsecutiveChoiceRows,
      );
      if (Math.max(...viableTargets) - Math.min(...viableTargets) >= 2) wideChoiceRowCount += 1;
    } else {
      currentConsecutiveChoiceRows = 0;
    }
  }

  const meaningfulChoiceRowSet = new Set(meaningfulChoiceRows);
  const consecutiveChoicePairs = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (
      meaningfulChoiceRowSet.has(index - 1)
      && meaningfulChoiceRowSet.has(index)
      && Number(rows[index].timeSeconds) - Number(rows[index - 1].timeSeconds) <= consecutiveGapSeconds
    ) {
      consecutiveChoicePairs.push({
        firstRowIndex: index - 1,
        secondRowIndex: index,
        gapSeconds: Number((rows[index].timeSeconds - rows[index - 1].timeSeconds).toFixed(5)),
      });
    }
  }

  const pathCountCapped = [...(forwardCounts.at(-1)?.values() ?? [])]
    .reduce((sum, count) => Math.min(pathCountCap, sum + count), 0);
  const feasible = globallyViableLanesByRow.every((lanes) => lanes.length > 0);
  const referenceRoute = [];
  if (feasible) {
    let nextLane = globallyViableLanesByRow.at(-1)[0];
    referenceRoute[rows.length - 1] = nextLane;
    for (let index = rows.length - 2; index >= 0; index -= 1) {
      const targetNextLane = nextLane;
      const steps = maximumLaneSteps(
        Number(rows[index]?.timeSeconds),
        Number(rows[index + 1]?.timeSeconds),
        secondsPerLane,
        laneCount,
      );
      nextLane = globallyViableLanesByRow[index]
        .filter((lane) => Math.abs(lane - targetNextLane) <= steps)
        .sort((left, right) => (
          Math.abs(left - targetNextLane) - Math.abs(right - targetNextLane) || left - right
        ))[0];
      referenceRoute[index] = nextLane;
    }
  }

  return {
    feasible,
    referenceRoute,
    allowedLanesByRow: allowedByRow,
    globallyViableLanesByRow,
    globallyViableTransitionsByRow,
    pathCountCapped,
    choiceRowCount,
    multiTargetChoiceRowCount,
    meaningfulChoiceRows,
    deadChoiceCells,
    deadAllowedCells,
    wideChoiceRowCount,
    consecutiveChoicePairs,
    maximumConsecutiveChoiceRows,
  };
}

function pathExistsBetween(routeGraph, startIndex, startLane, endIndex, endLane) {
  let reachable = new Set([startLane]);
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const transitions = routeGraph.globallyViableTransitionsByRow?.[index] ?? [];
    reachable = new Set(transitions.flatMap(({ fromLane, toLane }) => (
      reachable.has(fromLane) ? [toLane] : []
    )));
    if (!reachable.size) return false;
  }
  return reachable.has(endLane);
}

/**
 * Measure forced full-width strokes inside one musical window using the complete
 * globally viable route graph. A row is an endpoint only when every full-combo
 * route must hit the same edge target, so optional edge notes cannot disguise a
 * chart that is still playable by micro-moving in the middle lanes.
 */
export function analyzeEdgeSweepWindow(events, routeGraph, {
  startSeconds = Number.NEGATIVE_INFINITY,
  endSeconds = Number.POSITIVE_INFINITY,
  maxStrokeSeconds = Number.POSITIVE_INFINITY,
  laneCount = DEFAULT_LANE_COUNT,
} = {}) {
  const rows = Array.isArray(events) ? events : [];
  const windowIndices = rows.flatMap((event, index) => {
    const timeSeconds = Number(event?.timeSeconds);
    return timeSeconds >= startSeconds && timeSeconds < endSeconds ? [index] : [];
  });
  if (!windowIndices.length) {
    return {
      firstRowIndex: null,
      lastRowIndex: null,
      forcedEdgeRows: [],
      edgeToEdgeStrokes: [],
      alternatingRuns: [],
      maximumAlternatingEdgeHits: 0,
      maximumAlternatingEdgeStrokeCount: 0,
      centerOnlyRouteExists: false,
    };
  }

  const firstRowIndex = windowIndices[0];
  const lastRowIndex = windowIndices.at(-1);
  const centerLanes = new Set(Array.from({ length: Math.max(0, laneCount - 2) }, (_, index) => index + 1));
  let centerReachable = new Set(
    (routeGraph.globallyViableLanesByRow?.[firstRowIndex] ?? []).filter((lane) => centerLanes.has(lane)),
  );
  for (let index = firstRowIndex + 1; index <= lastRowIndex && centerReachable.size; index += 1) {
    const transitions = routeGraph.globallyViableTransitionsByRow?.[index] ?? [];
    centerReachable = new Set(transitions.flatMap(({ fromLane, toLane }) => (
      centerReachable.has(fromLane) && centerLanes.has(toLane) ? [toLane] : []
    )));
  }

  const edgeLanes = new Set([0, laneCount - 1]);
  const forcedEdgeRows = windowIndices.flatMap((rowIndex) => {
    const viable = routeGraph.globallyViableLanesByRow?.[rowIndex] ?? [];
    if (viable.length !== 1 || !edgeLanes.has(viable[0])) return [];
    const lane = viable[0];
    if (rows[rowIndex]?.obstacles?.[lane] !== TARGET) return [];
    return [{ rowIndex, lane, timeSeconds: Number(rows[rowIndex].timeSeconds) }];
  });

  const alternatingRuns = [];
  let currentRun = [];
  for (const endpoint of forcedEdgeRows) {
    const previous = currentRun.at(-1);
    if (previous?.lane === endpoint.lane) {
      if (currentRun.length === 1) {
        currentRun[0] = endpoint;
        continue;
      }
      const oppositeEndpoint = currentRun.at(-2);
      const replacementDuration = endpoint.timeSeconds - oppositeEndpoint.timeSeconds;
      if (
        replacementDuration <= maxStrokeSeconds
        && pathExistsBetween(
          routeGraph,
          oppositeEndpoint.rowIndex,
          oppositeEndpoint.lane,
          endpoint.rowIndex,
          endpoint.lane,
        )
      ) {
        currentRun[currentRun.length - 1] = endpoint;
        continue;
      }
      alternatingRuns.push(currentRun);
      currentRun = [endpoint];
      continue;
    }
    const durationSeconds = previous ? endpoint.timeSeconds - previous.timeSeconds : 0;
    const continues = previous
      && durationSeconds <= maxStrokeSeconds
      && pathExistsBetween(
        routeGraph,
        previous.rowIndex,
        previous.lane,
        endpoint.rowIndex,
        endpoint.lane,
    );
    if (continues) {
      currentRun.push(endpoint);
    } else {
      if (currentRun.length >= 2) alternatingRuns.push(currentRun);
      currentRun = [endpoint];
    }
  }
  if (currentRun.length >= 2) alternatingRuns.push(currentRun);
  const edgeToEdgeStrokes = alternatingRuns.flatMap((run) => run.slice(1).map((endpoint, index) => {
    const previous = run[index];
    return {
      fromRowIndex: previous.rowIndex,
      toRowIndex: endpoint.rowIndex,
      fromLane: previous.lane,
      toLane: endpoint.lane,
      durationSeconds: Number((endpoint.timeSeconds - previous.timeSeconds).toFixed(5)),
    };
  }));
  const maximumAlternatingEdgeHits = alternatingRuns.reduce(
    (maximum, run) => Math.max(maximum, run.length),
    forcedEdgeRows.length ? 1 : 0,
  );

  return {
    firstRowIndex,
    lastRowIndex,
    forcedEdgeRows,
    edgeToEdgeStrokes,
    alternatingRuns,
    maximumAlternatingEdgeHits,
    maximumAlternatingEdgeStrokeCount: Math.max(0, maximumAlternatingEdgeHits - 1),
    centerOnlyRouteExists: centerReachable.size > 0,
  };
}
