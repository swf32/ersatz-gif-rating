from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from .server import ProjectHTTPServer

REPO_ROOT = Path(__file__).resolve().parent.parent


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render a local animated leaderboard into an MP4 video."
    )
    parser.add_argument("--input", required=True, help="Path to the input JSON file.")
    parser.add_argument(
        "--output-dir",
        default="out",
        help="Directory for the final MP4. Relative paths are resolved from the repo root.",
    )
    parser.add_argument("--headline", help="Custom page headline.")
    parser.add_argument("--subtitle", help="Custom page subtitle.")
    parser.add_argument(
        "--fps",
        type=int,
        default=60,
        help="Target frame rate for the exported MP4.",
    )
    parser.add_argument(
        "--idle-before-ms",
        type=int,
        default=1000,
        help="How long to keep the initial static state before row animations start.",
    )
    parser.add_argument(
        "--idle-after-ms",
        type=int,
        default=3000,
        help="How long to keep the final static state after all row animations finish.",
    )
    parser.add_argument(
        "--row-animation-frames",
        type=int,
        default=52,
        help="How many frames a single row animation lasts.",
    )
    parser.add_argument(
        "--row-stagger-frames",
        type=int,
        default=5,
        help="How many frames to wait after one row animation ends before starting the next.",
    )
    parser.add_argument(
        "--crf",
        type=int,
        default=24,
        help="CRF value passed to ffmpeg. Lower is better quality, larger is smaller size.",
    )
    parser.add_argument(
        "--preset",
        default="medium",
        help="ffmpeg x264 preset, for example ultrafast, medium or slow.",
    )
    parser.add_argument("--port", type=int, default=0, help="Local HTTP port. 0 picks a free port.")
    parser.add_argument(
        "--max-width",
        type=int,
        default=1920,
        help="Maximum viewport width for the recording pass.",
    )
    parser.add_argument(
        "--max-height",
        type=int,
        default=2160,
        help="Maximum viewport height for the recording pass.",
    )
    parser.add_argument(
        "--keep-artifacts",
        action="store_true",
        help="Keep runtime config and captured frame artifacts for debugging.",
    )
    return parser.parse_args(argv)


def ensure_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"Required binary '{name}' is not available in PATH.")


def load_json(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Input JSON file was not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise RuntimeError("Input JSON must be an object at the top level.")
    return raw


def normalize_payload(raw: dict[str, Any]) -> dict[str, Any]:
    tiers_raw = raw.get("tiers")
    if not isinstance(tiers_raw, dict):
        raise RuntimeError("Field 'tiers' must be an object.")

    gains_raw = raw.get("today_gains", [])
    if not isinstance(gains_raw, list):
        raise RuntimeError("Field 'today_gains' must be an array when present.")

    gain_lookup: dict[str, int] = {}
    normalized_gains: list[dict[str, Any]] = []
    for item in gains_raw:
        if not isinstance(item, dict):
            raise RuntimeError("Each element of 'today_gains' must be an object.")
        username = str(item.get("username", "")).strip()
        if not username:
            raise RuntimeError("Each 'today_gains' item must include a non-empty username.")
        gain = int(item.get("gain", 0))
        gain_lookup[username] = gain
        normalized_gains.append({"username": username, "gain": gain})

    normalized_tiers: dict[str, list[dict[str, Any]]] = {}
    seen_usernames: set[str] = set()
    for tier_key, entries in sorted(
        tiers_raw.items(),
        key=lambda item: extract_tier_number(item[0]),
        reverse=True,
    ):
        if not isinstance(entries, list):
            raise RuntimeError(f"Tier '{tier_key}' must contain an array of members.")
        normalized_entries: list[dict[str, Any]] = []
        for original_index, item in enumerate(entries):
            if not isinstance(item, dict):
                raise RuntimeError(f"Tier '{tier_key}' contains a non-object member.")
            username = str(item.get("username", "")).strip()
            if not username:
                raise RuntimeError(f"Tier '{tier_key}' contains a member without username.")
            if username in seen_usernames:
                raise RuntimeError(
                    f"Username '{username}' is duplicated in tiers. Use one record with tier_yesterday/tier_current."
                )
            seen_usernames.add(username)
            points_yesterday = int(item.get("points_yesterday", 0))
            points_current = int(item.get("points_current", 0))
            tier_yesterday = resolve_tier_reference(
                item.get("tier_yesterday"),
                item.get("previous_tier"),
                item.get("tier_from"),
                default=tier_key,
            )
            tier_current = resolve_tier_reference(
                item.get("tier_current"),
                item.get("current_tier"),
                item.get("tier_to"),
                default=tier_key,
            )
            normalized_entries.append(
                {
                    "username": username,
                    "points_yesterday": points_yesterday,
                    "points_current": points_current,
                    "gain": gain_lookup.get(username, points_current - points_yesterday),
                    "original_index": original_index,
                    "tier_yesterday": tier_yesterday,
                    "tier_current": tier_current,
                }
            )
        normalized_tiers[tier_key] = normalized_entries

    raw_date = raw.get("date")
    if raw_date is None:
        date_value = datetime.now().date().isoformat()
    else:
        date_value = str(raw_date)

    return {
        "date": date_value,
        "headline": raw.get("headline"),
        "subtitle": raw.get("subtitle"),
        "tiers": normalized_tiers,
        "today_gains": normalized_gains,
    }


def extract_tier_number(value: str) -> int:
    match = re.search(r"(\d+)", value)
    if not match:
        return -1
    return int(match.group(1))


def resolve_tier_reference(*candidates: Any, default: str) -> str:
    for candidate in candidates:
        if candidate is None:
            continue
        value = str(candidate).strip()
        if value:
            return value
    return default


def default_headline(date_value: str) -> str:
    try:
        dt = datetime.strptime(date_value, "%Y-%m-%d")
    except ValueError:
        return "Таблица лидеров Игры в бисер"
    return f"Таблица лидеров Игры в бисер на {dt.day} {month_name_ru(dt.month)}"


def month_name_ru(month: int) -> str:
    month_names = {
        1: "января",
        2: "февраля",
        3: "марта",
        4: "апреля",
        5: "мая",
        6: "июня",
        7: "июля",
        8: "августа",
        9: "сентября",
        10: "октября",
        11: "ноября",
        12: "декабря",
    }
    return month_names.get(month, "")


def default_subtitle() -> str:
    return ""


def resolve_output_dir(raw_path: str) -> Path:
    output_dir = Path(raw_path).expanduser()
    if not output_dir.is_absolute():
        output_dir = REPO_ROOT / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir.resolve()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-")
    return slug or "render"


def build_job_paths(input_path: Path, output_dir: Path) -> tuple[str, Path, Path, Path, Path]:
    job_id = f"{datetime.now().strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    runtime_dir = REPO_ROOT / "runtime" / job_id
    record_dir = runtime_dir / "recording"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    record_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{slugify(input_path.stem)}-{job_id}.mp4"
    config_path = runtime_dir / "config.json"
    return job_id, runtime_dir, record_dir, output_path, config_path


def build_runtime_config(payload: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    headline = args.headline or payload.get("headline") or default_headline(payload["date"])
    subtitle = args.subtitle or payload.get("subtitle") or default_subtitle()
    return {
        "date": payload["date"],
        "headline": headline,
        "subtitle": subtitle,
        "tiers": payload["tiers"],
        "today_gains": payload["today_gains"],
        "settings": {
            "fps": args.fps,
            "idle_before_ms": args.idle_before_ms,
            "idle_after_ms": args.idle_after_ms,
            "row_animation_frames": args.row_animation_frames,
            "row_stagger_frames": args.row_stagger_frames,
            "locale": "ru-RU",
        },
    }


def run_command(command: list[str], error_message: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        stdout = result.stdout.strip()
        details = stderr or stdout or "no stderr output"
        raise RuntimeError(f"{error_message}: {details}")
    return result


def run_capture(
    page_url: str,
    record_dir: Path,
    max_width: int,
    max_height: int,
) -> tuple[Path, int]:
    command = [
        "node",
        str(REPO_ROOT / "tools" / "record_video.mjs"),
        "--page-url",
        page_url,
        "--record-dir",
        str(record_dir),
        "--max-width",
        str(max_width),
        "--max-height",
        str(max_height),
    ]
    result = run_command(command, "Playwright recording failed")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Playwright recording returned non-JSON output: {result.stdout.strip()}"
        ) from exc
    frames_dir = payload.get("frames_dir")
    actual_fps = int(payload.get("fps", 60))
    if not frames_dir:
        raise RuntimeError("Playwright recording did not return a frames directory.")
    return Path(str(frames_dir)).resolve(), actual_fps


def convert_to_mp4(
    frames_dir: Path,
    output_path: Path,
    crf: int,
    preset: str,
    fps: int,
) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-framerate",
        str(fps),
        "-start_number",
        "0",
        "-i",
        str(frames_dir / "frame-%06d.png"),
        "-an",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        preset,
        "-crf",
        str(crf),
        "-movflags",
        "+faststart",
        "-pix_fmt",
        "yuv420p",
        str(output_path),
    ]
    run_command(command, "ffmpeg conversion failed")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ensure_binary("node")
    ensure_binary("ffmpeg")

    input_path = Path(args.input).expanduser().resolve()
    output_dir = resolve_output_dir(args.output_dir)
    payload = normalize_payload(load_json(input_path))
    runtime_root = REPO_ROOT / "runtime"
    runtime_root.mkdir(parents=True, exist_ok=True)

    job_id, runtime_dir, record_dir, output_path, config_path = build_job_paths(input_path, output_dir)
    runtime_config = build_runtime_config(payload, args)
    config_path.write_text(
        json.dumps(runtime_config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    config_rel_path = "/" + config_path.relative_to(REPO_ROOT).as_posix()
    page_query = urlencode({"config": config_rel_path})

    try:
        with ProjectHTTPServer(REPO_ROOT, port=args.port) as server:
            page_url = f"http://127.0.0.1:{server.port}/web/index.html?{page_query}"
            frames_dir, actual_fps = run_capture(
                page_url=page_url,
                record_dir=record_dir,
                max_width=args.max_width,
                max_height=args.max_height,
            )
        convert_to_mp4(
            frames_dir,
            output_path,
            args.crf,
            args.preset,
            fps=actual_fps,
        )
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if not args.keep_artifacts:
        shutil.rmtree(runtime_dir, ignore_errors=True)

    print(str(output_path.resolve()))
    return 0
