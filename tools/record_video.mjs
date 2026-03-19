import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

const { values } = parseArgs({
  options: {
    "page-url": { type: "string" },
    "record-dir": { type: "string" },
    "max-width": { type: "string", default: "1920" },
    "max-height": { type: "string", default: "2160" }
  }
});

const pageUrl = values["page-url"];
const recordDir = values["record-dir"];
const maxWidth = Number(values["max-width"]);
const maxHeight = Number(values["max-height"]);

if (!pageUrl || !recordDir) {
  throw new Error("Both --page-url and --record-dir are required.");
}

const browser = await chromium.launch({
  headless: true,
  args: ["--hide-scrollbars"]
});

try {
  await mkdir(recordDir, { recursive: true });

  const measurement = await measurePage(browser, pageUrl);
  const capture = buildCaptureViewport(measurement, maxWidth, maxHeight);
  const result = await captureFrames(browser, pageUrl, recordDir, capture);

  process.stdout.write(
    JSON.stringify({
      frames_dir: result.framesDir,
      fps: result.timeline.fps,
      total_frames: result.timeline.totalFrames,
      frame_count: result.frameCount,
      natural_size: measurement,
      viewport: capture.viewport,
      scale: capture.scale
    })
  );
} finally {
  await browser.close();
}

async function measurePage(browserInstance, url) {
  const context = await browserInstance.newContext({
    viewport: { width: 1800, height: 1400 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  try {
    await page.goto(withQuery(url, { mode: "measure" }), { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => window.__LEADERBOARD_APP__?.ready === true,
      undefined,
      { timeout: 15000 }
    );
    const metrics = await page.evaluate(() => window.__LEADERBOARD_APP__.collectLayoutMetrics());
    return {
      width: Math.max(640, Math.ceil(Number(metrics?.width ?? 0))),
      height: Math.max(480, Math.ceil(Number(metrics?.height ?? 0)))
    };
  } finally {
    await context.close();
  }
}

function buildCaptureViewport(measurement, widthLimit, heightLimit) {
  const widthScale = widthLimit / measurement.width;
  const heightScale = heightLimit / measurement.height;
  const scale = Math.min(1, widthScale, heightScale);

  return {
    scale,
    natural: measurement,
    viewport: {
      width: even(Math.max(640, Math.floor(measurement.width * scale))),
      height: even(Math.max(480, Math.floor(measurement.height * scale)))
    }
  };
}

async function captureFrames(browserInstance, url, outputDir, capture) {
  const framesDir = path.resolve(outputDir, "frames");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const frameUrl = withQuery(url, {
    mode: "frames",
    scale: capture.scale.toFixed(6),
    "natural-width": String(capture.natural.width),
    "natural-height": String(capture.natural.height)
  });

  const context = await browserInstance.newContext({
    viewport: capture.viewport,
    deviceScaleFactor: 1
  });
  const page = await context.newPage();

  try {
    await page.goto(frameUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => window.__LEADERBOARD_APP__?.ready === true,
      undefined,
      { timeout: 15000 }
    );
    const timeline = await page.evaluate(() => window.__LEADERBOARD_APP__.timeline);
    if (!timeline || !timeline.fps || !timeline.totalFrames) {
      throw new Error("Page did not expose timeline metadata for frame capture.");
    }
    const frameCount = Math.max(1, Number(timeline.totalFrames));

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const timelineMs = frameIndex * 1000 / Number(timeline.fps);
      await page.evaluate((elapsedMs) => window.__LEADERBOARD_APP__.renderFrame(elapsedMs), timelineMs);
      await page.screenshot({
        path: path.join(framesDir, frameFileName(frameIndex)),
        type: "png"
      });
    }

    return {
      framesDir,
      frameCount,
      timeline: {
        fps: Number(timeline.fps),
        totalFrames: Number(timeline.totalFrames)
      }
    };
  } finally {
    await context.close();
  }
}

function frameFileName(index) {
  return `frame-${String(index).padStart(6, "0")}.png`;
}

function withQuery(url, additions) {
  const nextUrl = new URL(url);
  for (const [key, value] of Object.entries(additions)) {
    nextUrl.searchParams.set(key, value);
  }
  return nextUrl.toString();
}

function even(value) {
  return value % 2 === 0 ? value : value + 1;
}
