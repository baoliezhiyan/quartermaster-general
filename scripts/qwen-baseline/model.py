"""Single BF16 CUDA worker. UTF-8 JSONL over pipes, no network listener."""
import collections
import json
import importlib.metadata
import os
import sys
import threading
import time
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
PROCESS_STARTED = time.perf_counter()
REVISION = "15852e8c16360a2fea060d615a32b45270f8a8fc"
SEED = 20261105


def emit(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def main():
    import psutil
    import pynvml
    import torch
    import transformers
    import accelerate
    from transformers import AutoTokenizer, GenerationConfig, Qwen3_5ForConditionalGeneration
    from transformers.generation.streamers import BaseStreamer
    from transformers.models.qwen3_5 import modeling_qwen3_5

    kernels = {
        "gatedDelta": "fla" if modeling_qwen3_5.chunk_gated_delta_rule is not None else "torch",
        "causalConv1d": "extension" if modeling_qwen3_5.causal_conv1d_fn is not None else "torch",
    }
    if os.environ.get("QM_QWEN_KERNELS"):
        if kernels["gatedDelta"] != "fla":
            raise RuntimeError("FLA requested but unavailable")
        kernels.update({name: importlib.metadata.version(name) for name in
                        ("flash-linear-attention", "fla-core", "triton-windows", "einops")})
    if os.environ.get("QM_QWEN_FLA_CONV") == "1":
        if kernels["gatedDelta"] != "fla":
            raise RuntimeError("FLA convolution requires the FLA kernel environment")
        from fla.modules.conv import causal_conv1d

        def prefill_conv(x, weight, bias, activation, seq_idx=None):
            if seq_idx is not None:
                raise ValueError("Packed causal convolution inputs are unsupported")
            output, _ = causal_conv1d(x.transpose(1, 2), weight, bias, activation=activation)
            return output.transpose(1, 2)

        modeling_qwen3_5.causal_conv1d_fn = prefill_conv
        kernels["causalConv1d"] = "fla_triton_prefill"
    from contextlib import nullcontext

    attention = "sdpa"
    attention_context = nullcontext
    if os.environ.get("QM_QWEN_EFFICIENT_SDPA") == "1":
        from functools import partial
        from torch.nn.attention import SDPBackend, sdpa_kernel
        from transformers.integrations import sdpa_attention

        # Windows lacks the fused Flash GQA kernel in this Torch build. Transformers
        # already implements equivalent explicit KV repetition for the masked path.
        sdpa_attention.use_gqa_in_sdpa = lambda _mask, _key: False
        attention_context = partial(sdpa_kernel, SDPBackend.EFFICIENT_ATTENTION)
        attention = "sdpa_efficient_explicit_kv"
    telemetry = Path(sys.argv[2])

    model_dir = Path(sys.argv[1])
    manifest = json.loads((model_dir / "download-manifest.json").read_text(encoding="utf-8"))
    if (manifest["repo"], manifest["revision"], manifest["status"]) != (
        "Qwen/Qwen3.5-2B", REVISION, "downloaded_and_hash_verified"
    ):
        raise ValueError("Model manifest identity mismatch")
    for entry in manifest["files"]:
        if (model_dir / entry["rfilename"]).stat().st_size != entry["size"]:
            raise ValueError("Model file size mismatch: " + entry["rfilename"])

    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("CUDA BF16 unavailable; no automatic fallback")
    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)
    torch.backends.cuda.matmul.allow_tf32 = False
    pynvml.nvmlInit()
    gpu = pynvml.nvmlDeviceGetHandleByIndex(0)
    process = psutil.Process()

    class Memory:
        def __init__(self, stage, input_tokens=None):
            self.stage = stage
            self.input_tokens = input_tokens
            self.started = time.perf_counter()

        def __enter__(self):
            self.peaks = {}
            self.stop = threading.Event()
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()
            return self

        def sample(self):
            values = {
                "wholeGpuUsedBytes": pynvml.nvmlDeviceGetMemoryInfo(gpu).used,
                "processRssBytes": process.memory_info().rss,
                "systemUsedBytes": psutil.virtual_memory().used,
            }
            for name, value in values.items():
                self.peaks[name] = max(self.peaks.get(name, 0), value)

        def run(self):
            last_write = 0.0
            while not self.stop.is_set():
                self.sample()
                now = time.perf_counter()
                if now - last_write >= 1.0:
                    snapshot = {
                        "stage": self.stage, "inputTokens": self.input_tokens,
                        "seconds": now - self.started, **self.peaks,
                        "cudaAllocatedBytes": torch.cuda.max_memory_allocated(),
                        "cudaReservedBytes": torch.cuda.max_memory_reserved(),
                    }
                    with telemetry.open("a", encoding="utf-8") as handle:
                        handle.write(json.dumps(snapshot) + "\n")
                    last_write = now
                self.stop.wait(0.05)

        def __exit__(self, *_):
            self.stop.set()
            self.thread.join()
            self.sample()
            self.peaks.update(
                cudaAllocatedBytes=torch.cuda.max_memory_allocated(),
                cudaReservedBytes=torch.cuda.max_memory_reserved(),
            )

    class FirstToken(BaseStreamer):
        def __init__(self):
            self.is_prompt = True
            self.at = None

        def put(self, _):
            if self.is_prompt:
                self.is_prompt = False
            elif self.at is None:
                self.at = time.perf_counter()

        def end(self):
            pass

    initial_gpu = pynvml.nvmlDeviceGetMemoryInfo(gpu)
    load_started = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    with Memory("load") as load_memory:
        tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
        tokenizer.chat_template = (model_dir / "chat_template.jinja").read_text(encoding="utf-8")
        model, load_info = Qwen3_5ForConditionalGeneration.from_pretrained(
            model_dir, dtype=torch.bfloat16, device_map={"": "cuda:0"},
            local_files_only=True, attn_implementation="sdpa", output_loading_info=True,
        )
        model.eval()
        if any(t.device.type != "cuda" for t in model.parameters()):
            raise RuntimeError("Unexpected non-GPU model parameter")
        if load_info.get("missing_keys") or load_info.get("mismatched_keys"):
            raise RuntimeError("Incomplete checkpoint load: " + str(load_info))
        torch.cuda.synchronize()
    weights = collections.Counter()
    for name, tensor in model.named_parameters():
        component = "vision" if name.startswith("model.visual.") else "text"
        weights[(component, str(tensor.dtype))] += tensor.numel() * tensor.element_size()
    emit({
        "ok": True, "kind": "ready", "revision": REVISION,
        "python": sys.version.split()[0], "torch": torch.__version__, "cuda": torch.version.cuda,
        "transformers": transformers.__version__, "accelerate": accelerate.__version__,
        "modelLoadSeconds": time.perf_counter() - load_started,
        "coldWorkerSeconds": time.perf_counter() - PROCESS_STARTED,
        "device": torch.cuda.get_device_name(), "driver": pynvml.nvmlSystemGetDriverVersion(),
        "gpuTotalBytes": initial_gpu.total, "initialGpuUsedBytes": initial_gpu.used,
        "loadPeaks": load_memory.peaks, "weightBytes": {"/".join(k): v for k, v in weights.items()},
        "kernels": kernels, "loadInfo": {key: sorted(value) if isinstance(value, set) else value for key, value in load_info.items()}, "seed": SEED, "precision": "BF16 CUDA; native FP32 parameters as measured",
        "generation": {"do_sample": False, "num_beams": 1, "use_cache": True,
                       "prefix_cache": False, "thinking": False, "max_new_tokens": 128,
                       "attention": attention, "device_map": {"": "cuda:0"}},
    })
    for line in sys.stdin:
        input_tokens = None
        started = time.perf_counter()
        try:
            request = json.loads(line)
            encoded = tokenizer.apply_chat_template(
                request["messages"], tokenize=True, add_generation_prompt=True,
                enable_thinking=False, return_dict=True, return_tensors="pt", truncation=False,
            )
            input_tokens = encoded["input_ids"].shape[-1]
            if request.get("op") == "length":
                emit({"ok": True, "inputTokens": input_tokens})
                continue
            max_new_tokens = 128
            if input_tokens + max_new_tokens > model.config.text_config.max_position_embeddings:
                raise RuntimeError("context_limit: " + str(input_tokens))
            config = GenerationConfig(
                max_new_tokens=max_new_tokens, do_sample=False, num_beams=1,
                use_cache=True, repetition_penalty=1.0, return_dict_in_generate=False,
                eos_token_id=model.generation_config.eos_token_id,
                pad_token_id=tokenizer.pad_token_id, bos_token_id=model.generation_config.bos_token_id,
            )
            streamer = FirstToken()
            torch.cuda.reset_peak_memory_stats()
            with Memory("generate", input_tokens) as memory, torch.inference_mode():
                encoded = encoded.to("cuda:0")
                torch.cuda.synchronize()
                generation_started = time.perf_counter()
                with attention_context():
                    result = model.generate(**encoded, generation_config=config, streamer=streamer)
                torch.cuda.synchronize()
                generation_ended = time.perf_counter()
                tokens = result[0, input_tokens:].tolist()
                output = tokenizer.decode(tokens, skip_special_tokens=True)
            emit({"ok": True, "text": output, "inputTokens": input_tokens, "outputTokens": len(tokens),
                  "seconds": time.perf_counter() - started,
                  "generationSeconds": generation_ended - generation_started,
                  "firstTokenSeconds": None if streamer.at is None else streamer.at - generation_started,
                  "memory": memory.peaks, "hitOutputLimit": len(tokens) >= max_new_tokens})
            del encoded, result
        except Exception as error:
            emit({"ok": False, "error": str(error), "type": type(error).__name__,
                  "inputTokens": input_tokens, "seconds": time.perf_counter() - started,
                  "cudaAllocatedBytes": torch.cuda.max_memory_allocated(),
                  "cudaReservedBytes": torch.cuda.max_memory_reserved()})
            # Leave a failed worker with its original error and resource report.
            break


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit({"ok": False, "kind": "startup", "error": str(exc), "type": type(exc).__name__})
        raise
