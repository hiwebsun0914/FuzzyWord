import argparse
import os
import sys
import traceback


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def looks_like_model_dir(path: str) -> bool:
    if not path or not os.path.isdir(path):
        return False
    return os.path.isfile(os.path.join(path, "config.json")) and (
        os.path.isfile(os.path.join(path, "tokenizer.json"))
        or os.path.isfile(os.path.join(path, "vocab.json"))
    )


def main():
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    default_out = os.path.join("models", "Qwen3-1.7B")

    parser = argparse.ArgumentParser(
        description="Download Qwen model from Hugging Face Hub to a local directory."
    )
    parser.add_argument("--repo", default="Qwen/Qwen3-1.7B", help="HF repo id")
    parser.add_argument(
        "--out",
        default=default_out,
        help="Local model directory (relative to project root by default)",
    )
    parser.add_argument(
        "--revision", default=None, help="Optional git revision (tag/commit)"
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=8,
        help="Download concurrency (huggingface_hub max_workers)",
    )
    args = parser.parse_args()

    out_dir = (
        os.path.abspath(args.out)
        if os.path.isabs(args.out)
        else os.path.abspath(os.path.join(project_root, args.out))
    )

    # Keep HF cache inside this project unless user overrides.
    os.environ.setdefault("HF_HOME", os.path.join(project_root, ".hf"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    if looks_like_model_dir(out_dir):
        print(f"OK: model already exists at {out_dir}", flush=True)
        return

    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except ModuleNotFoundError:
        eprint("缺少依赖：huggingface_hub")
        eprint("解决：python -m pip install -U huggingface_hub")
        sys.exit(2)

    ensure_dir(out_dir)

    print(f"Downloading {args.repo} -> {out_dir}", flush=True)
    if os.environ.get("HF_TOKEN"):
        print("HF_TOKEN detected (authenticated download).", flush=True)

    try:
        snapshot_download(
            repo_id=args.repo,
            local_dir=out_dir,
            local_dir_use_symlinks=False,
            revision=args.revision,
            max_workers=args.max_workers,
            resume_download=True,
        )
        print(f"OK: downloaded to {out_dir}", flush=True)
    except Exception:
        eprint("Download failed.")
        eprint(traceback.format_exc())
        sys.exit(3)


if __name__ == "__main__":
    main()
