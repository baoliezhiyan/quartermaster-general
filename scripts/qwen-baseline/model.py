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
    telemetry = Path(sys.argv[2])
    request_id = None
    def event(kind, **fields):
        with telemetry.with_name("worker-events.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"event": kind, "pid": os.getpid(), "requestId": request_id,
                                     "workerSeconds": time.perf_counter() - PROCESS_STARTED, **fields}) + "\n")

    event("imports_start")
    import psutil
    event("platform_imported", systemAvailableBytes=psutil.virtual_memory().available)
    import pynvml
    import torch
    event("torch_imported", processRssBytes=psutil.Process().memory_info().rss, systemAvailableBytes=psutil.virtual_memory().available)
    import transformers
    import accelerate
    from transformers import AutoTokenizer, GenerationConfig, Qwen3_5Config, Qwen3_5ForCausalLM, Qwen3_5ForConditionalGeneration
    from transformers.generation.streamers import BaseStreamer
    from transformers.models.qwen3_5 import modeling_qwen3_5

    event("imports_end", processRssBytes=psutil.Process().memory_info().rss,
          systemAvailableBytes=psutil.virtual_memory().available)
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
    memory_policy = os.environ.get("QM_QWEN_MEMORY_POLICY", "pressure")
    if memory_policy not in {"pressure", "observe"}:
        raise ValueError("Unsupported CUDA memory policy")
    if os.environ.get("QM_QWEN_KERNELS"):
        from triton import knobs

        def compile_finished(*, src, metadata, metadata_group, times, cache_hit):
            event("triton_compile", kernel=src.name, cacheHit=cache_hit, compilerSeconds=times.total / 1e6)

        knobs.compilation.listener = compile_finished

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

    def memory_now(process_gpu=False):
        cuda = torch.cuda.memory_stats()
        vm = psutil.virtual_memory()
        result = {
            "cudaAllocatedBytes": cuda.get("allocated_bytes.all.current"),
            "cudaReservedBytes": cuda.get("reserved_bytes.all.current"),
            "cudaInactiveSplitBytes": cuda.get("inactive_split_bytes.all.current"),
            "cudaAllocationRetries": cuda.get("num_alloc_retries"),
            "cudaOoms": cuda.get("num_ooms"),
            "wholeGpuUsedBytes": pynvml.nvmlDeviceGetMemoryInfo(gpu).used,
            "processRssBytes": process.memory_info().rss,
            "systemUsedBytes": vm.used,
            "systemAvailableBytes": vm.available,
        }
        if process_gpu:
            used = []
            for query in (pynvml.nvmlDeviceGetComputeRunningProcesses, pynvml.nvmlDeviceGetGraphicsRunningProcesses):
                try:
                    used.extend(p.usedGpuMemory for p in query(gpu) if p.pid == os.getpid()
                                and isinstance(p.usedGpuMemory, int) and 0 <= p.usedGpuMemory <= initial_gpu.total)
                except pynvml.NVMLError:
                    pass
            result["processGpuUsedBytes"] = max(used, default=None)
        return result

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
                        "seconds": now - self.started, "pid": os.getpid(), "requestId": request_id,
                        **self.peaks, "current": memory_now(),
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
        def __init__(self, input_tokens):
            self.is_prompt = True
            self.at = None
            self.input_tokens = input_tokens
            self.generation_started = None

        def put(self, _):
            if self.is_prompt:
                self.is_prompt = False
            elif self.at is None:
                self.at = time.perf_counter()
                event("first_token", inputTokens=self.input_tokens, seconds=self.at - self.generation_started)
                with telemetry.with_name("first-tokens.jsonl").open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps({"inputTokens": self.input_tokens, "firstTokenSeconds": self.at - self.generation_started}) + "\n")

        def end(self):
            pass

    initial_gpu = pynvml.nvmlDeviceGetMemoryInfo(gpu)
    load_started = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    event("load_start", memory=memory_now())
    with Memory("load") as load_memory:
        tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
        tokenizer.chat_template = (model_dir / "chat_template.jinja").read_text(encoding="utf-8")
        text_only = os.environ.get("QM_QWEN_TEXT_ONLY") == "1"
        loader = Qwen3_5ForCausalLM if text_only else Qwen3_5ForConditionalGeneration
        text_options = ({
            "config": Qwen3_5Config.from_pretrained(model_dir, local_files_only=True).text_config,
            "key_mapping": {r"^model\.language_model\.": "model."},
        } if text_only else {})
        model, load_info = loader.from_pretrained(
            model_dir, dtype=torch.bfloat16, device_map={"": "cuda:0"},
            local_files_only=True, attn_implementation="sdpa", output_loading_info=True, **text_options,
        )
        model.eval()
        if any(t.device.type != "cuda" for t in model.parameters()):
            raise RuntimeError("Unexpected non-GPU model parameter")
        if any(load_info.get(key) for key in ("missing_keys", "mismatched_keys", "unexpected_keys", "error_msgs")):
            raise RuntimeError("Incomplete checkpoint load: " + str(load_info))
        torch.cuda.synchronize()
    event("load_end", memory=memory_now(True))
    weights = collections.Counter()
    for name, tensor in model.named_parameters():
        component = "vision" if name.startswith("model.visual.") else "text"
        weights[(component, str(tensor.dtype))] += tensor.numel() * tensor.element_size()
    emit({
        "ok": True, "kind": "ready", "revision": REVISION, "pid": os.getpid(),
        "python": sys.version.split()[0], "torch": torch.__version__, "cuda": torch.version.cuda,
        "transformers": transformers.__version__, "accelerate": accelerate.__version__,
        "modelLoadSeconds": time.perf_counter() - load_started,
        "coldWorkerSeconds": time.perf_counter() - PROCESS_STARTED,
        "device": torch.cuda.get_device_name(), "driver": pynvml.nvmlSystemGetDriverVersion(),
        "gpuTotalBytes": initial_gpu.total, "initialGpuUsedBytes": initial_gpu.used,
        "loadPeaks": load_memory.peaks, "weightBytes": {"/".join(k): v for k, v in weights.items()},
        "modelClass": type(model).__name__, "memoryPolicy": memory_policy, "kernels": kernels, "loadInfo": {key: sorted(value) if isinstance(value, set) else value for key, value in load_info.items()}, "seed": SEED, "precision": "BF16 CUDA; native FP32 parameters as measured",
        "generation": {"do_sample": False, "num_beams": 1, "use_cache": True,
                       "prefix_cache": False, "thinking": False, "max_new_tokens": 128,
                       "attention": attention, "device_map": {"": "cuda:0"}},
    })
    def generate(encoded, input_tokens, started):
        max_new_tokens = 128
        if input_tokens + max_new_tokens > model.config.get_text_config().max_position_embeddings:
            raise RuntimeError("context_limit: " + str(input_tokens))
        config = GenerationConfig(
            max_new_tokens=max_new_tokens, do_sample=False, num_beams=1,
            use_cache=True, repetition_penalty=1.0, return_dict_in_generate=False,
            eos_token_id=model.generation_config.eos_token_id,
            pad_token_id=tokenizer.pad_token_id, bos_token_id=model.generation_config.bos_token_id,
        )
        streamer = FirstToken(input_tokens)
        prefill_started = None
        prefill_returned = False

        def prefill_start(*_):
            nonlocal prefill_started
            if prefill_started is None:
                prefill_started = time.perf_counter()
                event("prefill_start")

        def prefill_end(*_):
            nonlocal prefill_returned
            if not prefill_returned:
                prefill_returned = True
                event("prefill_host_return", seconds=time.perf_counter() - prefill_started)

        pre_hook = model.register_forward_pre_hook(prefill_start)
        post_hook = model.register_forward_hook(prefill_end)
        torch.cuda.reset_peak_memory_stats()
        try:
            with Memory("generate", input_tokens) as memory, torch.inference_mode():
                encoded = encoded.to("cuda:0")
                torch.cuda.synchronize()
                streamer.generation_started = time.perf_counter()
                with attention_context():
                    result = model.generate(**encoded, generation_config=config, streamer=streamer)
                torch.cuda.synchronize()
                generation_ended = time.perf_counter()
                tokens = result[0, input_tokens:].tolist()
                output = tokenizer.decode(tokens, skip_special_tokens=True)
        finally:
            pre_hook.remove()
            post_hook.remove()
        # The generate frame owns input/output GPU tensors and all generation
        # temporaries. Only host data crosses this boundary.
        return {"ok": True, "text": output, "inputTokens": input_tokens, "outputTokens": len(tokens),
                "seconds": time.perf_counter() - started,
                "generationSeconds": generation_ended - streamer.generation_started,
                "firstTokenSeconds": None if streamer.at is None else streamer.at - streamer.generation_started,
                "memory": memory.peaks, "pid": os.getpid(), "hitOutputLimit": len(tokens) >= max_new_tokens}

    def release_for_growth(before, previous_tokens, input_tokens):
        # Measured stalls began below 0.6 GiB of physical headroom with >1 GiB
        # idle in the allocator. A margin helps before the next larger shape.
        mib = 1024 ** 2
        headroom = initial_gpu.total - before["wholeGpuUsedBytes"]
        releasable = before["cudaReservedBytes"] - before["cudaAllocatedBytes"] - before["cudaInactiveSplitBytes"]
        if (memory_policy != "pressure" or previous_tokens is None or input_tokens <= previous_tokens
                or headroom >= 768 * mib or releasable < 512 * mib):
            return None
        release_started = time.perf_counter()
        torch.cuda.empty_cache()
        release = {"reason": "growing_input_under_physical_pressure", "previousTokens": previous_tokens,
                   "inputTokens": input_tokens, "seconds": time.perf_counter() - release_started,
                   "before": before, "after": memory_now(True)}
        event("allocator_release", **release)
        return release

    previous_tokens = None
    for line in sys.stdin:
        input_tokens = None
        op = None
        request_id = None
        started = time.perf_counter()
        try:
            request = json.loads(line)
            request_id = request.get("requestId")
            op = request.get("op", "generate")
            encoded = tokenizer.apply_chat_template(
                request["messages"], tokenize=True, add_generation_prompt=True,
                enable_thinking=False, return_dict=True, return_tensors="pt", truncation=False,
            )
            input_tokens = encoded["input_ids"].shape[-1]
            if op == "length":
                emit({"ok": True, "inputTokens": input_tokens})
                continue
            if op == "compare":
                from equivalence import compare
                result = compare(model, encoded, tokenizer, attention_context)
                emit({"ok": True, **result, "seconds": time.perf_counter() - started})
                continue
            before = memory_now(True)
            event("request_start", inputTokens=input_tokens, memory=before)
            release = release_for_growth(before, previous_tokens, input_tokens)
            response = generate(encoded, input_tokens, started)
            after = memory_now(True)
            event("request_end", inputTokens=input_tokens, outputTokens=response["outputTokens"], memory=after)
            previous_tokens = input_tokens
            emit({**response, "requestId": request_id, "memoryBefore": before,
                  "memoryAfter": after, "allocatorRelease": release})
            continue
        except Exception as error:
            oom = isinstance(error, torch.cuda.OutOfMemoryError) and op == "generate"
            failure = {"ok": False, "error": str(error), "type": type(error).__name__,
                       "requestId": request_id, "pid": os.getpid(), "inputTokens": input_tokens,
                       "seconds": time.perf_counter() - started, "memoryAtFailure": memory_now(True)}
            # Do not let an exception traceback keep the failed generate frame
            # and its CUDA tensors alive while cleaning up the allocator.
            error.__traceback__ = None
        if oom:
            torch.cuda.empty_cache()
        failure["memoryAfter"] = memory_now(True)
        event("request_error", failure=failure)
        emit(failure)
        if not oom:
            break


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        emit({"ok": False, "kind": "startup", "error": str(exc), "type": type(exc).__name__})
        raise
