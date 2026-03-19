from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path
from urllib.parse import urlencode

from .cli import REPO_ROOT
from .server import ProjectHTTPServer


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve a local preview page for styling and animation tweaks."
    )
    parser.add_argument(
        "--input",
        default="data/example-input.json",
        help="Path to the JSON file used by the preview page.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host for the local preview server.")
    parser.add_argument("--port", type=int, default=4173, help="Port for the local preview server.")
    parser.add_argument("--headline", help="Optional headline override for the preview page.")
    parser.add_argument("--subtitle", help="Optional subtitle override for the preview page.")
    parser.add_argument(
        "--fps",
        type=int,
        default=60,
        help="Frame rate used by the preview timeline calculations.",
    )
    parser.add_argument(
        "--idle-before-ms",
        type=int,
        default=1000,
        help="How long to keep the initial static state before animation.",
    )
    parser.add_argument(
        "--idle-after-ms",
        type=int,
        default=1000,
        help="How long to keep the final static state after animation.",
    )
    parser.add_argument(
        "--row-animation-frames",
        type=int,
        default=26,
        help="How many frames a single row animation lasts.",
    )
    parser.add_argument(
        "--row-stagger-frames",
        type=int,
        default=10,
        help="How many frames to delay the next row animation.",
    )
    parser.add_argument(
        "--no-autostart",
        action="store_true",
        help="Do not autoplay the animation on page load.",
    )
    return parser.parse_args(argv)


def resolve_preview_source(raw_path: str) -> tuple[Path, str, bool]:
    input_path = Path(raw_path).expanduser()
    if not input_path.is_absolute():
        input_path = (REPO_ROOT / input_path).resolve()

    if not input_path.exists():
        raise RuntimeError(f"Preview JSON file was not found: {input_path}")

    if input_path.is_relative_to(REPO_ROOT):
        return input_path, "/" + input_path.relative_to(REPO_ROOT).as_posix(), False

    preview_dir = REPO_ROOT / "runtime" / "preview"
    preview_dir.mkdir(parents=True, exist_ok=True)
    copied_input = preview_dir / "external-preview-input.json"
    shutil.copy2(input_path, copied_input)
    return input_path, "/" + copied_input.relative_to(REPO_ROOT).as_posix(), True


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    source_path, served_path, copied = resolve_preview_source(args.input)

    query: dict[str, str] = {
      "config": served_path,
      "mode": "preview",
      "fps": str(args.fps),
      "idle-before-ms": str(args.idle_before_ms),
      "idle-after-ms": str(args.idle_after_ms),
      "row-animation-frames": str(args.row_animation_frames),
      "row-stagger-frames": str(args.row_stagger_frames),
      "autostart": "0" if args.no_autostart else "1",
    }
    if args.headline:
        query["headline"] = args.headline
    if args.subtitle:
        query["subtitle"] = args.subtitle

    with ProjectHTTPServer(REPO_ROOT, host=args.host, port=args.port) as server:
        url = f"http://{args.host}:{server.port}/web/index.html?{urlencode(query)}"
        print(f"Preview ready: {url}", flush=True)
        print("Edit web/styles.css or web/app.js, then reload the page.", flush=True)
        if copied:
            print(
                "Input JSON was copied into runtime/preview because the source file is outside the repo.",
                flush=True,
            )
            print("To pick up JSON changes from the original file, restart the preview command.", flush=True)
        else:
            print(
                f"Source JSON reloads from disk on refresh: {source_path}",
                flush=True,
            )
        print("Press Ctrl+C to stop the preview server.", flush=True)

        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            print("\nPreview server stopped.", flush=True)
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
