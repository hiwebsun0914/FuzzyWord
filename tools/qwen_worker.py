import json
import os
import sys
import traceback


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def load_model(model_path: str):
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
    except ModuleNotFoundError as ex:
        eprint("缺少 Python 依赖：transformers")
        eprint("解决：请在 Node 使用的同一个 Python 环境里安装依赖：")
        eprint("  python -m pip install -U -r requirements.txt")
        eprint("并安装 torch（按 CPU/CUDA 选择对应版本）。")
        raise ex

    try:
        import torch  # type: ignore
    except ModuleNotFoundError as ex:
        eprint("缺少 Python 依赖：torch")
        eprint("解决：请安装 torch（CPU 示例）：")
        eprint("  python -m pip install -U torch --index-url https://download.pytorch.org/whl/cpu")
        raise ex

    tokenizer = AutoTokenizer.from_pretrained(model_path)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype="auto",
        device_map="auto",
    )
    return tokenizer, model


def build_prompt(tokenizer, word: str) -> str:
    system = (
        "你是一个英语词汇学习助手。用户给出一个英文单词，你需要输出严格 JSON（不要输出其他文本）。\n"
        "要求：\n"
        "1) 用中文给出该词的学习提示（cn，简短）。\n"
        "2) 给出 6-12 个常用近义词（synonyms），每个条目包含 en/cn/note（note 可选）。\n"
        "3) 给出 4-10 个相关表达或常见搭配（related），每个条目包含 en/cn（cn 可选）。\n"
        "4) 给出 2-4 条例句（examples），包含 en/cn。\n"
        "输出 JSON 格式：\n"
        '{ "word": "...", "cn": "...", "synonyms": [{"en":"...","cn":"...","note":"..."}], '
        '"related": [{"en":"...","cn":"..."}], "examples": [{"en":"...","cn":"..."}] }\n'
    )
    user = f'单词："{word}"（只输出 JSON）'
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    # Qwen3 supports enable_thinking switch in chat template.
    try:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
    except TypeError:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )


def generate(tokenizer, model, word: str) -> str:
    import torch  # type: ignore

    prompt = build_prompt(tokenizer, word)
    inputs = tokenizer([prompt], return_tensors="pt").to(model.device)

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=512,
            do_sample=True,
            temperature=0.7,
            top_p=0.8,
            top_k=20,
            repetition_penalty=1.1,
        )

    gen = output_ids[0][inputs["input_ids"].shape[1] :]
    text = tokenizer.decode(gen, skip_special_tokens=True).strip()
    return text


def main():
    model_path = (os.environ.get("QWEN_MODEL_PATH") or "").strip()
    if not model_path:
        eprint("QWEN_MODEL_PATH is empty")
        sys.exit(2)

    try:
        tokenizer, model = load_model(model_path)
    except Exception:
        eprint("Failed to load model:", model_path)
        eprint(traceback.format_exc())
        sys.exit(3)

    # Notify Node worker is ready
    print(json.dumps({"type": "ready", "model_path": model_path}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            word = (req.get("word") or "").strip()
            if not req_id:
                continue
            if not word:
                print(json.dumps({"id": req_id, "ok": False, "error": "empty word"}), flush=True)
                continue

            text = generate(tokenizer, model, word)
            print(json.dumps({"id": req_id, "ok": True, "text": text}), flush=True)
        except Exception as ex:
            req_id = None
            try:
                req_id = json.loads(line).get("id")
            except Exception:
                pass
            err = f"{type(ex).__name__}: {ex}"
            eprint("Worker error:", err)
            eprint(traceback.format_exc())
            if req_id:
                print(json.dumps({"id": req_id, "ok": False, "error": err}), flush=True)


if __name__ == "__main__":
    main()
