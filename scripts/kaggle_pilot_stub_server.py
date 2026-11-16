"""Serve the notebook's Flask worker on CPU, with the model stubbed.

Runs the real code from scripts/direk_kaggle_pilot.ipynb (persona, helpers, Flask
routes) but replaces torch/transformers with stubs, so the HTTP contract can be
tested without a GPU or a model download. The stub picks a reply by looking at
the prompt, so script, bible and scenes each come back in their real shape.

Usage: python3 scripts/kaggle_pilot_stub_server.py [port]
"""
import json
import pathlib
import sys
import types

NOTEBOOK = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "direk_kaggle_pilot.ipynb"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8077

SCENES = {
    "scenes": [
        {"heading": "SCENE 1", "narration": "Narration one.", "visual": "Wide shot.", "mood": "grim"},
        {"heading": "SCENE 2", "narration": "Narration two.", "visual": "Close up.", "mood": "warm"},
        {"heading": "SCENE 3", "narration": "Narration three.", "visual": "Aerial.", "mood": "hopeful"},
    ]
}


def worker_source() -> str:
    nb = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    code = ["".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code"]
    # Cells 2-5: config/persona, model load, helpers, Flask worker.
    return "\n\n".join(code[1:5])


def install_stubs(namespace: dict) -> None:
    last_prompt = {"text": ""}

    class _NoGrad:
        def __enter__(self):
            return None

        def __exit__(self, *exc):
            return False

    class _FakeModel:
        device = "cpu"

        def parameters(self):
            return iter([types.SimpleNamespace(device="cpu")])

        def eval(self):
            return self

        def generate(self, **kwargs):
            return [[0] * 5 + [1, 2, 3]]

    class _Batch(dict):
        """Mimic a HuggingFace BatchEncoding: has .to() and subscript access."""

        def to(self, _device):
            return self

    class _FakeTokenizer:
        def apply_chat_template(self, msgs, tokenize=False, add_generation_prompt=True):
            return json.dumps(msgs, ensure_ascii=False)

        def __call__(self, text, return_tensors=None):
            last_prompt["text"] = text
            return _Batch({"input_ids": types.SimpleNamespace(shape=(1, 5))})

        def decode(self, ids, skip_special_tokens=True):
            prompt = last_prompt["text"].lower()
            if "isulat ang character bible" in prompt:
                return "Ramon — mangingisda, 40s, baritonong boses."
            if "scenes" in prompt:
                return "```json\n" + json.dumps(SCENES, ensure_ascii=False) + "\n```"
            return "PAMAGAT: Ang Mangingisda.\n\nSCENE 1: ang simula."

    torch = types.ModuleType("torch")
    torch.no_grad = lambda: _NoGrad()
    torch.float16 = "float16"
    torch.cuda = types.SimpleNamespace(device_count=lambda: 0)

    transformers = types.ModuleType("transformers")
    transformers.AutoTokenizer = types.SimpleNamespace(from_pretrained=lambda _id: _FakeTokenizer())
    transformers.AutoModelForCausalLM = types.SimpleNamespace(from_pretrained=lambda _id, **kw: _FakeModel())

    namespace["torch"] = torch
    namespace["transformers"] = transformers


def main() -> None:
    namespace: dict = {"__name__": "__main__"}
    install_stubs(namespace)
    # `import torch` reads sys.modules, not the exec globals, so register there too.
    sys.modules["torch"] = namespace["torch"]
    sys.modules["transformers"] = namespace["transformers"]
    prelude = "import torch\nfrom transformers import AutoTokenizer, AutoModelForCausalLM\n"
    exec(compile(prelude + worker_source(), str(NOTEBOOK), "exec"), namespace)
    print(f"stub worker ready on port {PORT}", flush=True)
    # The worker thread is a daemon; keep the process alive so it can serve.
    import time
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
