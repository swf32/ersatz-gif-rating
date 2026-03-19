const params = new URLSearchParams(window.location.search);
const configUrl = params.get("config");
const mode = params.get("mode") ?? "animate";
const isPreviewMode = mode === "preview";
const isFrameMode = mode === "frames";
const autostart = params.get("autostart") !== "0";
const captureScale = Number(params.get("scale") ?? "1");
const naturalWidth = Number(params.get("natural-width") ?? "0");
const naturalHeight = Number(params.get("natural-height") ?? "0");
const queryFps = parseIntegerParam("fps");
const queryIdleBeforeMs = parseIntegerParam("idle-before-ms");
const queryIdleAfterMs = parseIntegerParam("idle-after-ms");
const queryRowAnimationFrames = parseIntegerParam("row-animation-frames");
const queryRowStaggerFrames = parseIntegerParam("row-stagger-frames");
const queryHeadline = readOptionalParam("headline");
const querySubtitle = readOptionalParam("subtitle");
const queryLocale = readOptionalParam("locale");

let releaseStart;
const startSignal = new Promise((resolve) => {
  releaseStart = resolve;
});

window.__LEADERBOARD_APP__ = {
  ready: false,
  finished: false,
  started: false,
  timeline: null,
  measuredMetrics: null,
  collectLayoutMetrics,
  renderFrame() {
    throw new Error("Frame renderer is not ready.");
  },
  start() {
    if (this.started) {
      return false;
    }
    this.started = true;
    releaseStart();
    return true;
  }
};

boot().catch((error) => {
  const board = document.getElementById("board");
  const headline = document.getElementById("headline");
  const subtitle = document.getElementById("subtitle");

  headline.textContent = "Не удалось отрендерить рейтинг";
  subtitle.textContent = error instanceof Error ? error.message : String(error);
  subtitle.hidden = false;
  board.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "Проверьте путь до JSON-конфига и структуру входных данных.";
  board.append(empty);
  window.__LEADERBOARD_APP__.ready = true;
  window.__LEADERBOARD_APP__.finished = true;
  console.error(error);
});

async function boot() {
  if (!configUrl) {
    throw new Error("Query parameter 'config' is required.");
  }

  const config = await loadConfig(configUrl);
  applyCaptureScale();
  renderStaticShell(config);

  if (mode === "measure") {
    window.__LEADERBOARD_APP__.measuredMetrics = await measureBoardLayouts(config);
    window.__LEADERBOARD_APP__.ready = true;
    window.__LEADERBOARD_APP__.finished = true;
    return;
  }

  if (isFrameMode) {
    const boardState = await renderBoardState(config, "before");
    const renderer = createTimelineRenderer(boardState, config.settings);
    window.__LEADERBOARD_APP__.timeline = renderer.timeline;
    window.__LEADERBOARD_APP__.renderFrame = (elapsedMs) => {
      const timelineMs = Number.isFinite(elapsedMs) ? Number(elapsedMs) : 0;
      renderer.render(timelineMs);
      window.__LEADERBOARD_APP__.finished = timelineMs >= renderer.timeline.totalDurationMs;
    };
    window.__LEADERBOARD_APP__.renderFrame(0);
    window.__LEADERBOARD_APP__.ready = true;
    return;
  }

  if (isPreviewMode) {
    const preview = createPreviewToolbar(config);
    window.__LEADERBOARD_APP__.replay = () => preview.run("animate");
    window.__LEADERBOARD_APP__.showBefore = () => preview.run("before");
    window.__LEADERBOARD_APP__.showAfter = () => preview.run("after");

    await renderBoardState(config, "before");
    window.__LEADERBOARD_APP__.ready = true;

    if (autostart) {
      await preview.run("animate");
    } else {
      window.__LEADERBOARD_APP__.finished = true;
    }
    return;
  }

  const boardState = await renderBoardState(config, "before");
  window.__LEADERBOARD_APP__.ready = true;

  if (autostart) {
    window.__LEADERBOARD_APP__.start();
  }

  await startSignal;
  window.__LEADERBOARD_APP__.timeline = await playTimelineAnimation(boardState, config.settings);
  window.__LEADERBOARD_APP__.finished = true;
}

async function loadConfig(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load config: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  return normalizeIncomingConfig(payload);
}

function normalizeIncomingConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config JSON must be an object.");
  }

  const settingsRaw = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const settings = {
    fps: readPositiveInteger(queryFps, settingsRaw.fps, 60),
    idle_before_ms: readPositiveInteger(queryIdleBeforeMs, settingsRaw.idle_before_ms, 1000),
    idle_after_ms: readPositiveInteger(queryIdleAfterMs, settingsRaw.idle_after_ms, 1000),
    row_animation_frames: readPositiveInteger(
      queryRowAnimationFrames,
      settingsRaw.row_animation_frames,
      26
    ),
    row_stagger_frames: readPositiveInteger(
      queryRowStaggerFrames,
      settingsRaw.row_stagger_frames,
      10
    ),
    locale: queryLocale ?? asNonEmptyString(settingsRaw.locale) ?? "ru-RU"
  };

  const todayGains = normalizeTodayGains(raw.today_gains);
  const gainLookup = new Map(todayGains.map((item) => [item.username, item.gain]));
  const tiers = normalizeTiers(raw.tiers, gainLookup);
  const dateValue = asNonEmptyString(raw.date) ?? todayIsoDate();
  const headline = queryHeadline ?? asNonEmptyString(raw.headline) ?? defaultHeadline(dateValue);
  const subtitle =
    querySubtitle ??
    (typeof raw.subtitle === "string" ? raw.subtitle : "");

  return {
    date: dateValue,
    headline,
    subtitle,
    tiers,
    today_gains: todayGains,
    settings
  };
}

function normalizeTodayGains(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const username = asNonEmptyString(item.username);
      if (!username) {
        return null;
      }
      return {
        username,
        gain: Number(item.gain ?? 0)
      };
    })
    .filter(Boolean);
}

function normalizeTiers(rawTiers, gainLookup) {
  if (!rawTiers || typeof rawTiers !== "object" || Array.isArray(rawTiers)) {
    throw new Error("Field 'tiers' must be an object.");
  }

  return Object.fromEntries(
    Object.entries(rawTiers).map(([tierKey, members]) => {
      if (!Array.isArray(members)) {
        throw new Error(`Tier '${tierKey}' must contain an array of members.`);
      }

      return [
        tierKey,
        members.map((member, index) => normalizeMember(member, index, gainLookup, tierKey))
      ];
    })
  );
}

function normalizeMember(member, index, gainLookup, tierKey) {
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    throw new Error("Each tier member must be an object.");
  }

  const username = asNonEmptyString(member.username);
  if (!username) {
    throw new Error("Each tier member must include a username.");
  }

  const pointsYesterday = Number(member.points_yesterday ?? 0);
  const pointsCurrent = Number(member.points_current ?? 0);
  const tierYesterday = readTierReference(
    member.tier_yesterday,
    member.previous_tier,
    member.tier_from,
    tierKey
  );
  const tierCurrent = readTierReference(
    member.tier_current,
    member.current_tier,
    member.tier_to,
    tierKey
  );

  return {
    username,
    points_yesterday: pointsYesterday,
    points_current: pointsCurrent,
    gain: Number(member.gain ?? gainLookup.get(username) ?? (pointsCurrent - pointsYesterday)),
    original_index: Number(member.original_index ?? index),
    tier_yesterday: tierYesterday,
    tier_current: tierCurrent
  };
}

function readTierReference(...candidates) {
  for (const candidate of candidates) {
    const value = asNonEmptyString(candidate);
    if (value) {
      return value;
    }
  }
  return "tier_1";
}

function applyCaptureScale() {
  if (!Number.isFinite(captureScale) || captureScale >= 0.999 || !naturalWidth || !naturalHeight) {
    return;
  }

  const frame = document.getElementById("capture-frame");
  frame.style.width = `${naturalWidth}px`;
  frame.style.height = `${naturalHeight}px`;
  frame.style.transform = `scale(${captureScale})`;

  document.body.style.width = `${Math.ceil(naturalWidth * captureScale)}px`;
  document.body.style.minHeight = `${Math.ceil(naturalHeight * captureScale)}px`;
}

function renderStaticShell(config) {
  const headline = document.getElementById("headline");
  const subtitle = document.getElementById("subtitle");

  headline.textContent = config.headline ?? "Таблица лидеров";
  subtitle.textContent = config.subtitle ?? "";
  subtitle.hidden = subtitle.textContent.trim() === "";
}

function createPreviewToolbar(config) {
  const header = document.querySelector(".page-header");
  const toolbar = document.createElement("section");
  toolbar.className = "preview-toolbar";

  const title = document.createElement("p");
  title.className = "preview-label";
  title.textContent = "Preview mode";

  const meta = document.createElement("p");
  meta.className = "preview-meta";
  meta.textContent = `Источник данных: ${humanizeConfigPath(configUrl)}`;

  const actions = document.createElement("div");
  actions.className = "preview-actions";

  const replayButton = createPreviewButton("Повторить анимацию");
  const beforeButton = createPreviewButton("Показать вчера");
  const afterButton = createPreviewButton("Показать итог");
  const status = document.createElement("p");
  status.className = "preview-status";
  status.setAttribute("aria-live", "polite");
  status.textContent = buildTimelineLabel(getTimelineMetricsFromConfig(config));

  actions.append(replayButton, beforeButton, afterButton);
  toolbar.append(title, meta, actions, status);
  header.append(toolbar);

  const buttons = [replayButton, beforeButton, afterButton];
  let busy = false;

  const setBusy = (nextValue, label = "") => {
    busy = nextValue;
    buttons.forEach((button) => {
      button.disabled = nextValue;
    });

    if (nextValue) {
      status.textContent = label;
      return;
    }

    status.textContent = buildTimelineLabel(getTimelineMetricsFromConfig(config));
  };

  const run = async (targetState) => {
    if (busy) {
      return;
    }

    window.__LEADERBOARD_APP__.finished = false;

    try {
      if (targetState === "animate") {
        setBusy(true, "Играю анимацию перестановок...");
        await playConfiguredAnimation(config, true);
      } else if (targetState === "after") {
        setBusy(true, "Показываю финальный кадр.");
        await renderBoardState(config, "after");
      } else {
        setBusy(true, "Показываю исходный порядок.");
        await renderBoardState(config, "before");
      }
    } finally {
      setBusy(false);
      window.__LEADERBOARD_APP__.finished = true;
    }
  };

  replayButton.addEventListener("click", () => {
    void run("animate");
  });
  beforeButton.addEventListener("click", () => {
    void run("before");
  });
  afterButton.addEventListener("click", () => {
    void run("after");
  });

  return { run };
}

function createPreviewButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "preview-button";
  button.textContent = label;
  return button;
}

async function renderBoardState(config, state) {
  renderStaticShell(config);
  const boardState = renderBoard(config);
  await waitForFonts();
  await waitForPaint();

  if (state === "after") {
    renderFinalSnapshot(boardState);
    await waitForPaint();
  }

  return boardState;
}

async function measureBoardLayouts(config) {
  const beforeState = await renderBoardState(config, "before");
  const beforeMetrics = collectLayoutMetrics();
  renderFinalSnapshot(beforeState);
  await waitForPaint();
  const afterMetrics = collectLayoutMetrics();

  return {
    width: Math.max(beforeMetrics.width, afterMetrics.width),
    height: Math.max(beforeMetrics.height, afterMetrics.height)
  };
}

async function playConfiguredAnimation(config, holdFinalFrame) {
  const boardState = await renderBoardState(config, "before");
  const timeline = await playTimelineAnimation(boardState, config.settings);
  window.__LEADERBOARD_APP__.timeline = timeline;

  return boardState;
}

function buildSubtitle(config) {
  const date = formatDate(config.date, config.settings.locale);
  return `${date} · ${buildTimelineLabel(getTimelineMetricsFromConfig(config))}`;
}

function renderBoard(config) {
  const board = document.getElementById("board");
  board.innerHTML = "";
  resetAnimationOverlay();

  const boardModel = buildBoardModel(config);

  if (boardModel.tiers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Во входном JSON нет участников для отображения.";
    board.append(empty);
    return {
      controllers: [],
      rowsByUser: new Map(),
      membersByUser: new Map()
    };
  }

  const rowsByUser = new Map();
  for (const member of boardModel.membersByUser.values()) {
    rowsByUser.set(member.username, createMemberRow(member, member.currentRank || 999));
  }

  const controllers = boardModel.tiers.map((tier) => {
    const controller = createTierCard(tier, rowsByUser);
    board.append(controller.element);
    return controller;
  });

  return {
    controllers,
    rowsByUser,
    membersByUser: boardModel.membersByUser
  };
}

function buildBoardModel(config) {
  const rawMembers = Object.values(config.tiers ?? {}).flat();
  const baseMembersByUser = new Map();
  const tierKeys = new Set(Object.keys(config.tiers ?? {}));

  for (const [index, member] of rawMembers.entries()) {
    if (baseMembersByUser.has(member.username)) {
      throw new Error(
        `Username '${member.username}' is duplicated in tiers. Use one record with tier_yesterday/tier_current.`
      );
    }

    const normalizedMember = {
      username: String(member.username),
      pointsYesterday: Number(member.points_yesterday ?? 0),
      pointsCurrent: Number(member.points_current ?? 0),
      gain: Number(member.gain ?? (Number(member.points_current ?? 0) - Number(member.points_yesterday ?? 0))),
      originalIndex: Number(member.original_index ?? index),
      tierYesterday: member.tier_yesterday,
      tierCurrent: member.tier_current,
      numericTierYesterday: parseTierNumber(member.tier_yesterday),
      numericTierCurrent: parseTierNumber(member.tier_current)
    };
    baseMembersByUser.set(normalizedMember.username, normalizedMember);
    tierKeys.add(normalizedMember.tierYesterday);
    tierKeys.add(normalizedMember.tierCurrent);
  }

  const tierOrder = [...tierKeys]
    .filter(Boolean)
    .sort((left, right) => parseTierNumber(right) - parseTierNumber(left));

  const tierSnapshots = new Map(
    tierOrder.map((tierKey) => {
      const yesterdayMembers = [...baseMembersByUser.values()]
        .filter((member) => member.tierYesterday === tierKey)
        .sort(compareYesterday);
      const currentMembers = [...baseMembersByUser.values()]
        .filter((member) => member.tierCurrent === tierKey)
        .sort(compareCurrent);

      return [
        tierKey,
        {
          yesterdayMembers,
          currentMembers,
          yesterdayRankMap: new Map(yesterdayMembers.map((member, index) => [member.username, index + 1])),
          currentRankMap: new Map(currentMembers.map((member, index) => [member.username, index + 1]))
        }
      ];
    })
  );

  const membersByUser = new Map();
  for (const member of baseMembersByUser.values()) {
    const yesterdayRank =
      tierSnapshots.get(member.tierYesterday)?.yesterdayRankMap.get(member.username) ?? 0;
    const currentRank =
      tierSnapshots.get(member.tierCurrent)?.currentRankMap.get(member.username) ?? 0;
    const rankDelta =
      member.tierYesterday === member.tierCurrent ? currentRank - yesterdayRank : 0;
    const enrichedMember = {
      ...member,
      yesterdayRank,
      currentRank,
      rankDelta
    };
    enrichedMember.movementType = resolveMovementType(enrichedMember);
    enrichedMember.isAnimated =
      member.tierYesterday !== member.tierCurrent ||
      currentRank !== yesterdayRank ||
      member.pointsCurrent !== member.pointsYesterday;
    enrichedMember.isPrimaryMover =
      member.tierYesterday !== member.tierCurrent ||
      member.pointsCurrent !== member.pointsYesterday ||
      enrichedMember.movementType === "up";
    membersByUser.set(member.username, enrichedMember);
  }

  const tiers = tierOrder
    .map((tierKey) => {
      const snapshot = tierSnapshots.get(tierKey);
      const usernames = new Set([
        ...snapshot.yesterdayMembers.map((member) => member.username),
        ...snapshot.currentMembers.map((member) => member.username)
      ]);

      return {
        tierKey,
        numericTier: parseTierNumber(tierKey),
        label: toRoman(parseTierNumber(tierKey)),
        members: [...usernames].map((username) => membersByUser.get(username)),
        yesterdayOrder: snapshot.yesterdayMembers.map((member) => member.username),
        entryOrder: [...usernames]
          .map((username) => membersByUser.get(username))
          .sort(compareCurrent)
          .map((member) => member.username),
        currentOrder: snapshot.currentMembers.map((member) => member.username),
        currentRankMap: snapshot.currentRankMap
      };
    })
    .filter((tier) => tier.members.length > 0);

  return { tiers, membersByUser };
}

function createTierCard(tier, rowsByUser) {
  const section = document.createElement("section");
  section.className = "tier-card";

  const header = document.createElement("div");
  header.className = "tier-header";

  const title = document.createElement("h2");
  title.className = "tier-title";
  title.textContent = `ТИР ${tier.label}`;
  header.append(title);

  const list = document.createElement("ol");
  list.className = "tier-list";

  for (const username of tier.yesterdayOrder) {
    const row = rowsByUser.get(username);
    if (row) {
      list.append(row);
    }
  }

  section.append(header, list);

  return {
    element: section,
    tierKey: tier.tierKey,
    header,
    list,
    entryOrder: tier.entryOrder,
    currentOrder: tier.currentOrder
  };
}

function createMemberRow(member, finalRank) {
  const row = document.createElement("li");
  row.className = "tier-row";
  row.dataset.userId = member.username;
  if (finalRank <= 3) {
    row.classList.add(`rank-${finalRank}`);
  }

  const score = document.createElement("div");
  score.className = "score-pill";

  const glyph = document.createElement("span");
  glyph.className = "score-glyph";
  glyph.textContent = "✦";

  const value = document.createElement("span");
  value.className = "score-value";
  value.textContent = String(member.pointsYesterday);

  score.append(glyph, value);

  const identity = document.createElement("div");
  identity.className = "identity-block";

  const username = document.createElement("span");
  username.className = "username";
  username.textContent = member.username;

  const badges = document.createElement("div");
  badges.className = "badge-row";

  if (finalRank <= 3) {
    const rankBadge = document.createElement("span");
    rankBadge.className = "rank-medal";
    rankBadge.textContent = getRankMedal(finalRank);
    badges.append(rankBadge);
  }

  identity.append(username);
  if (badges.childElementCount > 0) {
    identity.append(badges);
  }
  row.append(score, identity);
  return row;
}

function renderFinalSnapshot(boardState) {
  resetAnimationOverlay();

  for (const controller of boardState.controllers) {
    for (const username of controller.currentOrder) {
      const row = boardState.rowsByUser.get(username);
      if (row) {
        controller.list.append(row);
      }
    }
  }

  for (const [username, row] of boardState.rowsByUser.entries()) {
    const member = boardState.membersByUser.get(username);
    const scoreNode = row.querySelector(".score-value");
    scoreNode.textContent = String(member.pointsCurrent);
    row.style.transition = "";
    row.style.transform = "";
    row.style.opacity = "1";
  }
}

async function playTimelineAnimation(boardState, settings) {
  const renderer = createTimelineRenderer(boardState, settings);
  renderer.render(0);

  if (renderer.timeline.totalDurationMs <= 0) {
    return renderer.timeline;
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();

    const step = (timestamp) => {
      const elapsedMs = Math.min(timestamp - startedAt, renderer.timeline.totalDurationMs);
      renderer.render(elapsedMs);

      if (elapsedMs < renderer.timeline.totalDurationMs) {
        requestAnimationFrame(step);
      } else {
        resolve(renderer.timeline);
      }
    };

    requestAnimationFrame(step);
  });
}

function createTimelineRenderer(boardState, settings) {
  const overlay = ensureAnimationOverlay();
  const captureFrameRect = document.getElementById("capture-frame").getBoundingClientRect();
  const states = [];
  const tierStates = [];

  for (const [username, row] of boardState.rowsByUser.entries()) {
    const member = boardState.membersByUser.get(username);
    if (member.isAnimated) {
      row.classList.add("is-changing");
    }
    row.style.transition = "none";
    row.style.transformOrigin = "left center";
  }

  const firstRects = collectRects(boardState);
  const animatedStates = [];

  for (const [username, row] of boardState.rowsByUser.entries()) {
    const member = boardState.membersByUser.get(username);
    const scoreNode = row.querySelector(".score-value");
    const state = {
      member,
      row,
      scoreNode,
      firstTop: firstRects.get(username)?.top ?? 0,
      initialRect: null,
      finalRect: null,
      primaryEvent: null,
      transitions: []
    };
    if (member.isAnimated) {
      animatedStates.push(state);
    }
    states.push(state);
  }

  const scheduledStates = animatedStates
    .filter((state) => state.member.isPrimaryMover)
    .sort((left, right) => right.firstTop - left.firstTop || right.member.currentRank - left.member.currentRank);

  const timeline = buildTimelineMetrics(settings, scheduledStates.length);
  scheduledStates.forEach((state, index) => {
    state.startFrame = timeline.idleBeforeFrames + index * timeline.rowStaggerFrames;
  });

  const stageSnapshots = buildStageSnapshots(boardState, scheduledStates);
  const stageRects = measureStageRects(boardState, stageSnapshots);
  const tierHeaderStageRects = measureTierHeaderRects(boardState, stageSnapshots);
  applyStageSnapshot(boardState, stageSnapshots.at(-1));

  const primaryEventsByUser = new Map(
    scheduledStates.map((state) => [state.member.username, { startFrame: state.startFrame }])
  );

  for (const state of states) {
    state.initialRect = stageRects[0].get(state.member.username) ?? null;
    state.finalRect = stageRects.at(-1)?.get(state.member.username) ?? null;
    state.primaryEvent = primaryEventsByUser.get(state.member.username) ?? null;
    state.transitions = buildTransitionsForMember(
      state.member.username,
      scheduledStates,
      stageSnapshots,
      stageRects
    );

    for (const transition of state.transitions) {
      if (transition.kind !== "replace" && transition.kind !== "cross") {
        continue;
      }

      transition.ghost = createGhostRow(state.row, transition.prevRect, captureFrameRect, overlay);
      transition.ghostScoreNode = transition.ghost.querySelector(".score-value");
      if (transition.ghostScoreNode) {
        transition.ghostScoreNode.textContent = String(transition.prevState.points);
      }
    }
  }

  for (const controller of boardState.controllers) {
    controller.header.style.transition = "none";
    controller.header.style.transformOrigin = "left top";
    tierStates.push({
      element: controller.header,
      initialRect: tierHeaderStageRects[0].get(controller.tierKey) ?? null,
      finalRect: tierHeaderStageRects.at(-1)?.get(controller.tierKey) ?? null,
      transitions: buildTierHeaderTransitions(controller.tierKey, scheduledStates, tierHeaderStageRects)
    });
  }

  return {
    timeline,
    render(elapsedMs) {
      const frame = millisecondsToFrames(elapsedMs, timeline.fps);
      for (const state of states) {
        renderTimelineState(state, frame, timeline);
      }
      for (const tierState of tierStates) {
        renderTierHeaderState(tierState, frame, timeline);
      }
    }
  };
}

function collectRects(boardState) {
  const rects = new Map();
  for (const [username, row] of boardState.rowsByUser.entries()) {
    rects.set(username, copyRect(row.getBoundingClientRect()));
  }
  return rects;
}

function createGhostRow(sourceRow, rect, captureFrameRect, overlay) {
  const ghost = sourceRow.cloneNode(true);
  ghost.classList.add("tier-row-ghost");
  ghost.style.position = "absolute";
  ghost.style.top = `${rect.top - captureFrameRect.top}px`;
  ghost.style.left = `${rect.left - captureFrameRect.left}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.margin = "0";
  ghost.style.pointerEvents = "none";
  ghost.style.transformOrigin = "left center";
  overlay.append(ghost);
  return ghost;
}

function resolveMovementType(member) {
  if (member.numericTierCurrent > member.numericTierYesterday) {
    return "up";
  }
  if (member.numericTierCurrent < member.numericTierYesterday) {
    return "down";
  }
  if (member.rankDelta < 0) {
    return "up";
  }
  if (member.rankDelta > 0) {
    return "down";
  }
  return "steady";
}

function buildStageSnapshots(boardState, scheduledStates) {
  const completedUsers = new Set();
  const snapshots = [];

  for (let stageIndex = 0; stageIndex <= scheduledStates.length; stageIndex += 1) {
    snapshots.push(buildStageSnapshot(boardState, completedUsers));
    if (stageIndex < scheduledStates.length) {
      completedUsers.add(scheduledStates[stageIndex].member.username);
    }
  }

  return snapshots;
}

function buildStageSnapshot(boardState, completedUsers) {
  const activeMembers = [...boardState.membersByUser.values()].map((member) => {
    const isCompleted = completedUsers.has(member.username);
    return {
      member,
      username: member.username,
      tierKey: isCompleted ? member.tierCurrent : member.tierYesterday,
      points: isCompleted ? member.pointsCurrent : member.pointsYesterday
    };
  });

  const ordersByTier = new Map();
  const memberStatesByUser = new Map();

  for (const controller of boardState.controllers) {
    const orderedMembers = activeMembers
      .filter((entry) => entry.tierKey === controller.tierKey)
      .sort(compareStageMembers);

    ordersByTier.set(
      controller.tierKey,
      orderedMembers.map((entry) => entry.username)
    );

    orderedMembers.forEach((entry, index) => {
      memberStatesByUser.set(entry.username, {
        tierKey: entry.tierKey,
        points: entry.points,
        rank: index + 1
      });
    });
  }

  return {
    ordersByTier,
    memberStatesByUser
  };
}

function compareStageMembers(left, right) {
  return (
    right.points - left.points ||
    right.member.pointsCurrent - left.member.pointsCurrent ||
    right.member.pointsYesterday - left.member.pointsYesterday ||
    left.member.originalIndex - right.member.originalIndex
  );
}

function measureStageRects(boardState, stageSnapshots) {
  return stageSnapshots.map((snapshot) => {
    applyStageSnapshot(boardState, snapshot);
    return collectRects(boardState);
  });
}

function collectTierHeaderRects(boardState) {
  const rects = new Map();
  for (const controller of boardState.controllers) {
    rects.set(controller.tierKey, copyRect(controller.header.getBoundingClientRect()));
  }
  return rects;
}

function measureTierHeaderRects(boardState, stageSnapshots) {
  return stageSnapshots.map((snapshot) => {
    applyStageSnapshot(boardState, snapshot);
    return collectTierHeaderRects(boardState);
  });
}

function applyStageSnapshot(boardState, snapshot) {
  for (const controller of boardState.controllers) {
    const order = snapshot.ordersByTier.get(controller.tierKey) ?? [];
    for (const username of order) {
      const row = boardState.rowsByUser.get(username);
      if (row) {
        controller.list.append(row);
      }
    }
  }
}

function buildTransitionsForMember(username, scheduledStates, stageSnapshots, stageRects) {
  const transitions = [];

  for (let index = 0; index < scheduledStates.length; index += 1) {
    const prevState = stageSnapshots[index].memberStatesByUser.get(username);
    const nextState = stageSnapshots[index + 1].memberStatesByUser.get(username);
    const prevRect = stageRects[index].get(username) ?? null;
    const nextRect = stageRects[index + 1].get(username) ?? null;
    const kind = determineTransitionKind(prevState, nextState, prevRect, nextRect);

    if (!kind) {
      continue;
    }

    transitions.push({
      kind,
      startFrame: scheduledStates[index].startFrame,
      prevState,
      nextState,
      prevRect,
      nextRect,
      ghost: null,
      ghostScoreNode: null
    });
  }

  return transitions;
}

function buildTierHeaderTransitions(tierKey, scheduledStates, tierHeaderStageRects) {
  const transitions = [];

  for (let index = 0; index < scheduledStates.length; index += 1) {
    const prevRect = tierHeaderStageRects[index].get(tierKey) ?? null;
    const nextRect = tierHeaderStageRects[index + 1].get(tierKey) ?? null;

    if (!prevRect || !nextRect || areRectsEqual(prevRect, nextRect)) {
      continue;
    }

    transitions.push({
      startFrame: scheduledStates[index].startFrame,
      prevRect,
      nextRect
    });
  }

  return transitions;
}

function determineTransitionKind(prevState, nextState, prevRect, nextRect) {
  if (!prevState || !nextState || !prevRect || !nextRect) {
    return null;
  }

  if (prevState.tierKey !== nextState.tierKey) {
    return "cross";
  }

  if (areRectsEqual(prevRect, nextRect)) {
    return null;
  }

  if (nextRect.top < prevRect.top - 0.5 || Math.abs(nextRect.left - prevRect.left) > 0.5) {
    return "move";
  }

  if (nextRect.top > prevRect.top + 0.5) {
    return "replace";
  }

  return "move";
}

function buildTimelineMetrics(settings, animatedCount) {
  const idleBeforeFrames = millisecondsToFrames(settings.idle_before_ms, settings.fps);
  const idleAfterFrames = millisecondsToFrames(settings.idle_after_ms, settings.fps);
  const rowAnimationFrames = settings.row_animation_frames;
  const rowStaggerFrames = settings.row_stagger_frames;
  const animationFrames =
    animatedCount > 0
      ? rowAnimationFrames + rowStaggerFrames * Math.max(0, animatedCount - 1)
      : 0;
  const totalFrames = idleBeforeFrames + animationFrames + idleAfterFrames;

  return {
    fps: settings.fps,
    idleBeforeFrames,
    idleAfterFrames,
    rowAnimationFrames,
    rowStaggerFrames,
    animationFrames,
    totalFrames,
    totalDurationMs: framesToMilliseconds(totalFrames, settings.fps)
  };
}

function renderTimelineState(state, frame, timeline) {
  state.scoreNode.textContent = String(resolveDisplayedScore(state, frame, timeline));

  for (const transition of state.transitions) {
    hideTransitionGhost(transition);
  }

  let targetRect = state.initialRect ?? state.finalRect;
  let scale = 1;
  let opacity = 1;

  for (const transition of state.transitions) {
    const localFrame = frame - transition.startFrame;
    if (localFrame < 0) {
      break;
    }

    if (transition.kind === "move") {
      const progress =
        timeline.rowAnimationFrames === 0
          ? 1
          : clamp(localFrame / timeline.rowAnimationFrames, 0, 1);
      targetRect = interpolateRect(transition.prevRect, transition.nextRect, easeOutCubic(progress));
      scale = 1;
      opacity = 1;
      continue;
    }

    const replaceVisual = resolveReplaceVisual(localFrame, timeline.rowAnimationFrames);
    targetRect = transition.nextRect;
    scale = replaceVisual.scale;
    opacity = replaceVisual.opacity;
    applyTransitionGhost(transition, replaceVisual.ghostOpacity, replaceVisual.ghostScale);
  }

  if (!targetRect || !state.finalRect) {
    applyRowVisual(state.row, 0, 0, 1, 0);
    return;
  }

  applyRowVisual(
    state.row,
    targetRect.left - state.finalRect.left,
    targetRect.top - state.finalRect.top,
    scale,
    opacity
  );
}

function renderTierHeaderState(state, frame, timeline) {
  let targetRect = state.initialRect ?? state.finalRect;

  for (const transition of state.transitions) {
    const localFrame = frame - transition.startFrame;
    if (localFrame < 0) {
      break;
    }

    if (localFrame >= timeline.rowAnimationFrames) {
      targetRect = transition.nextRect;
      continue;
    }

    const progress =
      timeline.rowAnimationFrames === 0
        ? 1
        : clamp(localFrame / timeline.rowAnimationFrames, 0, 1);
    targetRect = interpolateRect(transition.prevRect, transition.nextRect, easeOutCubic(progress));
  }

  if (!targetRect || !state.finalRect) {
    applyRowVisual(state.element, 0, 0, 1, 1);
    return;
  }

  applyRowVisual(
    state.element,
    targetRect.left - state.finalRect.left,
    targetRect.top - state.finalRect.top,
    1,
    1
  );
}

function applyRowVisual(row, translateX, translateY, scale, opacity) {
  row.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  row.style.opacity = String(opacity);
}

function resolveDisplayedScore(state, frame, timeline) {
  if (!state.primaryEvent) {
    return state.member.pointsCurrent;
  }

  const localFrame = clamp(frame - state.primaryEvent.startFrame, 0, timeline.rowAnimationFrames);
  const progress =
    timeline.rowAnimationFrames === 0
      ? 1
      : clamp(localFrame / timeline.rowAnimationFrames, 0, 1);
  return interpolateScore(state.member.pointsYesterday, state.member.pointsCurrent, easeOutCubic(progress));
}

function resolveReplaceVisual(localFrame, durationFrames) {
  if (localFrame >= durationFrames) {
    return {
      ghostOpacity: 0,
      ghostScale: 0.8,
      opacity: 1,
      scale: 1
    };
  }

  const fadeOutFrames = Math.min(10, durationFrames);
  const revealStartFrame = Math.min(2, Math.max(0, durationFrames - 1));
  const revealFrames = Math.max(1, durationFrames - revealStartFrame);
  const oldProgress = clamp(localFrame / Math.max(1, fadeOutFrames), 0, 1);
  const newProgress = clamp((localFrame - revealStartFrame) / revealFrames, 0, 1);

  return {
    ghostOpacity: localFrame <= fadeOutFrames ? lerp(1, 0, easeOutCubic(oldProgress)) : 0,
    ghostScale: lerp(1, 0.8, easeOutCubic(oldProgress)),
    opacity: localFrame < revealStartFrame ? 0 : lerp(0, 1, easeOutCubic(newProgress)),
    scale: localFrame < revealStartFrame ? 0.8 : lerp(0.8, 1, easeOutCubic(newProgress))
  };
}

function applyTransitionGhost(transition, opacity, scale) {
  if (!transition.ghost) {
    return;
  }

  transition.ghost.style.opacity = String(opacity);
  transition.ghost.style.transform = `scale(${scale})`;
}

function hideTransitionGhost(transition) {
  if (!transition.ghost) {
    return;
  }

  transition.ghost.style.opacity = "0";
  transition.ghost.style.transform = "scale(0.8)";
}

function interpolateRect(fromRect, toRect, progress) {
  return {
    top: lerp(fromRect.top, toRect.top, progress),
    left: lerp(fromRect.left, toRect.left, progress),
    width: lerp(fromRect.width, toRect.width, progress),
    height: lerp(fromRect.height, toRect.height, progress)
  };
}

function areRectsEqual(left, right, epsilon = 0.5) {
  return (
    Math.abs(left.top - right.top) <= epsilon &&
    Math.abs(left.left - right.left) <= epsilon &&
    Math.abs(left.width - right.width) <= epsilon &&
    Math.abs(left.height - right.height) <= epsilon
  );
}

function copyRect(rect) {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height
  };
}

function ensureAnimationOverlay() {
  resetAnimationOverlay();
  const overlay = document.createElement("div");
  overlay.className = "animation-overlay";
  document.getElementById("capture-frame").append(overlay);
  return overlay;
}

function resetAnimationOverlay() {
  document.querySelector(".animation-overlay")?.remove();
}

function getTierEntries(config) {
  return buildBoardModel(config).tiers;
}

function getTimelineMetricsFromConfig(config) {
  const boardModel = buildBoardModel(config);
  const scheduledCount = [...boardModel.membersByUser.values()]
    .filter((member) => member.isAnimated && member.isPrimaryMover)
    .length;
  return buildTimelineMetrics(config.settings, scheduledCount);
}

function buildTimelineLabel(metrics) {
  return `старт ${formatSeconds(framesToMilliseconds(metrics.idleBeforeFrames, metrics.fps))} c · анимация ${formatSeconds(framesToMilliseconds(metrics.animationFrames, metrics.fps))} c · финал ${formatSeconds(framesToMilliseconds(metrics.idleAfterFrames, metrics.fps))} c`;
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - progress, 3);
}

function interpolateScore(from, to, progress) {
  return Math.round(from + (to - from) * progress);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from, to, progress) {
  return from + (to - from) * progress;
}

function millisecondsToFrames(milliseconds, fps) {
  return Math.round(milliseconds * fps / 1000);
}

function framesToMilliseconds(frames, fps) {
  return frames * 1000 / fps;
}

function compareYesterday(left, right) {
  return (
    right.pointsYesterday - left.pointsYesterday ||
    right.pointsCurrent - left.pointsCurrent ||
    left.originalIndex - right.originalIndex
  );
}

function compareCurrent(left, right) {
  return (
    right.pointsCurrent - left.pointsCurrent ||
    right.pointsYesterday - left.pointsYesterday ||
    left.originalIndex - right.originalIndex
  );
}

function collectLayoutMetrics() {
  if (window.__LEADERBOARD_APP__?.measuredMetrics) {
    return window.__LEADERBOARD_APP__.measuredMetrics;
  }

  const frame = document.getElementById("capture-frame");
  const pageShell = document.querySelector(".page-shell");
  const frameRect = frame.getBoundingClientRect();
  const shellRect = pageShell.getBoundingClientRect();
  const width = Math.ceil(Math.max(frameRect.width, shellRect.right, document.documentElement.scrollWidth));
  const height = Math.ceil(Math.max(frameRect.height, shellRect.bottom, document.documentElement.scrollHeight));
  return { width, height };
}

function parseTierNumber(tierKey) {
  const match = String(tierKey).match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function toRoman(value) {
  const numerals = [
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];
  let remainder = Math.max(1, value);
  let result = "";
  for (const [arabic, roman] of numerals) {
    while (remainder >= arabic) {
      result += roman;
      remainder -= arabic;
    }
  }
  return result;
}

function pluralizePlayers(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} игрок`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} игрока`;
  }
  return `${count} игроков`;
}

function formatDate(value, locale = "ru-RU") {
  if (!value) {
    return "Без даты";
  }
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatHeadlineDate(value, locale = "ru-RU") {
  if (!value) {
    return "сегодня";
  }
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long"
  }).format(date);
}

function formatSeconds(value) {
  return (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1);
}

function defaultHeadline(dateValue) {
  const date = formatHeadlineDate(dateValue);
  return `Таблица лидеров Игры в бисер на ${date}`;
}

function getRankMedal(rank) {
  if (rank === 1) {
    return "🥇";
  }
  if (rank === 2) {
    return "🥈";
  }
  if (rank === 3) {
    return "🥉";
  }
  return "";
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function humanizeConfigPath(value) {
  if (!value) {
    return "без источника";
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseIntegerParam(name) {
  const value = params.get(name);
  if (value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readOptionalParam(name) {
  const value = params.get(name);
  if (value === null || value.trim() === "") {
    return undefined;
  }
  return value;
}

function readPositiveInteger(...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return 2000;
}

function asNonEmptyString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function waitForFonts() {
  if (!document.fonts?.ready) {
    return Promise.resolve();
  }
  return document.fonts.ready;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function waitForPaint() {
  await nextFrame();
  await nextFrame();
}
